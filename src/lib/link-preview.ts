import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

/**
 * Fetches a page's title, description and image for a link preview.
 *
 * The server fetches URLs that people type, so it must never be tricked into calling
 * something private (server-side request forgery): only http(s) on the usual ports,
 * every address a name resolves to must be public (checked in the DNS lookup the request
 * actually uses, so a second lookup can't swap in a private address), redirects are
 * checked one by one, and size and time are capped.
 */

export interface PagePreview {
  title: string;
  description: string;
  image: string | null;
  siteName: string;
}

const MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;

const blocked = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  blocked.addSubnet(net, bits, 'ipv6');

/** True for addresses on the public internet. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  if (family === 6) {
    // ::ffff:10.0.0.1 is an IPv4 address in disguise.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return isPublicAddress(mapped[1]!);
    return !blocked.check(address, 'ipv6');
  }
  return false;
}

class BlockedError extends Error {}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/** A DNS lookup that refuses names pointing at private addresses. */
function safeLookup(hostname: string, options: { all?: boolean }, callback: LookupCallback) {
  dnsLookup(hostname, { all: true }, (err, addresses) => {
    if (err) return callback(err, []);
    if (addresses.length === 0 || addresses.some((a) => !isPublicAddress(a.address))) {
      return callback(new BlockedError(`${hostname} points to a private address`), []);
    }
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0]!.address, addresses[0]!.family);
  });
}

function checkUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BlockedError('not http');
  if (url.username || url.password) throw new BlockedError('credentials in URL');
  if (url.port && url.port !== '80' && url.port !== '443') throw new BlockedError('unusual port');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !isPublicAddress(host)) throw new BlockedError('private address');
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(host))
    throw new BlockedError('local name');
  return url;
}

function get(url: URL): Promise<IncomingMessage> {
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'GET',
        lookup: safeLookup as never,
        timeout: TIMEOUT_MS,
        headers: {
          'user-agent': 'GuffLinkPreview/1.0 (+https://github.com/merosansar)',
          accept: 'text/html,application/xhtml+xml',
          'accept-language': 'en',
        },
      },
      resolve,
    );
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end();
  });
}

/** Downloads the start of an HTML page (following a few checked redirects). */
export async function fetchHtml(raw: string): Promise<{ html: string; url: URL } | null> {
  let url = checkUrl(raw);
  const deadline = Date.now() + TIMEOUT_MS * 2;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await get(url);
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      url = checkUrl(new URL(res.headers.location, url).toString());
      continue;
    }
    const type = String(res.headers['content-type'] ?? '');
    if (status !== 200 || !/text\/html|application\/xhtml/i.test(type)) {
      res.resume();
      return null;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res) {
      chunks.push(chunk as Buffer);
      size += (chunk as Buffer).length;
      // The <head> is all we need; stop early on big pages.
      if (size >= MAX_BYTES || Date.now() > deadline) {
        res.destroy();
        break;
      }
    }
    const charset = /charset=([\w-]+)/i.exec(type)?.[1] ?? 'utf-8';
    let html: string;
    try {
      html = new TextDecoder(charset).decode(Buffer.concat(chunks));
    } catch {
      html = Buffer.concat(chunks).toString('utf8');
    }
    return { html, url };
  }
  return null;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
};

function decode(text: string): string {
  return text
    .replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (whole, code: string) => {
      if (code[0] === '#') {
        const n = code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
      }
      return ENTITIES[code.toLowerCase()] ?? whole;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/** Reads Open Graph / Twitter / plain meta tags out of a page's HTML. */
export function parsePreview(html: string, pageUrl: URL): PagePreview | null {
  const head = html.slice(0, MAX_BYTES).split(/<\/head>/i)[0] ?? '';
  const meta = new Map<string, string>();
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const attr = (name: string) =>
      new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
    const key = attr('property') ?? attr('name');
    const content = attr('content');
    if (!key || !content) continue;
    const k = (key[2] ?? key[3] ?? key[4] ?? '').toLowerCase();
    const v = content[2] ?? content[3] ?? content[4] ?? '';
    if (k && !meta.has(k)) meta.set(k, decode(v));
  }
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  const title = meta.get('og:title') ?? meta.get('twitter:title') ?? (titleTag ? decode(titleTag) : '');
  const description =
    meta.get('og:description') ?? meta.get('twitter:description') ?? meta.get('description') ?? '';
  let image: string | null = null;
  const rawImage = meta.get('og:image') ?? meta.get('og:image:url') ?? meta.get('twitter:image');
  if (rawImage) {
    try {
      const resolved = new URL(rawImage, pageUrl);
      // Only https images: the browser loads them directly, and mixed content is blocked.
      if (resolved.protocol === 'https:') image = resolved.toString();
    } catch {
      /* not a URL */
    }
  }
  const siteName = meta.get('og:site_name') ?? pageUrl.hostname.replace(/^www\./, '');
  if (!title && !description) return null;
  return {
    title: clip(title, 140),
    description: clip(description, 280),
    image: image && image.length <= 1000 ? image : null,
    siteName: clip(siteName, 60),
  };
}

export async function fetchPreview(url: string): Promise<PagePreview | null> {
  try {
    const page = await fetchHtml(url);
    return page ? parsePreview(page.html, page.url) : null;
  } catch {
    return null;
  }
}
