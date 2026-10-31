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
}

export const toPublicUser = (
  u: Pick<UserDoc, '_id' | 'name' | 'email' | 'title' | 'color' | 'lastSeenAt'>,
): PublicUser => ({
  id: u._id.toString(),
  name: u.name,
  email: u.email,
  title: u.title,
  color: u.color,
  lastSeenAt: u.lastSeenAt ? u.lastSeenAt.toISOString() : null,
});
