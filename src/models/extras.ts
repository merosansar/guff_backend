import { Schema, model, type Types } from 'mongoose';

/**
 * The smaller collections added with the newer features: saved messages, scheduled
 * messages and reminders, one-time email tokens, push subscriptions, webhooks, a cache
 * of link previews, and a few server settings.
 */

// ---- saved messages ------------------------------------------------------------------

export interface BookmarkDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  messageId: Types.ObjectId;
  channelId: Types.ObjectId;
  createdAt: Date;
}

const bookmarkSchema = new Schema<BookmarkDoc>({
  userId: { type: Schema.Types.ObjectId, required: true },
  messageId: { type: Schema.Types.ObjectId, required: true },
  channelId: { type: Schema.Types.ObjectId, required: true },
  createdAt: { type: Date, default: () => new Date() },
});
bookmarkSchema.index({ userId: 1, messageId: 1 }, { unique: true });
bookmarkSchema.index({ userId: 1, createdAt: -1 });

export const Bookmark = model<BookmarkDoc>('Bookmark', bookmarkSchema);

// ---- scheduled messages and reminders -----------------------------------------------------

export interface ScheduledDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  /** "message": send this text later. "reminder": nudge me about a message later. */
  kind: 'message' | 'reminder';
  channelId: Types.ObjectId;
  text: string;
  threadRootId: Types.ObjectId | null;
  /** For reminders: the message to be reminded about. */
  messageId: Types.ObjectId | null;
  sendAt: Date;
  status: 'pending' | 'sending' | 'sent' | 'failed';
  error: string | null;
  claimedAt: Date | null;
  createdAt: Date;
}

const scheduledSchema = new Schema<ScheduledDoc>({
  userId: { type: Schema.Types.ObjectId, required: true },
  kind: { type: String, enum: ['message', 'reminder'], required: true },
  channelId: { type: Schema.Types.ObjectId, required: true },
  text: { type: String, default: '', maxlength: 4000 },
  threadRootId: { type: Schema.Types.ObjectId, default: null },
  messageId: { type: Schema.Types.ObjectId, default: null },
  sendAt: { type: Date, required: true },
  status: { type: String, enum: ['pending', 'sending', 'sent', 'failed'], default: 'pending' },
  error: { type: String, default: null },
  claimedAt: { type: Date, default: null },
  createdAt: { type: Date, default: () => new Date() },
});
scheduledSchema.index({ status: 1, sendAt: 1 });
scheduledSchema.index({ userId: 1, status: 1, sendAt: 1 });

export const Scheduled = model<ScheduledDoc>('Scheduled', scheduledSchema);

// ---- one-time email tokens ------------------------------------------------------------------

export interface AuthTokenDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  kind: 'reset' | 'verify';
  /** SHA-256 of the token in the emailed link. */
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

const authTokenSchema = new Schema<AuthTokenDoc>({
  userId: { type: Schema.Types.ObjectId, required: true },
  kind: { type: String, enum: ['reset', 'verify'], required: true },
  tokenHash: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true },
  usedAt: { type: Date, default: null },
  createdAt: { type: Date, default: () => new Date() },
});
authTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
authTokenSchema.index({ userId: 1, kind: 1, createdAt: -1 });

export const AuthToken = model<AuthTokenDoc>('AuthToken', authTokenSchema);

// ---- web push --------------------------------------------------------------------------------

export interface PushSubscriptionDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  createdAt: Date;
}

const pushSchema = new Schema<PushSubscriptionDoc>({
  userId: { type: Schema.Types.ObjectId, required: true, index: true },
  endpoint: { type: String, required: true, unique: true, maxlength: 1000 },
  keys: {
    p256dh: { type: String, required: true, maxlength: 200 },
    auth: { type: String, required: true, maxlength: 100 },
  },
  createdAt: { type: Date, default: () => new Date() },
});

export const PushSubscription = model<PushSubscriptionDoc>('PushSubscription', pushSchema);

// ---- incoming webhooks ---------------------------------------------------------------------------

export interface WebhookDoc {
  _id: Types.ObjectId;
  channelId: Types.ObjectId;
  name: string;
  /** SHA-256 of the secret part of the webhook URL. */
  tokenHash: string;
  createdBy: Types.ObjectId;
  createdAt: Date;
  lastUsedAt: Date | null;
}

const webhookSchema = new Schema<WebhookDoc>({
  channelId: { type: Schema.Types.ObjectId, required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 40 },
  tokenHash: { type: String, required: true },
  createdBy: { type: Schema.Types.ObjectId, required: true },
  createdAt: { type: Date, default: () => new Date() },
  lastUsedAt: { type: Date, default: null },
});

export const Webhook = model<WebhookDoc>('Webhook', webhookSchema);

// ---- link preview cache ---------------------------------------------------------------------------

export interface LinkCacheDoc {
  _id: Types.ObjectId;
  url: string;
  /** null when the page had nothing worth showing (so it isn't fetched again for a while). */
  preview: { title: string; description: string; image: string | null; siteName: string } | null;
  expiresAt: Date;
}

const linkCacheSchema = new Schema<LinkCacheDoc>({
  url: { type: String, required: true, unique: true },
  preview: { type: Schema.Types.Mixed, default: null },
  expiresAt: { type: Date, required: true },
});
linkCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const LinkCache = model<LinkCacheDoc>('LinkCache', linkCacheSchema);

// ---- server settings (e.g. the generated web push keys) -----------------------------------------------

export interface SettingDoc {
  _id: string;
  value: unknown;
}

const settingSchema = new Schema<SettingDoc>({
  _id: { type: String, required: true },
  value: { type: Schema.Types.Mixed },
});

export const Setting = model<SettingDoc>('Setting', settingSchema);
