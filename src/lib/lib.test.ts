import { resolveWhen } from '../seed/seed.js';
import { chooseReply } from '../services/demo-replies.js';
import { tidyConnectionString } from './mongo.js';
import { TokenBucket } from './rate-limiter.js';
import { channelSlug, excerpt, extractMentionIds, normalizeText } from './text.js';
import { TokenService } from './tokens.js';

describe('message text', () => {
  it('finds each mentioned person once', () => {
    const a = 'a'.repeat(24);
    const b = 'B'.repeat(24);
    expect(extractMentionIds(`<@${a}> hi <@${b}> and <@${a}> again, not <@123>`)).toEqual([
      a,
      'b'.repeat(24),
    ]);
  });

  it('normalises line endings and blank space', () => {
    expect(normalizeText('\n\n  hello  \r\nworld\t\n\n\n\n\nbye\n\n')).toBe(
      'hello\nworld\n\n\nbye',
    );
  });

  it('makes one-line excerpts that never cut a mention in half', () => {
    expect(excerpt('**Bold** and `code`\nnext line')).toBe('Bold and code next line');
    expect(excerpt('```\nconst x = 1\n``` done')).toBe('[code] done');
    const mention = `<@${'c'.repeat(24)}>`;
    const cut = excerpt(`${'word '.repeat(26)}${mention} tail`, 140);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut).not.toContain('<@c');
  });

  it('turns any name into a channel slug', () => {
    expect(channelSlug('Launch Plan 2026!')).toBe('launch-plan-2026');
    expect(channelSlug('  Café   Ñandú__team ')).toBe('cafe-nandu-team');
    expect(channelSlug('नेपाली')).toBe('');
    expect(channelSlug('x'.repeat(39) + '-yz')).toBe('x'.repeat(39));
  });
});

describe('TokenBucket', () => {
  it('allows a burst, then refills over time', () => {
    let now = 0;
    const bucket = new TokenBucket(3, 1, () => now);
    expect([bucket.take(), bucket.take(), bucket.take(), bucket.take()]).toEqual([
      true,
      true,
      true,
      false,
    ]);
    now = 1000;
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
  });
});

describe('signed file links', () => {
  const tokens = new TokenService('x'.repeat(40), 900);
  const id = 'f'.repeat(24);

  it('verifies its own links and keeps the URL stable within a day', () => {
    const url = tokens.signFileUrl(id, Date.UTC(2026, 9, 29, 1));
    expect(tokens.signFileUrl(id, Date.UTC(2026, 9, 29, 23))).toBe(url);
    const params = new URL(url, 'http://x').searchParams;
    expect(
      tokens.verifyFileSignature(
        id,
        Number(params.get('exp')),
        params.get('sig')!,
        Date.UTC(2026, 9, 30),
      ),
    ).toBe(true);
  });

  it('rejects another file, a changed expiry or an old link', () => {
    const url = tokens.signFileUrl(id, Date.UTC(2026, 9, 29));
    const params = new URL(url, 'http://x').searchParams;
    const exp = Number(params.get('exp'));
    const sig = params.get('sig')!;
    expect(tokens.verifyFileSignature('e'.repeat(24), exp, sig)).toBe(false);
    expect(tokens.verifyFileSignature(id, exp + 1, sig, Date.UTC(2026, 9, 29))).toBe(false);
    expect(tokens.verifyFileSignature(id, exp, sig, exp + 1)).toBe(false);
  });
});

describe('demo replies', () => {
  it('answers in context', () => {
    expect(chooseReply('Namaste!', 'nima@guff.local', 'Aarav', 0)).toBe(
      'Namaste Aarav! 🙏 What’s up?',
    );
    expect(chooseReply('thanks a lot', 'nima@guff.local', 'Aarav', 0)).toBe('Anytime! 🙌');
    expect(chooseReply('momo for lunch?', 'nima@guff.local', 'Aarav', 2)).toBe(
      'Only if there’s sel roti 😄',
    );
    expect(chooseReply('the android build crashed', 'nima@guff.local', 'Aarav', 0)).toBe(
      'Testing it on my Android phone now 📱',
    );
  });
});

function problem(s: string) {
  const r = tidyConnectionString(s);
  return r.ok ? null : r.problem;
}

describe('pasted connection strings', () => {
  const tail = '@cluster0.x1y2z.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';

  it('keeps a good string as it is', () => {
    expect(tidyConnectionString(`mongodb+srv://guff_app:Abc123${tail}`)).toEqual({
      ok: true,
      uri: `mongodb+srv://guff_app:Abc123${tail}`,
      encoded: false,
    });
    expect(tidyConnectionString('mongodb://127.0.0.1:27017')).toMatchObject({
      ok: true,
      encoded: false,
    });
  });

  it('encodes passwords with @ : / ? # % in them', () => {
    expect(tidyConnectionString(`mongodb+srv://guff_app:P@ss:w/rd?#50%${tail}`)).toEqual({
      ok: true,
      uri: `mongodb+srv://guff_app:P%40ss%3Aw%2Frd%3F%2350%25${tail}`,
      encoded: true,
    });
    // Already encoded: left alone.
    expect(tidyConnectionString(`mongodb+srv://guff_app:P%40ss${tail}`)).toMatchObject({
      encoded: false,
    });
  });

  it('strips quotes, spaces and a pasted MONGODB_URI=', () => {
    expect(
      tidyConnectionString(`  MONGODB_URI="mongodb+srv://guff_app:Abc123${tail}"  `),
    ).toMatchObject({
      ok: true,
      uri: `mongodb+srv://guff_app:Abc123${tail}`,
    });
  });

  it('explains the usual mistakes', () => {
    expect(problem('cluster0.x1y2z.mongodb.net')).toMatch(/doesn’t look like/);
    expect(problem(`mongodb+srv://guff_app:<db_password>${tail}`)).toMatch(
      /Replace <db_username> and <db_password>/,
    );
    expect(problem('mongodb+srv://<db_username>:Abc123@cluster0.r547eud.mongodb.net/')).toMatch(
      /Replace <db_username> and <db_password>/,
    );
    expect(problem(`mongodb+srv://guff_app:<Abc123>${tail}`)).toMatch(/Remove the < and >/);
    expect(problem(`mongodb+srv://guff_app:${tail}`)).toMatch(/password is missing/);
    expect(
      problem('mongodb+srv://guff_app:Xy7kP2mQ9rT4@cluster0.abcd123.mongodb.net/?appName=Cluster0'),
    ).toMatch(/example/);
    const one = `mongodb+srv://guff_app:Abc123${tail}`;
    expect(problem(one + one)).toMatch(/two connection strings/);
  });
});

describe('seed times', () => {
  it('reads days and clock times in Kathmandu time', () => {
    const now = new Date('2026-10-29T10:00:00Z'); // 15:45 in Kathmandu
    expect(resolveWhen({ day: 1, at: '09:30' }, now).toISOString()).toBe(
      '2026-10-28T03:45:00.000Z',
    );
    expect(resolveWhen({ ago: 30 }, now).toISOString()).toBe('2026-10-29T09:30:00.000Z');
  });
});
