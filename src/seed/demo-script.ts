/**
 * The demo workspace: Bato Labs, a small product studio in Lalitpur shipping version 2.0
 * of "Yatra", their trekking app, before Tihar. All people and companies are invented.
 *
 * Times: { day: 3, at: '14:20' } is 3 days ago at 14:20 Kathmandu time;
 * { ago: 45 } is 45 minutes before the seed runs. "@sita" becomes a real mention.
 */

export const DEMO_PASSWORD = 'Demo@1234';

export type PersonKey =
  'aarav' | 'sita' | 'bikash' | 'anjali' | 'nima' | 'prakash' | 'sunita' | 'rohan';

export const PEOPLE: Record<PersonKey, { name: string; title: string; bot: boolean }> = {
  aarav: { name: 'Aarav Shrestha', title: 'Engineering lead', bot: false },
  sita: { name: 'Sita Sharma', title: 'Product manager', bot: false },
  bikash: { name: 'Bikash Thapa', title: 'Backend engineer', bot: true },
  anjali: { name: 'Anjali Gurung', title: 'Product designer', bot: true },
  nima: { name: 'Nima Sherpa', title: 'Mobile engineer', bot: true },
  prakash: { name: 'Prakash Rai', title: 'Founder & CEO', bot: true },
  sunita: { name: 'Sunita Magar', title: 'QA engineer', bot: true },
  rohan: { name: 'Rohan KC', title: 'Customer success', bot: true },
};

export const emailOf = (key: PersonKey) => `${key}@guff.local`;

export type ChannelKey =
  'general' | 'random' | 'engineering' | 'design' | 'yatra-launch' | 'support' | 'hiring';

const everyone = Object.keys(PEOPLE) as PersonKey[];

export const CHANNELS: Record<
  ChannelKey,
  {
    kind: 'public' | 'private';
    topic: string;
    by: PersonKey;
    members: PersonKey[];
    isDefault?: boolean;
  }
> = {
  general: {
    kind: 'public',
    topic: 'Company news. Everyone is here.',
    by: 'prakash',
    members: everyone,
    isDefault: true,
  },
  random: {
    kind: 'public',
    topic: 'Momo reviews, mountain photos, anything else.',
    by: 'nima',
    members: everyone,
    isDefault: true,
  },
  engineering: {
    kind: 'public',
    topic: 'Builds, deploys and code reviews.',
    by: 'aarav',
    members: ['aarav', 'sita', 'bikash', 'nima', 'sunita'],
  },
  design: {
    kind: 'public',
    topic: 'Work in progress. Feedback welcome.',
    by: 'anjali',
    members: everyone,
  },
  'yatra-launch': {
    kind: 'public',
    topic: 'Yatra 2.0 ships before Tihar 🪔 Checklist in the first message.',
    by: 'sita',
    members: everyone,
  },
  support: {
    kind: 'public',
    topic: 'Customer questions that need a hand.',
    by: 'rohan',
    members: ['aarav', 'sita', 'bikash', 'sunita', 'rohan'],
  },
  hiring: {
    kind: 'private',
    topic: 'Interview loop for the backend role.',
    by: 'prakash',
    members: ['aarav', 'sita', 'prakash'],
  },
};

export type When = { day: number; at: string } | { ago: number };

export interface ScriptLine {
  /** A label so later lines can reply to this one. */
  ref?: string;
  when: When;
  by: PersonKey;
  text: string;
  replyTo?: string;
  reactions?: Partial<Record<string, PersonKey[]>>;
  attach?: { file: string; name: string };
  edited?: boolean;
  deleted?: boolean;
}

export const CHANNEL_SCRIPT: Record<ChannelKey, ScriptLine[]> = {
  general: [
    {
      ref: 'launch-news',
      when: { day: 6, at: '09:12' },
      by: 'prakash',
      text: 'Good morning everyone 🙏 Big week: **Yatra 2.0 ships before Tihar**. Thank you for all the late evenings. Let’s finish strong.',
      reactions: { '🙏': ['sita', 'bikash', 'nima', 'anjali'], '🎉': ['aarav', 'sunita', 'rohan'] },
    },
    {
      when: { day: 6, at: '09:20' },
      by: 'sita',
      text: 'The launch checklist lives in #yatra-launch. Please add anything I missed.',
    },
    {
      ref: 'esewa-request',
      when: { day: 5, at: '10:02' },
      by: 'rohan',
      text: 'Customer feedback from this week: people love the offline maps 🗺️ The top request is still **paying with eSewa** at checkout.',
      reactions: { '💯': ['sita', 'prakash'] },
    },
    {
      when: { day: 5, at: '10:15' },
      by: 'bikash',
      replyTo: 'esewa-request',
      text: 'eSewa is in this sprint. Sandbox payments work; we’re waiting on the production keys.',
      reactions: { '🙌': ['rohan'] },
    },
    {
      when: { day: 3, at: '16:40' },
      by: 'prakash',
      text: 'Friday team lunch is on me. Thakali set at the usual place 🍛',
      reactions: { '🔥': ['nima', 'bikash', 'anjali', 'sunita'], '🙌': ['rohan', 'sita'] },
    },
    {
      when: { day: 1, at: '11:30' },
      by: 'anjali',
      text: 'New illustrations for the app store listing are up in #design 🎨',
    },
    {
      when: { ago: 182 },
      by: 'sunita',
      text: 'Regression run for 2.0 RC1 is done: **142 passed, 3 failed**. Details in #yatra-launch.',
    },
  ],

  random: [
    {
      ref: 'momo',
      when: { day: 6, at: '13:05' },
      by: 'nima',
      text: 'Momo ranking, final answer:\n1. Jhol momo\n2. Steamed buff\n3. Everything else',
      reactions: { '😂': ['aarav', 'anjali'], '👀': ['bikash'] },
    },
    {
      when: { day: 6, at: '13:07' },
      by: 'bikash',
      replyTo: 'momo',
      text: 'Fried momo slander will not be tolerated 😤',
      reactions: { '😂': ['nima', 'sita'] },
    },
    { when: { day: 6, at: '13:10' }, by: 'anjali', text: 'Kothey momo supremacy 🥟' },
    {
      when: { day: 4, at: '07:55' },
      by: 'aarav',
      text: 'Clear view of Langtang from the Ring Road this morning. Worth being stuck in traffic for 🏔️',
      reactions: { '❤️': ['sita', 'prakash', 'nima'] },
    },
    {
      when: { day: 4, at: '08:03' },
      by: 'nima',
      text: 'Jealous. All I saw was the back of a bus 😅',
    },
    {
      when: { day: 2, at: '15:30' },
      by: 'sunita',
      text: 'Who keeps putting sugar in the office chiya? Asking for a friend ☕',
    },
    {
      when: { day: 2, at: '15:31' },
      by: 'rohan',
      text: 'Guilty. Patan chiya needs sugar. I don’t make the rules.',
    },
    { when: { day: 2, at: '15:32' }, by: 'bikash', text: 'Wrong channel, sorry', deleted: true },
    {
      when: { day: 2, at: '15:33' },
      by: 'sita',
      text: 'This is the most heated debate we’ve had all sprint',
      reactions: { '😂': ['sunita', 'aarav', 'bikash'] },
    },
    {
      when: { ago: 52 },
      by: 'nima',
      text: 'Power cut in Jhamsikhel again. Working from the café on the corner until it’s back ⚡',
    },
    { ref: 'croissant', when: { ago: 47 }, by: 'anjali', text: 'Bring me a croissant please 🙏' },
    { when: { ago: 45 }, by: 'nima', replyTo: 'croissant', text: 'Only if you review my PR 😄' },
  ],

  engineering: [
    {
      when: { day: 6, at: '10:30' },
      by: 'bikash',
      text: 'Heads up: I’m upgrading the API to Node 22 today. Staging will be down for about 15 minutes around 2 pm.',
    },
    {
      when: { day: 6, at: '14:20' },
      by: 'bikash',
      text: 'Staging is back. All green ✅',
      reactions: { '✅': ['aarav', 'sunita'] },
    },
    {
      when: { day: 5, at: '11:00' },
      by: 'aarav',
      text: 'Reminder for code reviews: small PRs, a test for every bug fix, and please explain _why_ in the description, not just what.',
      reactions: { '👍': ['bikash', 'nima', 'sunita'], '💯': ['sita'] },
    },
    {
      when: { day: 5, at: '11:20' },
      by: 'nima',
      text: 'The Android build went from 38 MB to 29 MB after removing the unused map tiles 🎉',
      reactions: { '🎉': ['aarav', 'bikash', 'sita'], '🔥': ['sunita'] },
    },
    {
      ref: 'slow',
      when: { day: 4, at: '16:10' },
      by: 'bikash',
      text: 'Anyone else seeing slow queries on the bookings list? p95 is 900 ms on staging.',
    },
    {
      ref: 'index',
      when: { day: 4, at: '16:25' },
      by: 'aarav',
      replyTo: 'slow',
      text: 'Probably the missing index on `bookings(userId, createdAt)`. Try:\n```\ndb.bookings.createIndex({ userId: 1, createdAt: -1 })\n```',
    },
    {
      when: { day: 4, at: '16:41' },
      by: 'bikash',
      replyTo: 'index',
      text: 'That was it. p95 is down to 40 ms 🚀',
      reactions: { '🔥': ['aarav', 'nima'], '🙌': ['sunita', 'sita'] },
    },
    {
      ref: 'crash',
      when: { day: 2, at: '10:05' },
      by: 'sunita',
      text: '@nima the RC1 build crashes on Android 9 when you open a trek with no photos. Steps are in the ticket.',
    },
    {
      when: { day: 2, at: '10:30' },
      by: 'nima',
      replyTo: 'crash',
      text: 'Found it: a missing image URL. The fix is in review.',
      reactions: { '🙏': ['sunita'] },
    },
    {
      when: { day: 1, at: '17:45' },
      by: 'aarav',
      text: 'The `release/2.0` branch is cut. Only bug fixes from now on please 🙏',
      reactions: { '👍': ['bikash', 'nima', 'sunita', 'sita'] },
    },
    {
      ref: 'keys',
      when: { ago: 131 },
      by: 'bikash',
      text: 'eSewa production keys arrived 🎉 Deploying the payment service to staging now.',
    },
    {
      when: { ago: 128 },
      by: 'aarav',
      replyTo: 'keys',
      text: 'Nice! Please run the refund flow end to end before we switch it on.',
      reactions: { '👍': ['bikash'] },
    },
  ],

  design: [
    {
      ref: 'mockup',
      when: { day: 5, at: '14:00' },
      by: 'anjali',
      text: 'First pass at the new trek detail screen. Feedback welcome, especially on the price block.',
      attach: { file: 'trek-detail-v1.png', name: 'trek-detail-v1.png' },
      reactions: { '❤️': ['sita', 'prakash'], '👀': ['aarav'] },
    },
    {
      ref: 'difficulty',
      when: { day: 5, at: '14:12' },
      by: 'sita',
      replyTo: 'mockup',
      text: 'Love it. Could the difficulty sit next to the duration? People compare those two first.',
    },
    {
      when: { day: 5, at: '14:20' },
      by: 'anjali',
      replyTo: 'difficulty',
      text: 'Good call. Moving it up.',
    },
    {
      when: { day: 3, at: '11:15' },
      by: 'anjali',
      text: 'Colours for 2.0: rhododendron red for primary actions, slate for text. Every pair passes WCAG AA ✅',
      attach: { file: 'yatra-colours.png', name: 'yatra-colours.png' },
      reactions: { '🔥': ['nima', 'sita'], '💯': ['aarav'] },
    },
    {
      ref: 'illustrations',
      when: { day: 1, at: '11:28' },
      by: 'anjali',
      text: 'App store illustrations are done 🎨 Five screens, all in the shared drive.',
    },
    {
      ref: 'newsletter',
      when: { day: 1, at: '11:40' },
      by: 'rohan',
      replyTo: 'illustrations',
      text: 'These are beautiful. Can I use the first one in the customer newsletter?',
    },
    {
      when: { day: 1, at: '11:42' },
      by: 'anjali',
      replyTo: 'newsletter',
      text: 'Of course!',
      reactions: { '🙏': ['rohan'] },
    },
  ],

  'yatra-launch': [
    {
      when: { day: 6, at: '09:30' },
      by: 'sita',
      text: 'Launch checklist for Yatra 2.0:\n1. eSewa payments live\n2. Offline maps for Annapurna and Everest\n3. New trek detail screen\n4. App store listing and screenshots\n5. Support FAQ updated\nPlease put your name next to an item 🙏',
    },
    { when: { day: 6, at: '09:41' }, by: 'bikash', text: '1 is mine.' },
    { when: { day: 6, at: '09:42' }, by: 'nima', text: '2 is mine.' },
    { when: { day: 6, at: '09:44' }, by: 'anjali', text: '3 and 4 🙋‍♀️' },
    {
      when: { day: 6, at: '09:50' },
      by: 'rohan',
      text: '5, and I’ll brief the support team the day before.',
    },
    {
      when: { day: 3, at: '17:00' },
      by: 'sita',
      text: 'Status check: payments ✅ maps ✅ design ✅ listing in progress, FAQ in review. We’re on track 🚀',
      reactions: { '🙌': ['prakash', 'aarav', 'bikash'] },
    },
    {
      ref: 'press',
      when: { day: 1, at: '09:15' },
      by: 'prakash',
      text: 'The press release draft is ready. @sita can you check the feature list is accurate?',
    },
    {
      when: { day: 1, at: '09:40' },
      by: 'sita',
      replyTo: 'press',
      text: 'Checked and fixed two items. Good to go.',
      reactions: { '🙏': ['prakash'] },
    },
    {
      ref: 'rc1',
      when: { ago: 176 },
      by: 'sunita',
      text: 'RC1 regression run: **142 passed, 3 failed**\n- Booking summary shows the wrong currency on iOS\n- Offline map tiles are missing for Manaslu\n- Typo on the refund screen',
    },
    {
      when: { ago: 161 },
      by: 'sita',
      replyTo: 'rc1',
      text: 'Thanks Sunita! @aarav can your team take the currency bug today? It’s the only one that blocks the launch.',
    },
    { when: { ago: 150 }, by: 'nima', text: 'The Manaslu tiles are a config issue. Fixing now.' },
    {
      when: { ago: 31 },
      by: 'bikash',
      text: 'The payment service is live on staging. Refunds tested end to end ✅',
    },
  ],

  support: [
    {
      ref: 'double',
      when: { day: 4, at: '12:00' },
      by: 'rohan',
      text: 'A customer in Pokhara was charged twice for one booking. I refunded it by hand, but could someone check the logs? The booking ID is in the ticket.',
    },
    {
      when: { day: 4, at: '12:30' },
      by: 'bikash',
      replyTo: 'double',
      text: 'Found it: the app retried after a timeout and the payment call wasn’t idempotent. Fixed in 2.0 with idempotency keys.',
      reactions: { '🙏': ['rohan'], '💯': ['aarav'] },
    },
    {
      ref: 'faq',
      when: { day: 2, at: '09:05' },
      by: 'rohan',
      text: 'The FAQ draft for 2.0 is ready for review. Tell me if anything reads unclear.',
    },
    {
      when: { day: 2, at: '09:30' },
      by: 'sunita',
      replyTo: 'faq',
      text: 'Read it. One fix: offline maps need about 300 MB, not 200 MB.',
      edited: true,
    },
  ],

  hiring: [
    {
      when: { day: 3, at: '10:00' },
      by: 'prakash',
      text: 'Three candidates for the backend role this week. Loop: system design with Aarav, product chat with Sita, culture chat with me.',
    },
    {
      when: { day: 3, at: '10:20' },
      by: 'aarav',
      text: 'I’ll use the booking-service design question. Scorecards are in the hiring doc.',
    },
    {
      when: { day: 1, at: '16:00' },
      by: 'sita',
      text: 'Candidate 2 was excellent. Strong on testing, and asked great questions about our users.',
    },
    {
      when: { day: 1, at: '16:10' },
      by: 'prakash',
      text: 'Agreed. Let’s make an offer if Aarav’s round goes well tomorrow 🤞',
      reactions: { '👍': ['aarav', 'sita'] },
    },
  ],
};

export const DM_SCRIPT: { between: [PersonKey, PersonKey]; lines: ScriptLine[] }[] = [
  {
    between: ['aarav', 'sita'],
    lines: [
      {
        when: { day: 2, at: '18:05' },
        by: 'sita',
        text: 'Do you have 10 minutes tomorrow to go through the release plan?',
      },
      { when: { day: 2, at: '18:20' }, by: 'aarav', text: 'Yes, 11 am works.' },
      {
        when: { day: 1, at: '11:55' },
        by: 'sita',
        text: 'Thanks for today. I’ve updated the timeline.',
      },
      { when: { day: 1, at: '11:58' }, by: 'aarav', text: 'Looks good 👍' },
    ],
  },
  {
    between: ['aarav', 'bikash'],
    lines: [
      {
        when: { day: 4, at: '16:50' },
        by: 'bikash',
        text: 'Thanks for the index tip, it saved my afternoon 🙏',
      },
      {
        when: { day: 4, at: '16:52' },
        by: 'aarav',
        text: 'Anytime. Add it to the migration so production gets it too.',
      },
      { when: { day: 4, at: '16:53' }, by: 'bikash', text: 'Already done ✅' },
    ],
  },
  {
    between: ['aarav', 'prakash'],
    lines: [
      {
        when: { ago: 19 },
        by: 'prakash',
        text: 'Great work this week, Aarav. Can we talk about the Q1 roadmap after the launch?',
      },
    ],
  },
  {
    between: ['sita', 'anjali'],
    lines: [
      {
        when: { day: 5, at: '14:30' },
        by: 'sita',
        text: 'The new screen is lovely. Let’s show it in the Friday demo.',
      },
      { when: { day: 5, at: '14:35' }, by: 'anjali', text: 'Yay, thank you! 🙏' },
    ],
  },
];

/**
 * Where each demo person has read up to, so they arrive to a few unread messages.
 * "upTo" is the number of messages at the end of the conversation they haven't seen.
 * Anything not listed is fully read.
 */
export const UNREAD: Partial<
  Record<PersonKey, Partial<Record<ChannelKey | `dm:${PersonKey}`, number>>>
> = {
  aarav: { general: 1, random: 3, 'yatra-launch': 4, 'dm:prakash': 1 },
  sita: { random: 3, engineering: 2, design: 0, 'dm:aarav': 0 },
};
