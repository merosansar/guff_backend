import { Schema, model, type Types } from 'mongoose';

export const CHANNEL_KINDS = ['public', 'private', 'dm'] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

export interface ChannelDoc {
  _id: Types.ObjectId;
  kind: ChannelKind;
  /** Lower-case slug for public and private channels; empty for DMs. */
  name: string;
  topic: string;
  createdBy: Types.ObjectId;
  /** New people join default channels automatically. */
  isDefault: boolean;
  /** "idA:idB" with the ids sorted, so one pair of people has exactly one DM. */
  dmKey: string | null;
  memberCount: number;
  lastMessageAt: Date | null;
  /** Archived channels stay readable but nobody can post in them. */
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const channelSchema = new Schema<ChannelDoc>(
  {
    kind: { type: String, enum: CHANNEL_KINDS, required: true },
    name: { type: String, trim: true, maxlength: 40, default: '' },
    topic: { type: String, trim: true, maxlength: 250, default: '' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    isDefault: { type: Boolean, default: false },
    dmKey: { type: String, default: null },
    memberCount: { type: Number, default: 0, min: 0 },
    lastMessageAt: { type: Date, default: null },
    archivedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Channel names are unique; DMs have no name. Partial indexes keep the two rules apart.
channelSchema.index(
  { name: 1 },
  { unique: true, partialFilterExpression: { kind: { $in: ['public', 'private'] } } },
);
channelSchema.index({ dmKey: 1 }, { unique: true, partialFilterExpression: { kind: 'dm' } });
channelSchema.index({ kind: 1, name: 1 });

export const Channel = model<ChannelDoc>('Channel', channelSchema);

export const dmKeyFor = (a: string, b: string): string => [a, b].sort().join(':');
