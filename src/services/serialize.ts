import type { Types } from 'mongoose';
import type { ChannelDoc } from '../models/channel.js';
import type { MembershipDoc } from '../models/membership.js';
import type { MessageDoc } from '../models/message.js';
import type { ChannelDto, ChannelMetaDto, MessageDto } from './dto.js';
import type { FileService } from './files.js';

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function messageDto(m: MessageDoc, files: FileService): MessageDto {
  return {
    id: m._id.toString(),
    channelId: m.channelId.toString(),
    authorId: m.authorId.toString(),
    kind: m.kind,
    clientId: m.clientId ?? null,
    text: m.text,
    mentions: (m.mentions ?? []).map(String),
    replyTo: m.replyTo
      ? {
          messageId: m.replyTo.messageId.toString(),
          authorId: m.replyTo.authorId.toString(),
          excerpt: m.replyTo.excerpt,
        }
      : null,
    reactions: (m.reactions ?? [])
      .filter((r) => r.userIds.length > 0)
      .map((r) => ({ emoji: r.emoji, userIds: r.userIds.map(String) })),
    attachments: (m.attachments ?? []).map((a) => files.toDto(a)),
    automated: m.automated ?? false,
    createdAt: m._id.getTimestamp().toISOString(),
    editedAt: iso(m.editedAt),
    deletedAt: iso(m.deletedAt),
  };
}

export function channelDto(
  c: ChannelDoc,
  membership: Pick<MembershipDoc, 'role' | 'lastReadId'> | null,
  extra: { unread?: number; mentions?: number; dmUserId?: Types.ObjectId | string | null } = {},
): ChannelDto {
  return {
    id: c._id.toString(),
    kind: c.kind,
    name: c.name,
    topic: c.topic,
    isDefault: c.isDefault,
    memberCount: c.memberCount,
    createdBy: c.createdBy.toString(),
    createdAt: c.createdAt.toISOString(),
    lastMessageAt: iso(c.lastMessageAt),
    dmUserId: extra.dmUserId ? extra.dmUserId.toString() : null,
    joined: membership !== null,
    role: membership?.role ?? null,
    lastReadId: membership?.lastReadId ? membership.lastReadId.toString() : null,
    unread: extra.unread ?? 0,
    mentions: extra.mentions ?? 0,
  };
}

export const channelMeta = (c: ChannelDoc): ChannelMetaDto => ({
  id: c._id.toString(),
  name: c.name,
  topic: c.topic,
  memberCount: c.memberCount,
});
