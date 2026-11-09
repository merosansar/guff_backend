import { createCipheriv, createECDH, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';
import { SignJWT, importJWK } from 'jose';

/**
 * Web Push without a library: VAPID (RFC 8292) to say who is sending, and the
 * "aes128gcm" payload encryption (RFC 8291) so only the subscribed browser can read it.
 */

export interface VapidKeys {
  /** Uncompressed P-256 public key, base64url (65 bytes). This is what browsers get. */
  publicKey: string;
  /** The private scalar, base64url (32 bytes). */
  privateKey: string;
}

export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

const b64url = (buf: Buffer | Uint8Array) => Buffer.from(buf).toString('base64url');
const unb64url = (s: string) => Buffer.from(s, 'base64url');

export function generateVapidKeys(): VapidKeys {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = publicKey.export({ format: 'jwk' });
  const priv = privateKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), unb64url(pub.x!), unb64url(pub.y!)]);
  return { publicKey: b64url(raw), privateKey: priv.d! };
}

/**
 * Push services browsers actually use. Subscriptions pointing anywhere else are refused,
 * so nobody can make the server send requests to an address of their choosing.
 */
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^push\.services\.mozilla\.com$/,
  /(^|\.)notify\.windows\.com$/,
  /^web\.push\.apple\.com$/,
  /(^|\.)push\.apple\.com$/,
];

export function isPushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' && !url.port && PUSH_HOSTS.some((re) => re.test(url.hostname));
  } catch {
    return false;
  }
}

async function vapidHeader(endpoint: string, keys: VapidKeys, subject: string): Promise<string> {
  const pub = unb64url(keys.publicKey);
  const key = await importJWK(
    {
      kty: 'EC',
      crv: 'P-256',
      x: b64url(pub.subarray(1, 33)),
      y: b64url(pub.subarray(33, 65)),
      d: keys.privateKey,
    },
    'ES256',
  );
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', typ: 'JWT' })
    .setAudience(new URL(endpoint).origin)
    .setExpirationTime('12h')
    .setSubject(subject)
    .sign(key);
  return `vapid t=${jwt}, k=${keys.publicKey}`;
}

/** Encrypts a payload for one browser (RFC 8291, a single aes128gcm record). */
export function encryptPayload(target: PushTarget, payload: Buffer): Buffer {
  const uaPublic = unb64url(target.keys.p256dh);
  const authSecret = unb64url(target.keys.auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error('bad subscription keys');

  const ecdh = createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const sharedSecret = ecdh.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', sharedSecret, authSecret, keyInfo, 32));
  const salt = randomBytes(16);
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02 marks the last (and only) record.
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

export type PushResult = 'sent' | 'gone' | 'failed';

/** Sends one notification. "gone" means the browser unsubscribed: forget the subscription. */
export async function sendPush(
  target: PushTarget,
  data: unknown,
  keys: VapidKeys,
  subject: string,
): Promise<PushResult> {
  if (!isPushEndpoint(target.endpoint)) return 'gone';
  const body = encryptPayload(target, Buffer.from(JSON.stringify(data)));
  const res = await fetch(target.endpoint, {
    method: 'POST',
    headers: {
      authorization: await vapidHeader(target.endpoint, keys, subject),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: '86400',
      urgency: 'high',
    },
    body,
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
  });
  await res.arrayBuffer().catch(() => {});
  if (res.status === 404 || res.status === 410) return 'gone';
  return res.ok ? 'sent' : 'failed';
}
