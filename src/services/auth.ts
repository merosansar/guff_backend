import { Types } from 'mongoose';
import { conflict, isDuplicateKey, unauthorized } from '../lib/errors.js';
import { DUMMY_HASH_PROMISE, hashPassword, verifyPassword } from '../lib/password.js';
import { type TokenService, hashToken, newRefreshToken } from '../lib/tokens.js';
import { Session, type SessionDoc } from '../models/session.js';
import {
  AVATAR_COLORS,
  type PublicUser,
  User,
  type UserDoc,
  toPublicUser,
} from '../models/user.js';
import type { RealtimeBus } from '../realtime/bus.js';
import type { ChannelService } from './channels.js';
import type { PeopleService } from './people.js';

/** A rotated refresh token used again within this window is two tabs racing, not theft. */
const REUSE_GRACE_MS = 30_000;

export interface SessionResult {
  session: { accessToken: string; expiresIn: number; user: PublicUser };
  refreshToken: string;
}

export class AuthService {
  constructor(
    private readonly tokens: TokenService,
    private readonly refreshTtlDays: number,
    private readonly channels: ChannelService,
    private readonly people: PeopleService,
    private readonly bus: RealtimeBus,
  ) {}

  get refreshTtlMs(): number {
    return this.refreshTtlDays * 86_400_000;
  }

  async register(
    input: { name: string; email: string; password: string },
    userAgent?: string,
  ): Promise<SessionResult> {
    const email = input.email.trim().toLowerCase();
    if (await User.exists({ email }))
      throw conflict('That email already has an account. Sign in instead.');
    const count = await User.countDocuments();
    let user: UserDoc;
    try {
      user = (
        await User.create({
          email,
          name: input.name.trim(),
          passwordHash: await hashPassword(input.password),
          color: AVATAR_COLORS[count % AVATAR_COLORS.length],
        })
      ).toObject();
    } catch (error) {
      if (isDuplicateKey(error))
        throw conflict('That email already has an account. Sign in instead.');
      throw error;
    }
    this.bus.toAll('user:upsert', await this.people.withPresence(user));
    await this.channels.joinDefaults(user._id.toString());
    return this.issue(user, userAgent);
  }

  async login(
    input: { email: string; password: string },
    userAgent?: string,
  ): Promise<SessionResult> {
    const user = await User.findOne({ email: input.email.trim().toLowerCase() })
      .select('+passwordHash')
      .lean<UserDoc>();
    // Unknown emails take as long as wrong passwords, so the response time gives nothing away.
    const ok = await verifyPassword(
      input.password,
      user?.passwordHash ?? (await DUMMY_HASH_PROMISE),
    );
    if (!user || !ok) throw unauthorized('That email and password don’t match.');
    return this.issue(user, userAgent);
  }

  /**
   * Swaps a refresh token for a new one. Presenting an already-used token again (outside
   * the grace window) means it was copied, so every session of that person is ended.
   */
  async refresh(raw: string | undefined, userAgent?: string): Promise<SessionResult> {
    if (!raw) throw unauthorized();
    const current = await Session.findOne({ tokenHash: hashToken(raw) }).lean<SessionDoc>();
    if (!current || current.expiresAt.getTime() < Date.now()) {
      throw unauthorized('Your session has expired. Sign in again.');
    }
    const user = await User.findById(current.userId).lean<UserDoc>();
    if (!user) throw unauthorized();

    if (!current.revokedAt) {
      const nextId = new Types.ObjectId();
      const rotated = await Session.updateOne(
        { _id: current._id, revokedAt: null },
        { $set: { revokedAt: new Date(), replacedBy: nextId } },
      );
      if (rotated.modifiedCount === 1) return this.issue(user, userAgent, nextId);
      // Another tab rotated it a moment ago; fall through to the grace check.
    }

    const latest = await Session.findById(current._id).lean<SessionDoc>();
    const revokedAt = latest?.revokedAt?.getTime() ?? 0;
    if (latest?.replacedBy && Date.now() - revokedAt <= REUSE_GRACE_MS) {
      return this.issue(user, userAgent);
    }
    await Session.updateMany(
      { userId: current.userId, revokedAt: null },
      { $set: { revokedAt: new Date() } },
    );
    throw unauthorized('Your session ended. Sign in again.');
  }

  async logout(raw: string | undefined): Promise<void> {
    if (!raw) return;
    await Session.updateOne(
      { tokenHash: hashToken(raw), revokedAt: null },
      { $set: { revokedAt: new Date() } },
    );
  }

  private async issue(
    user: UserDoc,
    userAgent?: string,
    id = new Types.ObjectId(),
  ): Promise<SessionResult> {
    const refreshToken = newRefreshToken();
    await Session.create({
      _id: id,
      userId: user._id,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + this.refreshTtlMs),
      userAgent: userAgent?.slice(0, 300) ?? null,
    });
    const access = await this.tokens.signAccess(user._id.toString());
    return {
      session: { accessToken: access.token, expiresIn: access.expiresIn, user: toPublicUser(user) },
      refreshToken,
    };
  }
}
