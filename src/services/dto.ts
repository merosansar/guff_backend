import type { ChannelKind } from '../models/channel.js';
import type { PublicUser } from '../models/user.js';

export type PresenceStatus = 'online' | 'away' | 'offline';

export interface UserWithPresence extends PublicUser {
  status: PresenceStatus;
  /** A demo teammate that answers automatically (only when demo replies are on). */
  demo: boolean;
}

export interface AttachmentDto {
  id: string;
  name: string;
  size: number;
  contentType: string;
  width: number | null;
  height: number | null;
  url: string;
}

export interface MessageDto {
  id: string;
  channelId: string;
  authorId: string;
  kind: 'user' | 'system';
  clientId: string | null;
  text: string;
  mentions: string[];
  replyTo: { messageId: string; authorId: string; excerpt: string } | null;
  reactions: { emoji: string; userIds: string[] }[];
  attachments: AttachmentDto[];
  /** Sent by a demo teammate's auto-reply. */
  automated: boolean;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
}

export interface ChannelDto {
  id: string;
  kind: ChannelKind;
  name: string;
  topic: string;
  isDefault: boolean;
  memberCount: number;
  createdBy: string;
  createdAt: string;
  lastMessageAt: string | null;
  /** For DMs: the other person (yourself, in a DM to yourself). */
  dmUserId: string | null;
  joined: boolean;
  role: 'owner' | 'member' | null;
  lastReadId: string | null;
  unread: number;
  mentions: number;
}

export interface ChannelMetaDto {
  id: string;
  name: string;
  topic: string;
  memberCount: number;
}

export interface MessagePage {
  messages: MessageDto[];
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
}

export interface ReadEvent {
  channelId: string;
  userId: string;
  messageId: string;
}

/** Everything the server pushes to browsers. */
export interface ServerToClientEvents {
  'message:new': (message: MessageDto) => void;
  'message:updated': (message: MessageDto) => void;
  typing: (event: { channelId: string; userId: string; typing: boolean }) => void;
  presence: (event: { userId: string; status: PresenceStatus; lastSeenAt: string | null }) => void;
  read: (event: ReadEvent) => void;
  'channel:upsert': (channel: ChannelDto) => void;
  'channel:meta': (meta: ChannelMetaDto) => void;
  'channel:removed': (event: { channelId: string }) => void;
  'user:upsert': (user: UserWithPresence) => void;
  'auth:expired': () => void;
}

export type Ack<T = unknown> =
  { ok: true; data: T } | { ok: false; error: { status: number; message: string } };
