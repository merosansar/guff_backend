import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { SignJWT, errors as joseErrors, jwtVerify } from 'jose';
import { unauthorized } from './errors.js';

export interface AccessClaims {
  userId: string;
  /** Expiry, seconds since the epoch. */
  exp: number;
}

export class TokenService {
  private readonly key: Uint8Array;
  private readonly fileKey: Buffer;

  constructor(
    secret: string,
    private readonly accessTtlSeconds: number,
  ) {
    this.key = new TextEncoder().encode(secret);
    // A separate key for file links, so a leaked file URL says nothing about the JWT key.
    this.fileKey = createHmac('sha256', secret).update('guff-file-links').digest();
  }

  async signAccess(userId: string): Promise<{ token: string; expiresIn: number }> {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime(`${this.accessTtlSeconds}s`)
      .sign(this.key);
    return { token, expiresIn: this.accessTtlSeconds };
  }

  async verifyAccess(token: string): Promise<AccessClaims> {
    try {
      const { payload } = await jwtVerify(token, this.key, { algorithms: ['HS256'] });
      if (!payload.sub || typeof payload.exp !== 'number') throw unauthorized();
      return { userId: payload.sub, exp: payload.exp };
    } catch (error) {
      if (error instanceof joseErrors.JWTExpired) throw unauthorized('Your session expired.');
      throw unauthorized();
    }
  }

  /**
   * Attachment links are signed and expire, so files are never public but still work in
   * an <img> tag (which can't send an Authorization header). The expiry is rounded to
   * the day, so the same file keeps the same URL and the browser can cache it.
   */
  signFileUrl(fileId: string, now = Date.now()): string {
    const day = 86_400_000;
    const exp = Math.floor(now / day) * day + 2 * day;
    return `/api/files/${fileId}?exp=${exp}&sig=${this.fileSignature(fileId, exp)}`;
  }

  verifyFileSignature(fileId: string, exp: number, sig: string, now = Date.now()): boolean {
    if (!Number.isFinite(exp) || exp < now) return false;
    const expected = Buffer.from(this.fileSignature(fileId, exp));
    const actual = Buffer.from(sig);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private fileSignature(fileId: string, exp: number): string {
    return createHmac('sha256', this.fileKey).update(`${fileId}.${exp}`).digest('base64url');
  }
}

/** Refresh tokens are random strings; only their SHA-256 hash is stored. */
export const newRefreshToken = (): string => randomBytes(32).toString('base64url');
export const hashToken = (raw: string): string => createHash('sha256').update(raw).digest('hex');
