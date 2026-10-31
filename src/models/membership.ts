import { Schema, model, type Types } from 'mongoose';

export interface MembershipDoc {
  _id: Types.ObjectId;
  channelId: Types.ObjectId;
  userId: Types.ObjectId;
  role: 'owner' | 'member';
  /** The newest message this person has seen in the channel. Unread = messages after it. */
  lastReadId: Types.ObjectId | null;
  joinedAt: Date;
}

const membershipSchema = new Schema<MembershipDoc>({
  channelId: { type: Schema.Types.ObjectId, ref: 'Channel', required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  role: { type: String, enum: ['owner', 'member'], default: 'member' },
  lastReadId: { type: Schema.Types.ObjectId, default: null },
  joinedAt: { type: Date, default: () => new Date() },
});

membershipSchema.index({ channelId: 1, userId: 1 }, { unique: true });
membershipSchema.index({ userId: 1 });

export const Membership = model<MembershipDoc>('Membership', membershipSchema);
