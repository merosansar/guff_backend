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
}

const attachmentSchema = new Schema<Attachment>(
  {
    fileId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true },
    size: { type: Number, required: true },
    contentType: { type: String, required: true },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
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
  },
  // ObjectIds already carry the creation time; no separate createdAt needed.
  { versionKey: false },
);

// History pages: newest first within a channel.
messageSchema.index({ channelId: 1, _id: -1 });
// One clientId per author: a resend returns the message that was already saved.
messageSchema.index(
  { authorId: 1, clientId: 1 },
  { unique: true, partialFilterExpression: { clientId: { $type: 'string' } } },
);
// Full-text search. "none" keeps short words and doesn't stem (the chat mixes English and Nepali).
messageSchema.index({ text: 'text' }, { default_language: 'none', name: 'text_search' });

export const Message = model<MessageDoc>('Message', messageSchema);
