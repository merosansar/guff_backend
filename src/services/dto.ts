import type { ChannelKind } from '../models/channel.js';
import type { NotifyLevel, Role } from '../models/membership.js';
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
  durationMs: number | null;
  waveform: number[] | null;
}

export interface LinkPreviewDto {
  url: string;
  title: string;
  description: string;
  image: string | null;
  siteName: string;
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
  /** How many earlier versions there are (shown as "edited", click for history). */
  editCount: number;
  pinnedAt: string | null;
  pinnedBy: string | null;
  threadRootId: string | null;
  thread: { replyCount: number; lastReplyAt: string | null; participantIds: string[] } | null;
  linkPreview: LinkPreviewDto | null;
  webhook: { id: string; name: string } | null;
  reminder: boolean;
  ref: { channelId: string; messageId: string; authorId: string; excerpt: string } | null;
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
  archivedAt: string | null;
  joined: boolean;
  role: Role | null;
  notify: NotifyLevel;
  lastReadId: string | null;
  unread: number;
  mentions: number;
}

export interface ChannelMetaDto {
  id: string;
  name: string;
  topic: string;
  memberCount: number;
  archivedAt: string | null;
}

export interface MessagePage {
  messages: MessageDto[];
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
}

export interface ThreadDto {
  root: MessageDto;
  replies: MessageDto[];
}

export interface CallInvite {
  callId: string;
  channelId: string;
  fromUserId: string;
  /** The caller's tab, so answers go to that one tab. */
  fromSocketId: string;
  video: boolean;
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
  'bookmark:changed': (event: { messageId: string; saved: boolean }) => void;
  'scheduled:changed': () => void;
  'call:incoming': (invite: CallInvite) => void;
  'call:accepted': (event: { callId: string; bySocketId: string; byUserId: string }) => void;
  'call:declined': (event: { callId: string; reason: 'declined' | 'busy' }) => void;
  'call:signal': (event: { callId: string; fromSocketId: string; data: unknown }) => void;
  'call:ended': (event: { callId: string }) => void;
}

export type Ack<T = unknown> =
  { ok: true; data: T } | { ok: false; error: { status: number; message: string } };
