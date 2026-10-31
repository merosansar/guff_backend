import { EventEmitter } from 'node:events';
import { Types } from 'mongoose';
import { badRequest, forbidden, isDuplicateKey, notFound } from '../lib/errors.js';
import { excerpt, extractMentionIds, normalizeText } from '../lib/text.js';
import { Channel, type ChannelDoc } from '../models/channel.js';
import { Membership } from '../models/membership.js';
import { Message, type MessageDoc, REACTIONS } from '../models/message.js';
import { User } from '../models/user.js';
import type { RealtimeBus } from '../realtime/bus.js';
import type { ChannelService } from './channels.js';
import type { MessageDto, MessagePage } from './dto.js';
import type { FileService } from './files.js';
import { messageDto } from './serialize.js';

export interface SendInput {
  channelId: string;
  clientId?: string | undefined;
  text: string;
  replyToId?: string | undefined;
  attachmentIds?: string[] | undefined;
  automated?: boolean;
}

export interface MessageCreated {
  message: MessageDoc;
  channel: ChannelDoc;
}

const MAX_PAGE = 100;

export class MessageService {
  /** Emits "created" after a person's message is saved (the demo teammates listen). */
  readonly events = new EventEmitter<{ created: [MessageCreated] }>();

  constructor(
    private readonly bus: RealtimeBus,
    private readonly channels: ChannelService,
    private readonly files: FileService,
  ) {
    channels.onSystemMessage((actorId, channelId, text) => this.system(actorId, channelId, text));
  }

  dto(m: MessageDoc): MessageDto {
    return messageDto(m, this.files);
  }

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
    const base = { channelId: channel._id };

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

  async send(
    userId: string,
    input: SendInput,
  ): Promise<{ message: MessageDto; duplicate: boolean }> {
    const { channel } = await this.channels.requireMember(userId, input.channelId);
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
    if (!text && attachmentIds.length === 0) throw badRequest('Write a message or attach a file.');

    const mentions = await this.validMentions(text);

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

    await Channel.updateOne({ _id: channel._id }, { $set: { lastMessageAt: new Date() } });
    // Writing a message means you've read everything before it.
    await Membership.updateOne(
      {
        channelId: channel._id,
        userId: author,
        $or: [{ lastReadId: null }, { lastReadId: { $lt: saved._id } }],
      },
      { $set: { lastReadId: saved._id } },
    );

    const dto = this.dto(saved);
    this.bus.toChannel(channel._id.toString(), 'message:new', dto);
    this.events.emit('created', { message: saved, channel });
    return { message: dto, duplicate: false };
  }

  async edit(userId: string, messageId: string, rawText: string): Promise<MessageDto> {
    const message = await this.ownMessage(userId, messageId, 'edit');
    const text = normalizeText(rawText);
    if (!text && message.attachments.length === 0) {
      throw badRequest('A message can’t be empty. Delete it instead.');
    }
    if (text === message.text) return this.dto(message);
    const updated = await Message.findOneAndUpdate(
      { _id: message._id, deletedAt: null },
      { $set: { text, mentions: await this.validMentions(text), editedAt: new Date() } },
      { returnDocument: 'after' },
    ).lean<MessageDoc>();
    if (!updated) throw notFound('That message was deleted.');
    const dto = this.dto(updated);
    this.bus.toChannel(updated.channelId.toString(), 'message:updated', dto);
    return dto;
  }

  /** Soft delete: the message keeps its place in the history as "This message was deleted". */
  async remove(userId: string, messageId: string): Promise<MessageDto> {
    const message = await this.ownMessage(userId, messageId, 'delete');
    const updated = await Message.findOneAndUpdate(
      { _id: message._id, deletedAt: null },
      { $set: { text: '', mentions: [], reactions: [], attachments: [], deletedAt: new Date() } },
      { returnDocument: 'after' },
    ).lean<MessageDoc>();
    if (!updated) throw notFound('That message was already deleted.');
    await this.files.remove(message.attachments.map((a) => a.fileId));
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
    await this.channels.requireMember(userId, message.channelId.toString());
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

  private async ownMessage(
    userId: string,
    messageId: string,
    action: 'edit' | 'delete',
  ): Promise<MessageDoc> {
    const message = await Message.findById(messageId).lean<MessageDoc>();
    if (!message || message.kind !== 'user') throw notFound('That message doesn’t exist.');
    if (!message.authorId.equals(userId))
      throw forbidden(`You can only ${action} your own messages.`);
    if (message.deletedAt) throw badRequest('That message was deleted.');
    // You must still be in the conversation.
    await this.channels.requireMember(userId, message.channelId.toString());
    return message;
  }

  private async validMentions(text: string): Promise<Types.ObjectId[]> {
    const ids = extractMentionIds(text);
    if (ids.length === 0) return [];
    const users = await User.find({ _id: { $in: ids } }, { _id: 1 }).lean();
    return users.map((u) => u._id);
  }
}
