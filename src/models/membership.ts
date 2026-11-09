import { Schema, model, type Types } from 'mongoose';

export const ROLES = ['owner', 'admin', 'member'] as const;
export type Role = (typeof ROLES)[number];

/**
 * "all": notify about every message. "mentions": the default; DMs and @mentions only.
 * "mute": no notifications at all (mentions still get a badge).
 */
export const NOTIFY_LEVELS = ['all', 'mentions', 'mute'] as const;
export type NotifyLevel = (typeof NOTIFY_LEVELS)[number];

export interface MembershipDoc {
  _id: Types.ObjectId;
  channelId: Types.ObjectId;
  userId: Types.ObjectId;
  /** Owners and admins can rename, archive, remove people and delete any message. */
  role: Role;
  notify: NotifyLevel;
  /** The newest message this person has seen in the channel. Unread = messages after it. */
  lastReadId: Types.ObjectId | null;
  joinedAt: Date;
}

const membershipSchema = new Schema<MembershipDoc>({
  channelId: { type: Schema.Types.ObjectId, ref: 'Channel', required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  role: { type: String, enum: ROLES, default: 'member' },
  notify: { type: String, enum: NOTIFY_LEVELS, default: 'mentions' },
  lastReadId: { type: Schema.Types.ObjectId, default: null },
  joinedAt: { type: Date, default: () => new Date() },
});

membershipSchema.index({ channelId: 1, userId: 1 }, { unique: true });
membershipSchema.index({ userId: 1 });

export const Membership = model<MembershipDoc>('Membership', membershipSchema);
