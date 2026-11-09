import { createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';
import { isPublicAddress, parsePreview } from './link-preview.js';
import { encryptPayload, generateVapidKeys, isPushEndpoint } from './web-push.js';

describe('link previews refuse private addresses', () => {
  it.each([
    ['127.0.0.1', false],
    ['10.1.2.3', false],
    ['172.20.0.1', false],
    ['192.168.1.10', false],
    ['169.254.169.254', false],
    ['::1', false],
    ['fd00::1', false],
    ['::ffff:10.0.0.1', false],
    ['93.184.216.34', true],
    ['2606:4700:4700::1111', true],
  ])('%s → public: %s', (ip, expected) => {
    expect(isPublicAddress(ip)).toBe(expected);
  });
});

describe('reading previews out of HTML', () => {
  it('prefers Open Graph tags, decodes entities, keeps only https images', () => {
    const html = `<html><head><title>Fallback</title>
      <meta property="og:title" content="Guff &amp; friends">
      <meta name="description" content="Team chat">
      <meta property="og:image" content="/cover.png"></head><body>…</body></html>`;
    const preview = parsePreview(html, new URL('https://example.com/post'));
    expect(preview).toEqual({
      title: 'Guff & friends',
      description: 'Team chat',
      image: 'https://example.com/cover.png',
      siteName: 'example.com',
    });
    expect(parsePreview('<html><head></head></html>', new URL('https://example.com'))).toBeNull();
    const insecure = parsePreview('<meta property="og:title" content="x"><meta property="og:image" content="http://a.b/c.png">', new URL('http://a.b'));
    expect(insecure?.image).toBeNull();
  });
});

describe('web push', () => {
  it('only sends to real push services', () => {
    expect(isPushEndpoint('https://fcm.googleapis.com/fcm/send/abc')).toBe(true);
    expect(isPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/abc')).toBe(true);
    expect(isPushEndpoint('https://evil.example.com/fcm.googleapis.com')).toBe(false);
    expect(isPushEndpoint('http://fcm.googleapis.com/x')).toBe(false);
    expect(isPushEndpoint('https://127.0.0.1/x')).toBe(false);
  });

  it('makes VAPID keys of the right size', () => {
    const keys = generateVapidKeys();
    expect(Buffer.from(keys.publicKey, 'base64url')).toHaveLength(65);
    expect(Buffer.from(keys.privateKey, 'base64url')).toHaveLength(32);
  });

  it('encrypts a payload that the browser side can decrypt (RFC 8291)', () => {
    const browser = createECDH('prime256v1');
    const uaPublic = browser.generateKeys();
    const auth = randomBytes(16);
    const target = {
      endpoint: 'https://fcm.googleapis.com/x',
      keys: { p256dh: uaPublic.toString('base64url'), auth: auth.toString('base64url') },
    };
    const body = encryptPayload(target, Buffer.from('{"title":"Hi"}'));

    // Decrypt the way a browser would.
    const salt = body.subarray(0, 16);
    const idLen = body.readUInt8(20);
    const asPublic = body.subarray(21, 21 + idLen);
    const cipherText = body.subarray(21 + idLen);
    const shared = browser.computeSecret(asPublic);
    const info = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
    const ikm = Buffer.from(hkdfSync('sha256', shared, auth, info, 32));
    const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
    decipher.setAuthTag(cipherText.subarray(-16));
    const plain = Buffer.concat([decipher.update(cipherText.subarray(0, -16)), decipher.final()]);
    expect(plain.subarray(0, -1).toString()).toBe('{"title":"Hi"}');
    expect(plain.at(-1)).toBe(2);
  });
});
