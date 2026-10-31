import { Schema, model, type Types } from 'mongoose';

export interface SessionDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  /** SHA-256 of the refresh token. The token itself only lives in the httpOnly cookie. */
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedBy: Types.ObjectId | null;
  userAgent: string | null;
}

const sessionSchema = new Schema<SessionDoc>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true },
  revokedAt: { type: Date, default: null },
  replacedBy: { type: Schema.Types.ObjectId, default: null },
  userAgent: { type: String, default: null, maxlength: 300 },
});

// MongoDB deletes expired sessions by itself (TTL index).
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Session = model<SessionDoc>('Session', sessionSchema);
