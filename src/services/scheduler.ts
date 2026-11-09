import type { Logger } from 'pino';
import { Types } from 'mongoose';
import { HttpError, badRequest, notFound } from '../lib/errors.js';
import { normalizeText } from '../lib/text.js';
import { Scheduled, type ScheduledDoc } from '../models/extras.js';
import { Message, type MessageDoc } from '../models/message.js';
import type { RealtimeBus } from '../realtime/bus.js';
import type { ChannelService } from './channels.js';
import type { MessageService } from './messages.js';

const YEAR = 365 * 86_400_000;
/** A send that started but never finished (the server stopped) is tried again after this. */
const STALE_MS = 5 * 60_000;
const MAX_PENDING = 100;

export interface ScheduledDto {
  id: string;
  kind: 'message' | 'reminder';
  channelId: string;
  text: string;
  threadRootId: string | null;
  messageId: string | null;
  sendAt: string;
  status: ScheduledDoc['status'];
  error: string | null;
}

const toDto = (s: ScheduledDoc): ScheduledDto => ({
  id: s._id.toString(),
  kind: s.kind,
  channelId: s.channelId.toString(),
  text: s.text,
  threadRootId: s.threadRootId?.toString() ?? null,
  messageId: s.messageId?.toString() ?? null,
  sendAt: s.sendAt.toISOString(),
  status: s.status,
  error: s.error,
});

/**
 * "Send tomorrow at 9" and "remind me about this in an hour". Due items are claimed one
 * at a time with an atomic update, so several API servers never send the same one, and
 * each send reuses a fixed clientId, so a retry after a crash can't post it twice.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly channels: ChannelService,
    private readonly messages: MessageService,
    private readonly bus: RealtimeBus,
    private readonly log: Logger,
  ) {}

  start(intervalMs: number): void {
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private checkTime(at: Date): void {
    const now = Date.now();
    if (!Number.isFinite(at.getTime())) throw badRequest('Choose a valid date and time.');
    if (at.getTime() < now + 30_000) throw badRequest('Choose a time at least a minute from now.');
    if (at.getTime() > now + YEAR) throw badRequest('Choose a time within the next year.');
  }

  private async checkRoom(userId: string): Promise<void> {
    const count = await Scheduled.countDocuments({ userId, status: 'pending' });
    if (count >= MAX_PENDING) throw badRequest('You have too many scheduled items. Cancel some first.');
  }

  async scheduleMessage(
    userId: string,
    input: { channelId: string; text: string; sendAt: Date; threadRootId?: string | undefined },
  ): Promise<ScheduledDto> {
    this.checkTime(input.sendAt);
    const text = normalizeText(input.text);
    if (!text) throw badRequest('Write a message to schedule.');
    const { channel } = await this.channels.requirePoster(userId, input.channelId);
    if (input.threadRootId) {
      const root = await Message.exists({ _id: input.threadRootId, channelId: channel._id, threadRootId: null });
      if (!root) throw badRequest('That thread isn’t in this conversation.');
    }
    await this.checkRoom(userId);
    const doc = await Scheduled.create({
      userId,
      kind: 'message',
      channelId: channel._id,
      text,
      threadRootId: input.threadRootId ? new Types.ObjectId(input.threadRootId) : null,
      sendAt: input.sendAt,
    });
    this.bus.toUser(userId, 'scheduled:changed');
    return toDto(doc.toObject());
  }

  async scheduleReminder(userId: string, messageId: string, remindAt: Date): Promise<ScheduledDto> {
    this.checkTime(remindAt);
    const message = await Message.findById(messageId).lean<MessageDoc>();
    if (!message || message.kind !== 'user') throw notFound('That message doesn’t exist.');
    await this.channels.access(userId, message.channelId.toString());
    await this.checkRoom(userId);
    const doc = await Scheduled.create({
      userId,
      kind: 'reminder',
      channelId: message.channelId,
      messageId: message._id,
      sendAt: remindAt,
    });
    this.bus.toUser(userId, 'scheduled:changed');
    return toDto(doc.toObject());
  }

  async list(userId: string): Promise<ScheduledDto[]> {
    const rows = await Scheduled.find({ userId, status: { $in: ['pending', 'sending', 'failed'] } })
      .sort({ sendAt: 1 })
      .limit(MAX_PENDING + 20)
      .lean<ScheduledDoc[]>();
    return rows.map(toDto);
  }

  async cancel(userId: string, id: string): Promise<void> {
    const removed = await Scheduled.deleteOne({ _id: id, userId, status: { $in: ['pending', 'failed'] } });
    if (!removed.deletedCount) throw notFound('That was already sent, or doesn’t exist.');
    this.bus.toUser(userId, 'scheduled:changed');
  }

  /** Sends whatever is due. Runs on a timer; tests call it directly. */
  async tick(now = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let done = 0;
    try {
      await Scheduled.updateMany(
        { status: 'sending', claimedAt: { $lt: new Date(now.getTime() - STALE_MS) } },
        { $set: { status: 'pending' } },
      );
      for (let i = 0; i < 50; i++) {
        const item = await Scheduled.findOneAndUpdate(
          { status: 'pending', sendAt: { $lte: now } },
          { $set: { status: 'sending', claimedAt: new Date() } },
          { sort: { sendAt: 1 }, returnDocument: 'after' },
        ).lean<ScheduledDoc>();
        if (!item) break;
        await this.deliver(item);
        done++;
      }
    } finally {
      this.running = false;
    }
    return done;
  }

  private async deliver(item: ScheduledDoc): Promise<void> {
    const userId = item.userId.toString();
    const clientId = `sched-${item._id.toString()}`;
    try {
      if (item.kind === 'message') {
        await this.messages.send(userId, {
          channelId: item.channelId.toString(),
          clientId,
          text: item.text,
          threadRootId: item.threadRootId?.toString(),
        });
      } else {
        await this.messages.remind(userId, item.messageId!.toString(), clientId);
      }
      await Scheduled.updateOne({ _id: item._id }, { $set: { status: 'sent', error: null } });
    } catch (error) {
      const message = error instanceof HttpError ? error.message : 'Something went wrong while sending.';
      if (!(error instanceof HttpError)) this.log.error({ err: error }, 'scheduled send failed');
      await Scheduled.updateOne({ _id: item._id }, { $set: { status: 'failed', error: message } });
    }
    this.bus.toUser(userId, 'scheduled:changed');
  }
}
