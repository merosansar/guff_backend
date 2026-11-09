import { Types } from 'mongoose';
import { badRequest, conflict, forbidden, isDuplicateKey, notFound } from '../lib/errors.js';
import { channelSlug } from '../lib/text.js';
import { Channel, type ChannelDoc, dmKeyFor } from '../models/channel.js';
import { Membership, type MembershipDoc, type NotifyLevel } from '../models/membership.js';
import { Message } from '../models/message.js';
import { User } from '../models/user.js';
import type { RealtimeBus } from '../realtime/bus.js';
import type { ChannelDto } from './dto.js';
import { channelDto, channelMeta } from './serialize.js';

/** Unread counts stop at this number; the app shows "99+". */
export const UNREAD_CAP = 100;

const ZERO_ID = new Types.ObjectId('000000000000000000000000');

/** Owners and admins look after a channel. */
export const isManager = (m: Pick<MembershipDoc, 'role'> | null | undefined) =>
  m?.role === 'owner' || m?.role === 'admin';

/**
 * What counts as unread for someone: messages by others (plus reminders they set and
 * integration posts), in the
 * main timeline. Thread replies only count when they mention you.
 */
export function unreadFilter(me: Types.ObjectId) {
  return {
    kind: 'user' as const,
    deletedAt: null,
    $and: [
      { $or: [{ authorId: { $ne: me } }, { reminder: true }, { webhook: { $ne: null } }] },
      { $or: [{ threadRootId: null }, { mentions: me }] },
    ],
  };
}

export interface Access {
  channel: ChannelDoc;
  membership: MembershipDoc | null;
}

/** Posts the small grey lines like "Sita joined #design". Wired up by MessageService. */
export type SystemPoster = (actorId: string, channelId: string, text: string) => Promise<void>;

export class ChannelService {
  private postSystem: SystemPoster = async () => {};

  constructor(private readonly bus: RealtimeBus) {}

  onSystemMessage(poster: SystemPoster): void {
    this.postSystem = poster;
  }

  // ---- reading --------------------------------------------------------------

  /** Public channels can be previewed by anyone; private channels and DMs only by members. */
  async access(userId: string, channelId: string): Promise<Access> {
    const channel = await Channel.findById(channelId).lean<ChannelDoc>();
    const membership = channel
      ? await Membership.findOne({ channelId: channel._id, userId }).lean<MembershipDoc>()
      : null;
    if (!channel || (channel.kind !== 'public' && !membership)) {
      throw notFound('That conversation doesn’t exist, or you’re not in it.');
    }
    return { channel, membership };
  }

  async requireMember(
    userId: string,
    channelId: string,
  ): Promise<Access & { membership: MembershipDoc }> {
    const result = await this.access(userId, channelId);
    if (!result.membership) throw forbidden(`Join #${result.channel.name} to take part.`);
    return result as Access & { membership: MembershipDoc };
  }

  /** A member of a channel that isn't archived: someone who can post. */
  async requirePoster(
    userId: string,
    channelId: string,
  ): Promise<Access & { membership: MembershipDoc }> {
    const result = await this.requireMember(userId, channelId);
    if (result.channel.archivedAt)
      throw forbidden(`#${result.channel.name} is archived, so nobody can post in it.`);
    return result;
  }

  async requireManager(
    userId: string,
    channelId: string,
  ): Promise<Access & { membership: MembershipDoc }> {
    const result = await this.requireMember(userId, channelId);
    if (result.channel.kind === 'dm') throw badRequest('Direct messages don’t have admins.');
    if (!isManager(result.membership))
      throw forbidden('Only the channel’s owner and admins can do that.');
    return result;
  }

  /** The sidebar: every channel and DM you're in, with unread and mention counts. */
  async listForUser(userId: string): Promise<ChannelDto[]> {
    const me = new Types.ObjectId(userId);
    const rows = await Membership.aggregate<
      MembershipDoc & { channel: ChannelDoc[]; counts: { unread: number; mentions: number }[] }
    >([
      { $match: { userId: me } },
      {
        $lookup: { from: 'channels', localField: 'channelId', foreignField: '_id', as: 'channel' },
      },
      {
        $lookup: {
          from: 'messages',
          let: { channelId: '$channelId', lastRead: { $ifNull: ['$lastReadId', ZERO_ID] } },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [{ $eq: ['$channelId', '$$channelId'] }, { $gt: ['$_id', '$$lastRead'] }],
                },
                ...unreadFilter(me),
              },
            },
            { $limit: UNREAD_CAP },
            {
              $group: {
                _id: null,
                unread: { $sum: 1 },
                mentions: { $sum: { $cond: [{ $in: [me, '$mentions'] }, 1, 0] } },
              },
            },
          ],
          as: 'counts',
        },
      },
    ]);

    const dmIds = rows.filter((r) => r.channel[0]?.kind === 'dm').map((r) => r.channelId);
    const others = await Membership.find(
      { channelId: { $in: dmIds }, userId: { $ne: me } },
      { channelId: 1, userId: 1 },
    ).lean();
    const otherByChannel = new Map(others.map((o) => [o.channelId.toString(), o.userId]));

    return rows
      .filter((r) => r.channel[0])
      .filter((r) => {
        // A DM someone opened but nobody has written in yet only shows for the person who opened it.
        const c = r.channel[0]!;
        return c.kind !== 'dm' || c.lastMessageAt !== null || c.createdBy.equals(me);
      })
      .map((r) => {
        const c = r.channel[0]!;
        const counts = r.counts[0];
        return channelDto(c, r, {
          unread: counts?.unread ?? 0,
          mentions: counts?.mentions ?? 0,
          dmUserId: c.kind === 'dm' ? (otherByChannel.get(c._id.toString()) ?? me) : null,
        });
      });
  }

  async get(userId: string, channelId: string): Promise<ChannelDto> {
    const { channel, membership } = await this.access(userId, channelId);
    return this.dtoFor(userId, channel, membership);
  }

  /** Public channels to browse and join. */
  async browse(userId: string, query = ''): Promise<ChannelDto[]> {
    const filter: Record<string, unknown> = { kind: 'public' };
    const q = query.trim();
    if (q) {
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { name: { $regex: escaped, $options: 'i' } },
        { topic: { $regex: escaped, $options: 'i' } },
      ];
    }
    const channels = await Channel.find(filter)
      .sort({ memberCount: -1, name: 1 })
      .limit(100)
      .lean<ChannelDoc[]>();
    const mine = await Membership.find(
      { userId, channelId: { $in: channels.map((c) => c._id) } },
      { channelId: 1, role: 1, lastReadId: 1, notify: 1 },
    ).lean();
    const byChannel = new Map(mine.map((m) => [m.channelId.toString(), m]));
    return channels.map((c) => channelDto(c, byChannel.get(c._id.toString()) ?? null));
  }

  async members(userId: string, channelId: string) {
    const { channel } = await this.access(userId, channelId);
    const rows = await Membership.find({ channelId: channel._id }).sort({ joinedAt: 1 }).lean();
    return rows.map((m) => ({
      userId: m.userId.toString(),
      role: m.role,
      joinedAt: m.joinedAt.toISOString(),
      // Read receipts are only shown in DMs.
      lastReadId: channel.kind === 'dm' && m.lastReadId ? m.lastReadId.toString() : null,
    }));
  }

  // ---- changing -------------------------------------------------------------

  async create(
    userId: string,
    input: { name: string; topic?: string; kind: 'public' | 'private'; memberIds?: string[] },
  ): Promise<ChannelDto> {
    const name = channelSlug(input.name);
    if (name.length < 2) {
      throw badRequest(
        'Give the channel a name of at least 2 letters or numbers, like “design-team”.',
      );
    }
    let channel: ChannelDoc;
    try {
      channel = (
        await Channel.create({
          kind: input.kind,
          name,
          topic: input.topic ?? '',
          createdBy: userId,
        })
      ).toObject();
    } catch (error) {
      if (isDuplicateKey(error)) throw conflict(`There’s already a channel called #${name}.`);
      throw error;
    }

    await this.addMembership(channel, userId, 'owner');
    await this.postSystem(userId, channel._id.toString(), `created #${name}`);

    const others = [...new Set(input.memberIds ?? [])].filter((id) => id !== userId);
    if (others.length) await this.addMembers(userId, channel._id.toString(), others);

    const fresh = await Channel.findById(channel._id).lean<ChannelDoc>();
    const dto = await this.dtoFor(userId, fresh!, await this.membershipOf(userId, channel._id));
    this.bus.toUser(userId, 'channel:upsert', dto);
    return dto;
  }

  async join(userId: string, channelId: string): Promise<ChannelDto> {
    const { channel, membership } = await this.access(userId, channelId);
    if (channel.kind !== 'public')
      throw forbidden('That channel is private. Ask someone in it to add you.');
    if (!membership) {
      if (await this.addMembership(channel, userId, 'member')) {
        await this.postSystem(userId, channelId, `joined #${channel.name}`);
        await this.broadcastMeta(channelId);
      }
    }
    const dto = await this.get(userId, channelId);
    this.bus.toUser(userId, 'channel:upsert', dto);
    return dto;
  }

  async leave(userId: string, channelId: string): Promise<void> {
    const { channel, membership } = await this.access(userId, channelId);
    if (channel.kind === 'dm') throw badRequest('You can’t leave a direct message.');
    if (channel.name === 'general')
      throw badRequest('Everyone stays in #general, so announcements reach the whole team.');
    if (!membership) return;
    await this.postSystem(userId, channelId, `left #${channel.name}`);
    const removed = await Membership.deleteOne({ _id: membership._id });
    if (removed.deletedCount)
      await Channel.updateOne({ _id: channel._id }, { $inc: { memberCount: -1 } });
    this.bus.leaveChannel(userId, channelId);
    this.bus.toUser(userId, 'channel:removed', { channelId });
    await this.broadcastMeta(channelId);
  }

  async addMembers(userId: string, channelId: string, userIds: string[]): Promise<ChannelDto> {
    const { channel } = await this.requireMember(userId, channelId);
    if (channel.kind === 'dm') throw badRequest('You can’t add people to a direct message.');
    const ids = [...new Set(userIds)].filter((id) => id !== userId);
    const people = await User.find({ _id: { $in: ids } }, { _id: 1 }).lean();
    if (people.length !== ids.length)
      throw badRequest('One of those people doesn’t have an account.');

    const added: string[] = [];
    for (const person of people) {
      if (await this.addMembership(channel, person._id.toString(), 'member'))
        added.push(person._id.toString());
    }
    if (added.length) {
      await this.postSystem(userId, channelId, `added ${added.map((id) => `<@${id}>`).join(', ')}`);
      for (const id of added) this.bus.toUser(id, 'channel:upsert', await this.get(id, channelId));
      await this.broadcastMeta(channelId);
    }
    return this.get(userId, channelId);
  }

  async update(
    userId: string,
    channelId: string,
    input: { name?: string; topic?: string },
  ): Promise<ChannelDto> {
    const { channel, membership } = await this.requireMember(userId, channelId);
    if (channel.kind === 'dm') throw badRequest('Direct messages don’t have a name or topic.');
    const changes: Partial<Pick<ChannelDoc, 'name' | 'topic'>> = {};

    if (input.name !== undefined) {
      const name = channelSlug(input.name);
      if (name.length < 2)
        throw badRequest('Give the channel a name of at least 2 letters or numbers.');
      if (name !== channel.name) {
        if (!isManager(membership))
          throw forbidden('Only the channel’s owner and admins can rename it.');
        if (channel.name === 'general') throw badRequest('#general keeps its name.');
        changes.name = name;
      }
    }
    if (input.topic !== undefined && input.topic.trim() !== channel.topic)
      changes.topic = input.topic.trim();
    if (Object.keys(changes).length === 0) return this.get(userId, channelId);

    try {
      await Channel.updateOne({ _id: channel._id }, { $set: changes });
    } catch (error) {
      if (isDuplicateKey(error))
        throw conflict(`There’s already a channel called #${changes.name}.`);
      throw error;
    }
    if (changes.name)
      await this.postSystem(userId, channelId, `renamed the channel to #${changes.name}`);
    if (changes.topic !== undefined) {
      await this.postSystem(
        userId,
        channelId,
        changes.topic ? `set the topic: ${changes.topic}` : 'cleared the topic',
      );
    }
    await this.broadcastMeta(channelId);
    return this.get(userId, channelId);
  }

  /** Finds or creates the one DM between two people (or a DM to yourself, for notes). */
  async openDm(userId: string, otherId: string): Promise<ChannelDto> {
    const other = await User.exists({ _id: otherId });
    if (!other) throw notFound('That person doesn’t have an account.');
    const dmKey = dmKeyFor(userId, otherId);
    let channel = await Channel.findOne({ kind: 'dm', dmKey }).lean<ChannelDoc>();
    if (!channel) {
      try {
        channel = (await Channel.create({ kind: 'dm', dmKey, createdBy: userId })).toObject();
      } catch (error) {
        // Both people opened the DM at the same moment: the unique index lets one win.
        if (!isDuplicateKey(error)) throw error;
        channel = await Channel.findOne({ kind: 'dm', dmKey }).lean<ChannelDoc>();
      }
      if (!channel) throw new Error('DM could not be created');
    }
    for (const id of new Set([userId, otherId])) await this.addMembership(channel, id, 'member');
    return this.get(userId, channel._id.toString());
  }

  /** Moves the read marker forward (never back). Other tabs, and the other person in a DM, hear about it. */
  async markRead(userId: string, channelId: string, messageId: string): Promise<boolean> {
    const id = new Types.ObjectId(messageId);
    const { channel } = await this.requireMember(userId, channelId);
    const inChannel = await Message.exists({ _id: id, channelId: channel._id });
    if (!inChannel) throw badRequest('That message isn’t in this conversation.');
    const result = await Membership.updateOne(
      { channelId: channel._id, userId, $or: [{ lastReadId: null }, { lastReadId: { $lt: id } }] },
      { $set: { lastReadId: id } },
    );
    if (result.modifiedCount === 0) return false;
    const event = { channelId, userId, messageId };
    if (channel.kind === 'dm') this.bus.toChannel(channelId, 'read', event);
    else this.bus.toUser(userId, 'read', event);
    return true;
  }

  /** New people start in the default channels, with nothing unread. */
  async joinDefaults(userId: string): Promise<void> {
    const defaults = await Channel.find({ isDefault: true }).lean<ChannelDoc[]>();
    for (const channel of defaults) {
      if (await this.addMembership(channel, userId, 'member')) {
        await this.postSystem(userId, channel._id.toString(), `joined #${channel.name}`);
        await this.broadcastMeta(channel._id.toString());
      }
    }
  }

  // ---- looking after a channel ------------------------------------------------------

  /** Owners can make people admins (or take it back). */
  async setRole(
    userId: string,
    channelId: string,
    targetId: string,
    role: 'admin' | 'member',
  ): Promise<void> {
    const { membership } = await this.requireManager(userId, channelId);
    if (membership.role !== 'owner') throw forbidden('Only the channel’s owner can change admins.');
    const target = await Membership.findOne({ channelId, userId: targetId }).lean<MembershipDoc>();
    if (!target) throw notFound('That person isn’t in this channel.');
    if (target.role === 'owner') throw badRequest('The owner is always in charge.');
    if (target.role === role) return;
    await Membership.updateOne({ _id: target._id }, { $set: { role } });
    await this.postSystem(
      userId,
      channelId,
      role === 'admin' ? `made <@${targetId}> an admin` : `removed <@${targetId}> as an admin`,
    );
    this.bus.toUser(targetId, 'channel:upsert', await this.get(targetId, channelId));
    await this.broadcastMeta(channelId);
  }

  /** Owners and admins can remove people (admins can't remove other admins or the owner). */
  async removeMember(userId: string, channelId: string, targetId: string): Promise<void> {
    if (userId === targetId) throw badRequest('To leave the channel yourself, use “Leave”.');
    const { channel, membership } = await this.requireManager(userId, channelId);
    if (channel.isDefault) throw badRequest(`Everyone stays in #${channel.name}.`);
    const target = await Membership.findOne({ channelId, userId: targetId }).lean<MembershipDoc>();
    if (!target) throw notFound('That person isn’t in this channel.');
    if (target.role === 'owner') throw forbidden('The channel’s owner can’t be removed.');
    if (target.role === 'admin' && membership.role !== 'owner')
      throw forbidden('Only the owner can remove an admin.');
    const removed = await Membership.deleteOne({ _id: target._id });
    if (!removed.deletedCount) return;
    await Channel.updateOne({ _id: channel._id }, { $inc: { memberCount: -1 } });
    await this.postSystem(userId, channelId, `removed <@${targetId}> from #${channel.name}`);
    this.bus.leaveChannel(targetId, channelId);
    this.bus.toUser(targetId, 'channel:removed', { channelId });
    await this.broadcastMeta(channelId);
  }

  /** Archived channels keep their history but take no new messages. */
  async setArchived(userId: string, channelId: string, archived: boolean): Promise<ChannelDto> {
    const { channel } = await this.requireManager(userId, channelId);
    if (channel.isDefault && archived) throw badRequest(`#${channel.name} can’t be archived.`);
    if (!!channel.archivedAt === archived) return this.get(userId, channelId);
    if (!archived) await Channel.updateOne({ _id: channel._id }, { $set: { archivedAt: null } });
    await this.postSystem(userId, channelId, archived ? `archived #${channel.name}` : `unarchived #${channel.name}`);
    if (archived) await Channel.updateOne({ _id: channel._id }, { $set: { archivedAt: new Date() } });
    await this.broadcastMeta(channelId);
    return this.get(userId, channelId);
  }

  /** How loudly this conversation should get your attention. */
  async setNotify(userId: string, channelId: string, level: NotifyLevel): Promise<ChannelDto> {
    const { membership } = await this.requireMember(userId, channelId);
    await Membership.updateOne({ _id: membership._id }, { $set: { notify: level } });
    const dto = await this.get(userId, channelId);
    this.bus.toUser(userId, 'channel:upsert', dto);
    return dto;
  }

  // ---- helpers ----------------------------------------------------------------

  /** Returns true if the person wasn't a member yet. Their tabs join the room straight away. */
  private async addMembership(
    channel: ChannelDoc,
    userId: string,
    role: 'owner' | 'member',
  ): Promise<boolean> {
    const latest = await Message.findOne({ channelId: channel._id }, { _id: 1 })
      .sort({ _id: -1 })
      .lean();
    const result = await Membership.updateOne(
      { channelId: channel._id, userId },
      { $setOnInsert: { role, joinedAt: new Date(), lastReadId: latest?._id ?? null } },
      { upsert: true },
    );
    if (result.upsertedCount === 0) return false;
    await Channel.updateOne({ _id: channel._id }, { $inc: { memberCount: 1 } });
    this.bus.joinChannel(userId, channel._id.toString());
    return true;
  }

  private membershipOf(userId: string, channelId: Types.ObjectId) {
    return Membership.findOne({ channelId, userId }).lean<MembershipDoc>();
  }

  private async broadcastMeta(channelId: string): Promise<void> {
    const channel = await Channel.findById(channelId).lean<ChannelDoc>();
    if (channel) this.bus.toChannel(channelId, 'channel:meta', channelMeta(channel));
  }

  private async dtoFor(
    userId: string,
    channel: ChannelDoc,
    membership: MembershipDoc | null,
  ): Promise<ChannelDto> {
    let dmUserId: Types.ObjectId | null = null;
    if (channel.kind === 'dm') {
      const other = await Membership.findOne(
        { channelId: channel._id, userId: { $ne: userId } },
        { userId: 1 },
      ).lean();
      dmUserId = other?.userId ?? new Types.ObjectId(userId);
    }
    let unread = 0;
    let mentions = 0;
    if (membership) {
      const me = new Types.ObjectId(userId);
      const filter = {
        channelId: channel._id,
        _id: { $gt: membership.lastReadId ?? ZERO_ID },
        ...unreadFilter(me),
      };
      [unread, mentions] = await Promise.all([
        Message.countDocuments(filter, { limit: UNREAD_CAP }),
        Message.countDocuments({ ...filter, mentions: me }, { limit: UNREAD_CAP }),
      ]);
    }
    return channelDto(channel, membership, { unread, mentions, dmUserId });
  }
}
