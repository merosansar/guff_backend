import type { Logger } from 'pino';
import { Membership } from '../models/membership.js';
import { User, type UserDoc } from '../models/user.js';
import type { RealtimeBus } from '../realtime/bus.js';
import type { MessageCreated, MessageService } from './messages.js';

/**
 * Makes the demo feel alive for someone trying it alone: message a seeded teammate (or
 * @mention one) and they "type" and answer. They only do this while nobody is signed in
 * as them, and their replies are marked as automated in the app.
 */

interface Persona {
  work: string[];
  question: string[];
}

const PERSONAS: Record<string, Persona> = {
  'bikash@guff.local': {
    work: [
      'I’ll check the API logs and get back to you.',
      'On it. I’ll open a PR for that this afternoon.',
      'Looks like a caching issue. Let me dig in.',
    ],
    question: [
      'Good question. I think the answer is in the API docs, but I’ll confirm.',
      'Let me check the database and reply properly in a bit.',
    ],
  },
  'anjali@guff.local': {
    work: [
      'I’ll update the Figma file and share a link.',
      'Let me mock up two options so we can compare.',
      'Good catch. I’ll fix the spacing on that screen.',
    ],
    question: [
      'Hmm, I’d keep it simple. Can I show you a sketch after lunch?',
      'I think users would expect it on the right. I’ll test it with a few people.',
    ],
  },
  'nima@guff.local': {
    work: [
      'Testing it on my Android phone now 📱',
      'The mobile build is almost ready. I’ll send it to you soon.',
      'Works on iOS. Checking Android next.',
    ],
    question: [
      'Not sure yet. Give me ten minutes to try it on a real device.',
      'I think so! Let me double-check on the slow 3G profile.',
    ],
  },
  'prakash@guff.local': {
    work: [
      'Thanks for pushing this forward. Let’s review it on Friday.',
      'Great progress. Keep the launch date in mind 🙏',
      'Let’s make sure customers hear about this first.',
    ],
    question: [
      'Let’s discuss it in the weekly review. Add it to the agenda?',
      'Good point. What would you recommend?',
    ],
  },
  'sunita@guff.local': {
    work: [
      'I’ll add it to the test plan for this release.',
      'Found a small bug there earlier. Logging it now 🐞',
      'Retesting it on staging now.',
    ],
    question: [
      'I can reproduce it on staging. Let me write the exact steps.',
      'Which build are you on? I’ll check against that one.',
    ],
  },
  'rohan@guff.local': {
    work: [
      'Two customers asked about that this week!',
      'I’ll let the customers who reported it know.',
      'Nice, that will save the support team a lot of time.',
    ],
    question: [
      'Customers mostly ask about that on Sundays, funnily enough.',
      'Let me check our support inbox and get back to you.',
    ],
  },
};

const DEFAULT_PERSONA: Persona = {
  work: ['On it 👍', 'I’ll take a look this afternoon.'],
  question: ['Good question. Let me get back to you.'],
};

const GREETINGS = ['Namaste {name}! 🙏 What’s up?', 'Hey {name}! How can I help?', 'Hi {name} 👋'];
const THANKS = ['Anytime! 🙌', 'No problem, {name}.', 'Happy to help 🙏'];
const FOOD = [
  'Momo at the place near Patan Durbar Square? I’m in 😋',
  'Chiya break at 4? ☕',
  'Only if there’s sel roti 😄',
];
const FALLBACK = [
  'Got it 👍',
  'Sounds good, {name}!',
  'Makes sense. Thanks for the heads-up.',
  'Noted. I’ll keep that in mind.',
];

const WORK_WORDS =
  /\b(bug|deploy|release|build|review|pr|test|api|design|figma|launch|fix|crash|staging|issue|ticket|customer|android|ios)\b/i;

function pick(list: string[], seed: number): string {
  return list[seed % list.length]!;
}

export function chooseReply(
  text: string,
  botEmail: string,
  humanFirstName: string,
  seed: number,
): string {
  const persona = PERSONAS[botEmail] ?? DEFAULT_PERSONA;
  const t = text.replace(/<@[a-f\d]{24}>/gi, ' ').toLowerCase();
  let line: string;
  if (/\b(thank|thanks|thx|dhanyabad|dhanyavad)\b/.test(t)) line = pick(THANKS, seed);
  else if (/\b(momo|lunch|chiya|tea|coffee|khaja|dinner|food)\b/.test(t)) line = pick(FOOD, seed);
  else if (/^\s*(hi|hello|hey|namaste|namaskar|good (morning|afternoon|evening))\b/.test(t))
    line = pick(GREETINGS, seed);
  else if (WORK_WORDS.test(t)) line = pick(persona.work, seed);
  else if (t.includes('?')) line = pick(persona.question, seed);
  else line = pick(FALLBACK, seed);
  return line.replaceAll('{name}', humanFirstName);
}

export class DemoReplies {
  private readonly pending = new Map<string, NodeJS.Timeout[]>();
  private seed = 0;

  constructor(
    private readonly messages: MessageService,
    private readonly bus: RealtimeBus,
    private readonly log: Logger,
  ) {}

  start(): void {
    this.messages.events.on('created', (event) => {
      this.handle(event).catch((error: unknown) =>
        this.log.warn({ err: error }, 'demo reply failed'),
      );
    });
  }

  stop(): void {
    for (const timers of this.pending.values()) timers.forEach(clearTimeout);
    this.pending.clear();
  }

  private async handle({ message, channel }: MessageCreated): Promise<void> {
    if (message.kind !== 'user' || message.automated) return;
    const author = await User.findById(message.authorId).lean<UserDoc>();
    if (!author || author.demoBot) return;

    let bots: UserDoc[] = [];
    if (channel.kind === 'dm') {
      const other = await Membership.findOne({
        channelId: channel._id,
        userId: { $ne: author._id },
      }).lean();
      if (other) bots = await User.find({ _id: other.userId, demoBot: true }).lean<UserDoc[]>();
    } else if (message.mentions.length) {
      bots = await User.find({ _id: { $in: message.mentions }, demoBot: true })
        .limit(1)
        .lean<UserDoc[]>();
    }

    for (const bot of bots) {
      // Someone is signed in as this teammate: they answer for themselves.
      if ((await this.bus.userSockets(bot._id.toString())).sockets > 0) continue;
      this.schedule(bot, author, channel._id.toString(), message.text, message._id.toString());
    }
  }

  /** Waits for a pause in the conversation, shows typing, then answers once. */
  private schedule(
    bot: UserDoc,
    human: UserDoc,
    channelId: string,
    text: string,
    triggerId: string,
  ): void {
    const key = `${channelId}:${bot._id.toString()}`;
    this.pending.get(key)?.forEach(clearTimeout);
    const botId = bot._id.toString();
    const reply = chooseReply(text, bot.email, human.name.split(' ')[0] ?? human.name, this.seed++);
    const typingFor = Math.min(3500, 900 + reply.length * 35);

    const startTyping = setTimeout(() => {
      this.bus.toChannel(channelId, 'typing', { channelId, userId: botId, typing: true });
    }, 1200);
    const send = setTimeout(() => {
      this.pending.delete(key);
      this.bus.toChannel(channelId, 'typing', { channelId, userId: botId, typing: false });
      this.messages
        .send(botId, { channelId, clientId: `demo-${triggerId}`, text: reply, automated: true })
        .catch((error: unknown) => this.log.warn({ err: error }, 'demo reply failed'));
    }, 1200 + typingFor);
    this.pending.set(key, [startTyping, send]);
  }
}
