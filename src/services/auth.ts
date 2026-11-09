import type { Logger } from 'pino';
import { Types } from 'mongoose';
import { badRequest, conflict, isDuplicateKey, tooMany, unauthorized } from '../lib/errors.js';
import { DUMMY_HASH_PROMISE, hashPassword, verifyPassword } from '../lib/password.js';
import { type TokenService, hashToken, newRefreshToken } from '../lib/tokens.js';
import { AuthToken, type AuthTokenDoc } from '../models/extras.js';
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
import type { Mailer } from './mail.js';
import type { PeopleService } from './people.js';

/** A rotated refresh token used again within this window is two tabs racing, not theft. */
const REUSE_GRACE_MS = 30_000;
const RESET_TTL_MS = 60 * 60_000;
const VERIFY_TTL_MS = 3 * 86_400_000;
/** One email of each kind per person per minute. */
const EMAIL_COOLDOWN_MS = 60_000;

export interface EmailOptions {
  mailer: Mailer;
  /** The website's address, for the links in emails. */
  appUrl: string;
  log: Logger;
}

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
    private readonly email: EmailOptions,
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
    // The account works straight away; confirming the address just adds a tick.
    this.sendVerification(user._id.toString()).catch((error: unknown) =>
      this.email.log.warn({ err: error }, 'verification email failed'),
    );
    return this.issue(user, userAgent);
  }

  // ---- forgotten passwords -------------------------------------------------------

  /**
   * Emails a reset link if the address has an account. The answer is the same either way,
   * so nobody can use this form to find out who has an account.
   */
  async forgotPassword(rawEmail: string): Promise<void> {
    const user = await User.findOne({ email: rawEmail.trim().toLowerCase() }).lean<UserDoc>();
    if (!user || user.demoBot) return;
    const token = await this.newToken(user._id, 'reset', RESET_TTL_MS);
    if (!token) return;
    const link = `${this.email.appUrl}/reset-password?token=${token}`;
    await this.email.mailer.send({
      to: user.email,
      subject: 'Reset your Guff password',
      text:
        `Hi ${user.name.split(' ')[0]},\n\nSomeone (hopefully you) asked to reset your Guff password. ` +
        `Choose a new one here:\n\n${link}\n\nThe link works once, for the next hour. ` +
        'If you didn’t ask for this, you can ignore this email; your password hasn’t changed.',
    });
  }

  /** Sets a new password and signs the person out everywhere (a stolen session ends too). */
  async resetPassword(raw: string, password: string): Promise<void> {
    const token = await this.useToken(raw, 'reset');
    await User.updateOne({ _id: token.userId }, { $set: { passwordHash: await hashPassword(password) } });
    // Following the link proves the person reads that inbox.
    await User.updateOne({ _id: token.userId, emailVerifiedAt: null }, { $set: { emailVerifiedAt: new Date() } });
    await Session.updateMany({ userId: token.userId, revokedAt: null }, { $set: { revokedAt: new Date() } });
    await AuthToken.updateMany(
      { userId: token.userId, kind: 'reset', usedAt: null },
      { $set: { usedAt: new Date() } },
    );
  }

  // ---- confirming an email address -------------------------------------------------

  async sendVerification(userId: string): Promise<void> {
    const user = await User.findById(userId).lean<UserDoc>();
    if (!user) throw unauthorized();
    if (user.emailVerifiedAt) throw badRequest('Your email address is already confirmed.');
    const token = await this.newToken(user._id, 'verify', VERIFY_TTL_MS);
    if (!token) throw tooMany('We just sent you an email. Wait a minute before asking for another.');
    const link = `${this.email.appUrl}/verify-email?token=${token}`;
    await this.email.mailer.send({
      to: user.email,
      subject: 'Confirm your email for Guff',
      text:
        `Hi ${user.name.split(' ')[0]},\n\nWelcome to Guff! Confirm your email address so we can ` +
        `reach you if you ever forget your password:\n\n${link}\n\nThe link works for three days.`,
    });
  }

  async verifyEmail(raw: string): Promise<void> {
    const token = await this.useToken(raw, 'verify');
    await User.updateOne({ _id: token.userId, emailVerifiedAt: null }, { $set: { emailVerifiedAt: new Date() } });
    const user = await User.findById(token.userId).lean<UserDoc>();
    if (user) this.bus.toUser(user._id.toString(), 'user:upsert', await this.people.withPresence(user));
  }

  /** Makes a one-time token and stores only its hash. Null when one was sent a moment ago. */
  private async newToken(
    userId: Types.ObjectId,
    kind: 'reset' | 'verify',
    ttlMs: number,
  ): Promise<string | null> {
    const recent = await AuthToken.exists({
      userId,
      kind,
      createdAt: { $gt: new Date(Date.now() - EMAIL_COOLDOWN_MS) },
    });
    if (recent) return null;
    const token = newRefreshToken();
    await AuthToken.create({
      userId,
      kind,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + ttlMs),
    });
    return token;
  }

  /** Marks a token used, atomically, so the same link can't be used twice at once. */
  private async useToken(raw: string, kind: 'reset' | 'verify'): Promise<AuthTokenDoc> {
    const token = await AuthToken.findOneAndUpdate(
      { tokenHash: hashToken(raw), kind, usedAt: null, expiresAt: { $gt: new Date() } },
      { $set: { usedAt: new Date() } },
      { returnDocument: 'after' },
    ).lean<AuthTokenDoc>();
    if (!token) {
      throw badRequest(
        kind === 'reset'
          ? 'This reset link has expired or was already used. Ask for a new one.'
          : 'This confirmation link has expired or was already used.',
      );
    }
    return token;
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
