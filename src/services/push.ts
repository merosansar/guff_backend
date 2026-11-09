import type { Logger } from 'pino';
import { badRequest } from '../lib/errors.js';
import { type VapidKeys, generateVapidKeys, isPushEndpoint, sendPush } from '../lib/web-push.js';
import { PushSubscription, Setting } from '../models/extras.js';
import { Membership, type MembershipDoc } from '../models/membership.js';
import { Message, type MessageDoc } from '../models/message.js';
import { User, type UserDoc, isDnd } from '../models/user.js';
import type { RealtimeBus } from '../realtime/bus.js';
import type { MessageCreated, MessageService } from './messages.js';

/**
 * Notifications that reach a phone or desktop even when Guff isn't open. A person gets
 * a push only when none of their tabs is connected (an open tab shows its own
 * notification), they aren't in do-not-disturb, and the conversation's notification
 * setting asks for it.
 */
export class PushService {
  private keys: VapidKeys | null = null;

  constructor(
    private readonly bus: RealtimeBus,
    private readonly log: Logger,
    private readonly subject: string,
  ) {}

  /** Uses the configured keys, or makes a pair once and keeps it in the database. */
  async init(configured: { publicKey: string; privateKey: string }): Promise<void> {
    if (configured.publicKey && configured.privateKey) {
      this.keys = configured;
      return;
    }
    const fresh = generateVapidKeys();
    await Setting.updateOne({ _id: 'vapid' }, { $setOnInsert: { value: fresh } }, { upsert: true });
    const stored = await Setting.findById('vapid').lean();
    this.keys = (stored?.value as VapidKeys | undefined) ?? fresh;
  }

  get publicKey(): string | null {
    return this.keys?.publicKey ?? null;
  }

  listen(messages: MessageService): void {
    messages.events.on('created', (event) => {
      this.notify(event).catch((error: unknown) => this.log.warn({ err: error }, 'push failed'));
    });
  }

  async subscribe(
    userId: string,
    sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  ): Promise<void> {
    if (!isPushEndpoint(sub.endpoint)) throw badRequest('That push service isn’t supported.');
    await PushSubscription.updateOne(
      { endpoint: sub.endpoint },
      { $set: { userId, keys: sub.keys }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true },
    );
  }

  async unsubscribe(userId: string, endpoint: string): Promise<void> {
    await PushSubscription.deleteOne({ userId, endpoint });
  }

  /** Who should hear about this message, and what the notification says. */
  private async notify({ message, channel }: MessageCreated): Promise<void> {
    if (!this.keys || message.kind !== 'user') return;
    const authorId = message.authorId.toString();
    const members = await Membership.find({ channelId: channel._id }).lean<MembershipDoc[]>();
    let rootAuthor: string | null = null;
    if (message.threadRootId) {
      const root = await Message.findById(message.threadRootId, { authorId: 1 }).lean<MessageDoc>();
      rootAuthor = root?.authorId.toString() ?? null;
    }
    const mentioned = new Set(message.mentions.map(String));

    const wanted = members.filter((m) => {
      const id = m.userId.toString();
      if (message.reminder) return id === authorId;
      if (id === authorId || m.notify === 'mute') return false;
      if (mentioned.has(id) || m.notify === 'all') return true;
      if (message.threadRootId) return id === rootAuthor;
      return channel.kind === 'dm';
    });
    if (wanted.length === 0) return;

    const [users, author] = await Promise.all([
      User.find({ _id: { $in: wanted.map((m) => m.userId) } }).lean<UserDoc[]>(),
      User.findById(message.authorId).lean<UserDoc>(),
    ]);
    const where =
      channel.kind === 'dm'
        ? (message.webhook?.name ?? author?.name ?? 'New message')
        : `${message.webhook?.name ?? author?.name ?? 'Someone'} in #${channel.name}`;
    const body = message.reminder
      ? `Reminder: ${message.ref?.excerpt || 'a message'}`
      : plain(message.text) || (message.attachments[0] ? `Sent ${message.attachments[0].name}` : 'New message');
    const url = message.threadRootId
      ? `/c/${channel._id.toString()}?thread=${message.threadRootId.toString()}`
      : `/c/${channel._id.toString()}`;

    for (const user of users) {
      if (user.demoBot || isDnd(user)) continue;
      const id = user._id.toString();
      if ((await this.bus.userSockets(id)).sockets > 0) continue;
      await this.sendTo(id, {
        title: message.reminder ? '⏰ Reminder' : where,
        body,
        url,
        tag: channel._id.toString(),
      });
    }
  }

  async sendTo(userId: string, data: { title: string; body: string; url: string; tag: string }) {
    if (!this.keys) return;
    const subs = await PushSubscription.find({ userId }).lean();
    for (const sub of subs) {
      try {
        const result = await sendPush(sub, data, this.keys, this.subject);
        if (result === 'gone') await PushSubscription.deleteOne({ _id: sub._id });
      } catch (error) {
        this.log.warn({ err: error }, 'push delivery failed');
      }
    }
  }
}

function plain(text: string): string {
  return text
    .replace(/<@[a-f\d]{24}>/gi, '@someone')
    .replace(/```[\s\S]*?```/g, '[code]')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}
