/**
 * Message text is plain text with a few conventions the app renders:
 * mentions are stored as <@userId>, plus **bold**, _italic_, `code` and ``` blocks.
 */

const MENTION = /<@([a-f\d]{24})>/gi;

export function extractMentionIds(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(MENTION)) ids.add(match[1]!.toLowerCase());
  return [...ids];
}

/** The first web link in a message (not inside code), for a preview. */
export function firstUrl(text: string): string | null {
  const withoutCode = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
  const match = /https?:\/\/[^\s<>]*[^\s<>.,:;"')\]!?]/i.exec(withoutCode);
  return match ? match[0] : null;
}

/** Unix line endings, no trailing spaces on lines, nothing blank at the start or end. */
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/u, ''))
    .join('\n')
    .replace(/^\s+|\n+$/g, '')
    .replace(/\n{4,}/g, '\n\n\n');
}

/** A one-line copy for reply quotes: formatting removed, mentions kept, cut at a word. */
export function excerpt(text: string, max = 140): string {
  const flat = text
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= max) return flat;
  let cut = flat.slice(0, max);
  // Don't leave half a mention token at the end.
  const open = cut.lastIndexOf('<@');
  if (open !== -1 && cut.indexOf('>', open) === -1) cut = cut.slice(0, open);
  const space = cut.lastIndexOf(' ');
  if (space > max * 0.6) cut = cut.slice(0, space);
  return `${cut.trimEnd()}…`;
}

/** "Launch Plan 2026!" → "launch-plan-2026". Empty when nothing usable is left. */
export function channelSlug(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
    .replace(/-$/, '');
}
