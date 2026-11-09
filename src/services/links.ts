import { type PagePreview, fetchPreview } from '../lib/link-preview.js';
import { LinkCache } from '../models/extras.js';
import type { PreviewFetcher } from './messages.js';

const DAY = 86_400_000;

/**
 * Link previews with a one-day cache, so a link shared in several messages (or one that
 * has nothing to show) is fetched once.
 */
export function cachedPreviews(fetch: (url: string) => Promise<PagePreview | null> = fetchPreview): PreviewFetcher {
  const inFlight = new Map<string, Promise<PagePreview | null>>();
  return async (url) => {
    if (url.length > 2000) return null;
    const cached = await LinkCache.findOne({ url }).lean();
    if (cached && cached.expiresAt.getTime() > Date.now()) return cached.preview;
    let job = inFlight.get(url);
    if (!job) {
      job = fetch(url).finally(() => inFlight.delete(url));
      inFlight.set(url, job);
    }
    const preview = await job;
    await LinkCache.updateOne(
      { url },
      { $set: { preview, expiresAt: new Date(Date.now() + (preview ? DAY : DAY / 4)) } },
      { upsert: true },
    ).catch(() => {});
    return preview;
  };
}
