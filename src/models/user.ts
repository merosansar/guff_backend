import { Schema, model, type Types } from 'mongoose';

/** Avatar colours, picked in order at sign-up so neighbours in the list differ. */
export const AVATAR_COLORS = [
  'indigo',
  'teal',
  'rose',
  'amber',
  'sky',
  'violet',
  'green',
  'orange',
] as const;
export type AvatarColor = (typeof AVATAR_COLORS)[number];

export interface CustomStatus {
  emoji: string;
  text: string;
  /** When the status clears itself; null keeps it until changed. */
  expiresAt: Date | null;
}

export interface UserDoc {
  _id: Types.ObjectId;
  email: string;
  name: string;
  title: string;
  passwordHash: string;
  color: AvatarColor;
  /** A seeded teammate who answers DMs and mentions while nobody is signed in as them. */
  demoBot: boolean;
  lastSeenAt: Date | null;
  /** "🌴 On leave till Monday". */
  customStatus: CustomStatus | null;
  /** Do not disturb: no notifications or push until this time. */
  dndUntil: Date | null;
  emailVerifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<UserDoc>(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    title: { type: String, trim: true, maxlength: 80, default: '' },
    passwordHash: { type: String, required: true, select: false },
    color: { type: String, enum: AVATAR_COLORS, required: true },
    demoBot: { type: Boolean, default: false },
    lastSeenAt: { type: Date, default: null },
    customStatus: {
      type: new Schema<CustomStatus>(
        {
          emoji: { type: String, default: '', maxlength: 16 },
          text: { type: String, default: '', trim: true, maxlength: 100 },
          expiresAt: { type: Date, default: null },
        },
        { _id: false },
      ),
      default: null,
    },
    dndUntil: { type: Date, default: null },
    emailVerifiedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export const User = model<UserDoc>('User', userSchema);

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  title: string;
  color: AvatarColor;
  lastSeenAt: string | null;
  customStatus: { emoji: string; text: string; expiresAt: string | null } | null;
  dndUntil: string | null;
  emailVerified: boolean;
}

/** A status or do-not-disturb that has run out counts as cleared. */
export function activeStatus(u: Pick<UserDoc, 'customStatus'>, now = Date.now()) {
  const s = u.customStatus;
  if (!s || (!s.emoji && !s.text)) return null;
  if (s.expiresAt && s.expiresAt.getTime() <= now) return null;
  return s;
}

export const isDnd = (u: Pick<UserDoc, 'dndUntil'>, now = Date.now()) =>
  !!u.dndUntil && u.dndUntil.getTime() > now;

export const toPublicUser = (
  u: Pick<UserDoc, '_id' | 'name' | 'email' | 'title' | 'color' | 'lastSeenAt'> &
    Partial<Pick<UserDoc, 'customStatus' | 'dndUntil' | 'emailVerifiedAt'>>,
): PublicUser => {
  const status = activeStatus({ customStatus: u.customStatus ?? null });
  return {
    id: u._id.toString(),
    name: u.name,
    email: u.email,
    title: u.title,
    color: u.color,
    lastSeenAt: u.lastSeenAt ? u.lastSeenAt.toISOString() : null,
    customStatus: status
      ? {
          emoji: status.emoji,
          text: status.text,
          expiresAt: status.expiresAt ? status.expiresAt.toISOString() : null,
        }
      : null,
    dndUntil: u.dndUntil && isDnd({ dndUntil: u.dndUntil }) ? u.dndUntil.toISOString() : null,
    emailVerified: !!u.emailVerifiedAt,
  };
};
