import { Schema, model, type Types } from 'mongoose';

/** The reactions people can add. A fixed set keeps the picker simple and the data clean. */
export const REACTIONS = [
  '👍',
  '❤️',
  '😂',
  '🎉',
  '🙏',
  '👀',
  '✅',
  '🔥',
  '😮',
  '😢',
  '💯',
  '🙌',
] as const;

export interface Attachment {
  fileId: Types.ObjectId;
  name: string;
  size: number;
  contentType: string;
  width: number | null;
  height: number | null;
  /** Voice messages: length and a small loudness outline for drawing the waveform. */
  durationMs: number | null;
  waveform: number[] | null;
}

export interface Reaction {
  emoji: string;
  userIds: Types.ObjectId[];
}

export interface ReplyRef {
  messageId: Types.ObjectId;
  authorId: Types.ObjectId;
  /** A short copy of the original, so the quote still reads if the original is edited. */
  excerpt: string;
}

export interface EditRecord {
  text: string;
  /** When this version was replaced. */
  replacedAt: Date;
}

export interface ThreadInfo {
  replyCount: number;
  lastReplyAt: Date | null;
  /** The first few people who replied, for the little avatars under the message. */
  participantIds: Types.ObjectId[];
}

export interface LinkPreview {
  url: string;
  title: string;
  description: string;
  image: string | null;
  siteName: string;
}

/** A pointer to another message, shown as a card (used by reminders). */
export interface MessageRef {
  channelId: Types.ObjectId;
  messageId: Types.ObjectId;
  authorId: Types.ObjectId;
  excerpt: string;
}

export interface MessageDoc {
  _id: Types.ObjectId;
  channelId: Types.ObjectId;
  authorId: Types.ObjectId;
  /** "user" messages are typed by people; "system" ones say who joined or what changed. */
  kind: 'user' | 'system';
  /** Set by the sender's browser; makes resends after a dropped connection harmless. */
  clientId: string | null;
  text: string;
  mentions: Types.ObjectId[];
  replyTo: ReplyRef | null;
  reactions: Reaction[];
  attachments: Attachment[];
  /** Written by a demo teammate's auto-reply, and labelled as such in the app. */
  automated: boolean;
  editedAt: Date | null;
  deletedAt: Date | null;
  /** Earlier versions, oldest first (the last 20). */
  edits: EditRecord[];
  pinnedAt: Date | null;
  pinnedBy: Types.ObjectId | null;
  /** Set on a reply in a thread: the message the thread hangs off. */
  threadRootId: Types.ObjectId | null;
  /** Set on a message that has a thread. */
  thread: ThreadInfo | null;
  linkPreview: LinkPreview | null;
  /** Posted by an incoming webhook (an integration) rather than typed by a person. */
  webhook: { id: Types.ObjectId; name: string } | null;
  /** A reminder you set, delivered to your notes. */
  reminder: boolean;
  ref: MessageRef | null;
}

const attachmentSchema = new Schema<Attachment>(
  {
    fileId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true },
    size: { type: Number, required: true },
    contentType: { type: String, required: true },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    durationMs: { type: Number, default: null },
    waveform: { type: [Number], default: null },
  },
  { _id: false },
);

const messageSchema = new Schema<MessageDoc>(
  {
    channelId: { type: Schema.Types.ObjectId, ref: 'Channel', required: true },
    authorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    kind: { type: String, enum: ['user', 'system'], default: 'user' },
    clientId: { type: String, default: null, maxlength: 64 },
    text: { type: String, default: '', maxlength: 4000 },
    mentions: { type: [Schema.Types.ObjectId], default: [] },
    replyTo: {
      type: new Schema<ReplyRef>(
        {
          messageId: { type: Schema.Types.ObjectId, required: true },
          authorId: { type: Schema.Types.ObjectId, required: true },
          excerpt: { type: String, default: '' },
        },
        { _id: false },
      ),
      default: null,
    },
    reactions: {
      type: [
        new Schema<Reaction>(
          {
            emoji: { type: String, required: true },
            userIds: { type: [Schema.Types.ObjectId], default: [] },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    attachments: { type: [attachmentSchema], default: [] },
    automated: { type: Boolean, default: false },
    editedAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
    edits: {
      type: [
        new Schema<EditRecord>(
          { text: { type: String, default: '' }, replacedAt: { type: Date, required: true } },
          { _id: false },
        ),
      ],
      default: [],
    },
    pinnedAt: { type: Date, default: null },
    pinnedBy: { type: Schema.Types.ObjectId, default: null },
    threadRootId: { type: Schema.Types.ObjectId, default: null },
    thread: {
      type: new Schema<ThreadInfo>(
        {
          replyCount: { type: Number, default: 0 },
          lastReplyAt: { type: Date, default: null },
          participantIds: { type: [Schema.Types.ObjectId], default: [] },
        },
        { _id: false },
      ),
      default: null,
    },
    linkPreview: {
      type: new Schema<LinkPreview>(
        {
          url: { type: String, required: true },
          title: { type: String, default: '' },
          description: { type: String, default: '' },
          image: { type: String, default: null },
          siteName: { type: String, default: '' },
        },
        { _id: false },
      ),
      default: null,
    },
    webhook: {
      type: new Schema(
        {
          id: { type: Schema.Types.ObjectId, required: true },
          name: { type: String, required: true },
        },
        { _id: false },
      ),
      default: null,
    },
    reminder: { type: Boolean, default: false },
    ref: {
      type: new Schema<MessageRef>(
        {
          channelId: { type: Schema.Types.ObjectId, required: true },
          messageId: { type: Schema.Types.ObjectId, required: true },
          authorId: { type: Schema.Types.ObjectId, required: true },
          excerpt: { type: String, default: '' },
        },
        { _id: false },
      ),
      default: null,
    },
  },
  // ObjectIds already carry the creation time; no separate createdAt needed.
  { versionKey: false },
);

// History pages: newest first within a channel.
messageSchema.index({ channelId: 1, _id: -1 });
// The main timeline (threadRootId null) and each thread, newest first.
messageSchema.index({ channelId: 1, threadRootId: 1, _id: -1 });
messageSchema.index({ channelId: 1, pinnedAt: -1 }, { partialFilterExpression: { pinnedAt: { $type: 'date' } } });
// One clientId per author: a resend returns the message that was already saved.
messageSchema.index(
  { authorId: 1, clientId: 1 },
  { unique: true, partialFilterExpression: { clientId: { $type: 'string' } } },
);
// Full-text search. "none" keeps short words and doesn't stem (the chat mixes English and Nepali).
messageSchema.index({ text: 'text' }, { default_language: 'none', name: 'text_search' });

export const Message = model<MessageDoc>('Message', messageSchema);
