import { EventEmitter } from 'node:events';
import { Types } from 'mongoose';
import { badRequest, forbidden, isDuplicateKey, notFound } from '../lib/errors.js';
import { excerpt, extractMentionIds, firstUrl, normalizeText } from '../lib/text.js';
import { Channel, type ChannelDoc } from '../models/channel.js';
import { Bookmark } from '../models/extras.js';
import { Membership, type MembershipDoc } from '../models/membership.js';
import { type LinkPreview, Message, type MessageDoc, REACTIONS } from '../models/message.js';
import { User } from '../models/user.js';
import type { RealtimeBus } from '../realtime/bus.js';
import { type ChannelService, isManager } from './channels.js';
import type { MessageDto, MessagePage, ThreadDto } from './dto.js';
import type { FileService } from './files.js';
import { messageDto } from './serialize.js';

export interface SendInput {
  channelId: string;
  clientId?: string | undefined;
  text: string;
  replyToId?: string | undefined;
  attachmentIds?: string[] | undefined;
  /** Reply in the thread under this message instead of the main conversation. */
  threadRootId?: string | undefined;
  automated?: boolean;
  /** Set by the webhook service: posted by an integration. */
  webhook?: { id: Types.ObjectId; name: string };
  /** Set by the scheduler: a reminder about another message. */
  reminder?: { ref: NonNullable<MessageDoc['ref']> };
}

export interface MessageCreated {
  message: MessageDoc;
  channel: ChannelDoc;
}

/** Fetches a preview for a link, or null. Provided by LinkPreviewService. */
export type PreviewFetcher = (url: string) => Promise<Omit<LinkPreview, 'url'> | null>;

const MAX_PAGE = 100;
const MAX_THREAD = 500;
const MAX_EDITS = 20;
const THREAD_FACES = 5;

export class MessageService {
  /** Emits "created" after a message is saved (demo teammates and push notifications listen). */
  readonly events = new EventEmitter<{ created: [MessageCreated] }>();
  private fetchPreview: PreviewFetcher | null = null;

  constructor(
    private readonly bus: RealtimeBus,
    private readonly channels: ChannelService,
    private readonly files: FileService,
  ) {
    channels.onSystemMessage((actorId, channelId, text) => this.system(actorId, channelId, text));
  }

  /** Turns on link previews. */
  usePreviews(fetcher: PreviewFetcher): void {
    this.fetchPreview = fetcher;
  }

  dto(m: MessageDoc): MessageDto {
    return messageDto(m, this.files);
  }

  // ---- reading ----------------------------------------------------------------------

  /** The main timeline of a conversation. Thread replies live in their threads. */
  async page(
    userId: string,
    channelId: string,
    opts: {
      before?: string | undefined;
      after?: string | undefined;
      around?: string | undefined;
      limit?: number | undefined;
    },
  ): Promise<MessagePage> {
    const { channel } = await this.channels.access(userId, channelId);
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), MAX_PAGE);
    const base = { channelId: channel._id, threadRootId: null };

    const older = async (beforeId: Types.ObjectId | null, n: number, inclusive = false) => {
      const filter = beforeId ? { ...base, _id: { [inclusive ? '$lte' : '$lt']: beforeId } } : base;
      const rows = await Message.find(filter)
        .sort({ _id: -1 })
        .limit(n + 1)
        .lean<MessageDoc[]>();
      return { rows: rows.slice(0, n).toReversed(), more: rows.length > n };
    };
    const newer = async (afterId: Types.ObjectId, n: number) => {
      const rows = await Message.find({ ...base, _id: { $gt: afterId } })
        .sort({ _id: 1 })
        .limit(n + 1)
        .lean<MessageDoc[]>();
      return { rows: rows.slice(0, n), more: rows.length > n };
    };

    let rows: MessageDoc[];
    let hasMoreBefore = false;
    let hasMoreAfter = false;
    if (opts.after) {
      const r = await newer(new Types.ObjectId(opts.after), limit);
      rows = r.rows;
      hasMoreAfter = r.more;
    } else if (opts.around) {
      // Jumping to a search result: the message itself in the middle of its neighbours.
      const target = new Types.ObjectId(opts.around);
      const half = Math.floor(limit / 2);
      const [b, a] = await Promise.all([
        older(target, half + 1, true),
        newer(target, limit - half - 1),
      ]);
      rows = [...b.rows, ...a.rows];
      hasMoreBefore = b.more;
      hasMoreAfter = a.more;
    } else {
      const r = await older(opts.before ? new Types.ObjectId(opts.before) : null, limit);
      rows = r.rows;
      hasMoreBefore = r.more;
    }
    return { messages: rows.map((m) => this.dto(m)), hasMoreBefore, hasMoreAfter };
  }

  /** A message and every reply in its thread, oldest first. */
  async thread(userId: string, rootId: string): Promise<ThreadDto> {
    const root = await Message.findById(rootId).lean<MessageDoc>();
    if (!root || root.kind !== 'user' || root.threadRootId)
      throw notFound('That thread doesn’t exist.');
    await this.channels.access(userId, root.channelId.toString());
    const replies = await Message.find({ channelId: root.channelId, threadRootId: root._id })
      .sort({ _id: 1 })
      .limit(MAX_THREAD)
      .lean<MessageDoc[]>();
    return { root: this.dto(root), replies: replies.map((m) => this.dto(m)) };
  }

  /** Pinned messages in a conversation, most recently pinned first. */
  async pins(userId: string, channelId: string): Promise<MessageDto[]> {
    const { channel } = await this.channels.access(userId, channelId);
    const rows = await Message.find({
      channelId: channel._id,
      pinnedAt: { $type: 'date' },
      deletedAt: null,
    })
      .sort({ pinnedAt: -1 })
      .limit(100)
      .lean<MessageDoc[]>();
    return rows.map((m) => this.dto(m));
  }

  /** Every version of a message, oldest first, ending with the current one. */
  async history(userId: string, messageId: string) {
    const message = await this.visible(userId, messageId);
    if (message.deletedAt) throw notFound('That message was deleted.');
    return [
      ...(message.edits ?? []).map((e, i, all) => ({
        text: e.text,
        // A version was written when the one before it was replaced (or when the message was sent).
        writtenAt: (i === 0 ? message._id.getTimestamp() : all[i - 1]!.replacedAt).toISOString(),
        current: false,
      })),
      {
        text: message.text,
        writtenAt: (message.editedAt ?? message._id.getTimestamp()).toISOString(),
        current: true,
      },
    ];
  }

  // ---- sending ----------------------------------------------------------------------

  async send(
    userId: string,
    input: SendInput,
  ): Promise<{ message: MessageDto; duplicate: boolean }> {
    let channel: ChannelDoc;
    if (input.webhook) {
      const found = await Channel.findById(input.channelId).lean<ChannelDoc>();
      if (!found) throw notFound('That channel was deleted.');
      if (found.archivedAt) throw forbidden(`#${found.name} is archived.`);
      channel = found;
    } else {
      channel = (await this.channels.requirePoster(userId, input.channelId)).channel;
    }
    const author = new Types.ObjectId(userId);

    // A resend after a dropped connection: hand back what was already saved.
    if (input.clientId) {
      const existing = await Message.findOne({
        authorId: author,
        clientId: input.clientId,
      }).lean<MessageDoc>();
      if (existing) {
        if (!existing.channelId.equals(channel._id))
          throw badRequest('That message ID is already used.');
        return { message: this.dto(existing), duplicate: true };
      }
    }

    const text = normalizeText(input.text ?? '');
    const attachmentIds = input.attachmentIds ?? [];
    if (!text && attachmentIds.length === 0 && !input.reminder)
      throw badRequest('Write a message or attach a file.');

    const mentions = await this.validMentions(text);

    let threadRoot: MessageDoc | null = null;
    if (input.threadRootId) {
      threadRoot = await Message.findOne({
        _id: input.threadRootId,
        channelId: channel._id,
      }).lean<MessageDoc>();
      if (!threadRoot || threadRoot.kind !== 'user' || threadRoot.threadRootId) {
        throw badRequest('You can only reply in a thread under a message in this conversation.');
      }
      if (threadRoot.deletedAt && !threadRoot.thread?.replyCount)
        throw badRequest('That message was deleted.');
    }

    let replyTo: MessageDoc['replyTo'] = null;
    if (input.replyToId) {
      const original = await Message.findOne({
        _id: input.replyToId,
        channelId: channel._id,
      }).lean<MessageDoc>();
      if (!original || original.kind !== 'user') {
        throw badRequest('You can only reply to a message in the same conversation.');
      }
      replyTo = {
        messageId: original._id,
        authorId: original.authorId,
        excerpt: original.deletedAt
          ? ''
          : excerpt(original.text) ||
            (original.attachments[0] ? `📎 ${original.attachments[0].name}` : ''),
      };
    }

    const attachments = await this.files.claim(userId, attachmentIds, channel._id.toString());

    let saved: MessageDoc;
    try {
      saved = (
        await Message.create({
          channelId: channel._id,
          authorId: author,
          clientId: input.clientId ?? null,
          text,
          mentions,
          replyTo,
          attachments,
          automated: input.automated ?? false,
          threadRootId: threadRoot?._id ?? null,
          webhook: input.webhook ?? null,
          reminder: !!input.reminder,
          ref: input.reminder?.ref ?? null,
        })
      ).toObject();
    } catch (error) {
      // The same clientId arrived twice at the same moment: return the winner.
      if (isDuplicateKey(error) && input.clientId) {
        const existing = await Message.findOne({
          authorId: author,
          clientId: input.clientId,
        }).lean<MessageDoc>();
        if (existing) return { message: this.dto(existing), duplicate: true };
      }
      throw error;
    }

    if (!threadRoot) {
      await Channel.updateOne({ _id: channel._id }, { $set: { lastMessageAt: new Date() } });
      // Writing a message means you've read everything before it.
      if (!input.reminder && !input.webhook) {
        await Membership.updateOne(
          {
            channelId: channel._id,
            userId: author,
            $or: [{ lastReadId: null }, { lastReadId: { $lt: saved._id } }],
          },
          { $set: { lastReadId: saved._id } },
        );
      }
    }

    const dto = this.dto(saved);
    this.bus.toChannel(channel._id.toString(), 'message:new', dto);
    if (threadRoot) await this.bumpThread(threadRoot, saved);
    this.events.emit('created', { message: saved, channel });
    this.previewLater(saved);
    return { message: dto, duplicate: false };
  }

  /** Keeps the reply count and faces under a thread's first message up to date. */
  private async bumpThread(root: MessageDoc, reply: MessageDoc): Promise<void> {
    // Each step is one atomic update, so replies arriving together all count.
    await Message.updateOne(
      { _id: root._id, thread: null },
      { $set: { thread: { replyCount: 0, lastReplyAt: null, participantIds: [] } } },
    );
    await Message.updateOne(
      { _id: root._id },
      {
        $inc: { 'thread.replyCount': 1 },
        $max: { 'thread.lastReplyAt': reply._id.getTimestamp() },
      },
    );
    await Message.updateOne(
      { _id: root._id, [`thread.participantIds.${THREAD_FACES - 1}`]: { $exists: false } },
      { $addToSet: { 'thread.participantIds': reply.authorId } },
    );
    const updated = await Message.findById(root._id).lean<MessageDoc>();
    if (updated) this.bus.toChannel(updated.channelId.toString(), 'message:updated', this.dto(updated));
  }

  async edit(userId: string, messageId: string, rawText: string): Promise<MessageDto> {
    const message = await this.ownMessage(userId, messageId, 'edit');
    const text = normalizeText(rawText);
    if (!text && message.attachments.length === 0) {
      throw badRequest('A message can’t be empty. Delete it instead.');
    }
    if (text === message.text) return this.dto(message);
    const now = new Date();
    const keepPreview = message.linkPreview && firstUrl(text) === message.linkPreview.url;
    const updated = await Message.findOneAndUpdate(
      // Matching the old text means two quick edits can't record the same version twice.
      { _id: message._id, deletedAt: null, text: message.text },
      {
        $set: {
          text,
          mentions: await this.validMentions(text),
          editedAt: now,
          ...(keepPreview ? {} : { linkPreview: null }),
        },
        $push: { edits: { $each: [{ text: message.text, replacedAt: now }], $slice: -MAX_EDITS } },
      },
      { returnDocument: 'after' },
    ).lean<MessageDoc>();
    if (!updated) throw notFound('That message was deleted or changed. Try again.');
    const dto = this.dto(updated);
    this.bus.toChannel(updated.channelId.toString(), 'message:updated', dto);
    if (!keepPreview) this.previewLater(updated);
    return dto;
  }

  /**
   * Soft delete: the message keeps its place in the history as "This message was deleted".
   * Channel owners and admins can delete anyone's message.
   */
  async remove(userId: string, messageId: string): Promise<MessageDto> {
    const message = await Message.findById(messageId).lean<MessageDoc>();
    if (!message || message.kind !== 'user') throw notFound('That message doesn’t exist.');
    if (message.deletedAt) throw badRequest('That message was already deleted.');
    const { membership, channel } = await this.channels.requireMember(
      userId,
      message.channelId.toString(),
    );
    const own = message.authorId.equals(userId) && !message.webhook;
    if (!own && !(channel.kind !== 'dm' && isManager(membership))) {
      throw forbidden('You can only delete your own messages.');
    }
    const updated = await Message.findOneAndUpdate(
      { _id: message._id, deletedAt: null },
      {
        $set: {
          text: '',
          mentions: [],
          reactions: [],
          attachments: [],
          edits: [],
          linkPreview: null,
          pinnedAt: null,
          pinnedBy: null,
          deletedAt: new Date(),
        },
      },
      { returnDocument: 'after' },
    ).lean<MessageDoc>();
    if (!updated) throw notFound('That message was already deleted.');
    await this.files.remove(message.attachments.map((a) => a.fileId));
    await Bookmark.deleteMany({ messageId: message._id });
    const dto = this.dto(updated);
    this.bus.toChannel(updated.channelId.toString(), 'message:updated', dto);
    return dto;
  }

  /** Adds your reaction, or takes it away if it's already there. Each step is one atomic update. */
  async toggleReaction(userId: string, messageId: string, emoji: string): Promise<MessageDto> {
    if (!(REACTIONS as readonly string[]).includes(emoji))
      throw badRequest('That reaction isn’t available.');
    const message = await Message.findById(messageId).lean<MessageDoc>();
    if (!message || message.kind !== 'user') throw notFound('That message doesn’t exist.');
    if (message.deletedAt) throw badRequest('You can’t react to a deleted message.');
    await this.channels.requirePoster(userId, message.channelId.toString());
    const me = new Types.ObjectId(userId);

    const removed = await Message.updateOne(
      { _id: message._id, reactions: { $elemMatch: { emoji, userIds: me } } },
      { $pull: { 'reactions.$.userIds': me } },
    );
    if (removed.modifiedCount) {
      await Message.updateOne(
        { _id: message._id },
        { $pull: { reactions: { userIds: { $size: 0 } } } },
      );
    } else {
      for (let attempt = 0; attempt < 2; attempt++) {
        const added = await Message.updateOne(
          { _id: message._id, 'reactions.emoji': emoji },
          { $addToSet: { 'reactions.$.userIds': me } },
        );
        if (added.matchedCount) break;
        const created = await Message.updateOne(
          {
            _id: message._id,
            'reactions.emoji': { $ne: emoji },
            'reactions.11': { $exists: false },
          },
          { $push: { reactions: { emoji, userIds: [me] } } },
        );
        if (created.matchedCount) break;
        // Someone else added the same emoji between our two updates: try joining theirs.
      }
    }

    const updated = await Message.findById(message._id).lean<MessageDoc>();
    const dto = this.dto(updated!);
    this.bus.toChannel(message.channelId.toString(), 'message:updated', dto);
    return dto;
  }

  /** Pins or unpins a message for everyone in the conversation. */
  async pin(userId: string, messageId: string, pinned: boolean): Promise<MessageDto> {
    const message = await Message.findById(messageId).lean<MessageDoc>();
    if (!message || message.kind !== 'user') throw notFound('That message doesn’t exist.');
    if (message.deletedAt) throw badRequest('You can’t pin a deleted message.');
    const channelId = message.channelId.toString();
    await this.channels.requirePoster(userId, channelId);
    if (!!message.pinnedAt === pinned) return this.dto(message);
    const updated = await Message.findOneAndUpdate(
      { _id: message._id, deletedAt: null },
      pinned
        ? { $set: { pinnedAt: new Date(), pinnedBy: new Types.ObjectId(userId) } }
        : { $set: { pinnedAt: null, pinnedBy: null } },
      { returnDocument: 'after' },
    ).lean<MessageDoc>();
    if (!updated) throw notFound('That message was deleted.');
    const dto = this.dto(updated);
    this.bus.toChannel(channelId, 'message:updated', dto);
    if (pinned) await this.system(userId, channelId, 'pinned a message');
    return dto;
  }

  // ---- saved messages ---------------------------------------------------------------

  async bookmark(userId: string, messageId: string, saved: boolean): Promise<{ saved: boolean }> {
    const message = await this.visible(userId, messageId);
    if (saved) {
      if (message.deletedAt) throw badRequest('That message was deleted.');
      await Bookmark.updateOne(
        { userId, messageId: message._id },
        {
          $setOnInsert: {
            channelId: message.channelId,
            createdAt: new Date(),
          },
        },
        { upsert: true },
      );
    } else {
      await Bookmark.deleteOne({ userId, messageId: message._id });
    }
    this.bus.toUser(userId, 'bookmark:changed', { messageId, saved });
    return { saved };
  }

  /** Your saved messages, newest saved first, from conversations you can still see. */
  async bookmarks(userId: string): Promise<{ savedAt: string; message: MessageDto }[]> {
    const rows = await Bookmark.find({ userId }).sort({ createdAt: -1 }).limit(200).lean();
    if (rows.length === 0) return [];
    const [messages, memberships, publicChannels] = await Promise.all([
      Message.find({ _id: { $in: rows.map((r) => r.messageId) } }).lean<MessageDoc[]>(),
      Membership.find({ userId }, { channelId: 1 }).lean(),
      Channel.find({ _id: { $in: rows.map((r) => r.channelId) }, kind: 'public' }, { _id: 1 }).lean(),
    ]);
    const allowed = new Set([
      ...memberships.map((m) => m.channelId.toString()),
      ...publicChannels.map((c) => c._id.toString()),
    ]);
    const byId = new Map(messages.map((m) => [m._id.toString(), m]));
    return rows.flatMap((r) => {
      const m = byId.get(r.messageId.toString());
      if (!m || m.deletedAt || !allowed.has(m.channelId.toString())) return [];
      return [{ savedAt: r.createdAt.toISOString(), message: this.dto(m) }];
    });
  }

  // ---- search and system lines --------------------------------------------------------

  /** Full-text search across the conversations you're in. */
  async search(userId: string, query: string, limit = 25) {
    const q = query.trim();
    if (q.length < 2) return [];
    const memberships = await Membership.find({ userId }, { channelId: 1 }).lean();
    const channelIds = memberships.map((m) => m.channelId);
    const rows = await Message.find(
      { $text: { $search: q }, channelId: { $in: channelIds }, kind: 'user', deletedAt: null },
      { score: { $meta: 'textScore' } },
    )
      .sort({ score: { $meta: 'textScore' }, _id: -1 })
      .limit(Math.min(limit, 50))
      .lean<MessageDoc[]>();
    return rows.map((m) => this.dto(m));
  }

  /** "Sita joined #design" and friends. They don't count as unread. */
  async system(actorId: string, channelId: string, text: string): Promise<void> {
    const saved = (
      await Message.create({
        channelId: new Types.ObjectId(channelId),
        authorId: new Types.ObjectId(actorId),
        kind: 'system',
        text,
        mentions: extractMentionIds(text).map((id) => new Types.ObjectId(id)),
      })
    ).toObject();
    this.bus.toChannel(channelId, 'message:new', this.dto(saved));
  }

  /** Delivers a reminder to the person's own notes (their DM to themselves). */
  async remind(userId: string, messageId: string, clientId?: string): Promise<MessageDto> {
    const message = await this.visible(userId, messageId);
    const notes = await this.channels.openDm(userId, userId);
    const { message: sent } = await this.send(userId, {
      channelId: notes.id,
      clientId,
      text: '',
      reminder: {
        ref: {
          channelId: message.channelId,
          messageId: message._id,
          authorId: message.authorId,
          excerpt: message.deletedAt
            ? ''
            : excerpt(message.text) ||
              (message.attachments[0] ? `📎 ${message.attachments[0].name}` : ''),
        },
      },
    });
    // The DM to yourself might be new: make sure every tab lists it.
    this.bus.toUser(userId, 'channel:upsert', await this.channels.get(userId, notes.id));
    return sent;
  }

  // ---- helpers ------------------------------------------------------------------------

  /** A message in a conversation this person can see. */
  private async visible(userId: string, messageId: string): Promise<MessageDoc> {
    const message = await Message.findById(messageId).lean<MessageDoc>();
    if (!message || message.kind !== 'user') throw notFound('That message doesn’t exist.');
    await this.channels.access(userId, message.channelId.toString());
    return message;
  }

  private async ownMessage(
    userId: string,
    messageId: string,
    action: 'edit' | 'delete',
  ): Promise<MessageDoc> {
    const message = await Message.findById(messageId).lean<MessageDoc>();
    if (!message || message.kind !== 'user') throw notFound('That message doesn’t exist.');
    if (!message.authorId.equals(userId) || message.webhook)
      throw forbidden(`You can only ${action} your own messages.`);
    if (message.deletedAt) throw badRequest('That message was deleted.');
    // You must still be in the conversation, and it must take messages.
    await this.channels.requirePoster(userId, message.channelId.toString());
    return message;
  }

  private async validMentions(text: string): Promise<Types.ObjectId[]> {
    const ids = extractMentionIds(text);
    if (ids.length === 0) return [];
    const users = await User.find({ _id: { $in: ids } }, { _id: 1 }).lean();
    return users.map((u) => u._id);
  }

  /** Looks up the first link after the message is out, so sending is never slowed down. */
  private previewLater(message: MessageDoc): void {
    const fetcher = this.fetchPreview;
    const url = message.text ? firstUrl(message.text) : null;
    if (!fetcher || !url) return;
    void (async () => {
      const preview = await fetcher(url).catch(() => null);
      if (!preview) return;
      const updated = await Message.findOneAndUpdate(
        { _id: message._id, deletedAt: null, text: message.text },
        { $set: { linkPreview: { url, ...preview } } },
        { returnDocument: 'after' },
      ).lean<MessageDoc>();
      if (updated)
        this.bus.toChannel(updated.channelId.toString(), 'message:updated', this.dto(updated));
    })();
  }
}

export type { MembershipDoc };
