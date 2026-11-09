import { timingSafeEqual } from 'node:crypto';
import { Types } from 'mongoose';
import { badRequest, notFound, tooMany } from '../lib/errors.js';
import { TokenBucket } from '../lib/rate-limiter.js';
import { hashToken, newRefreshToken } from '../lib/tokens.js';
import { Webhook, type WebhookDoc } from '../models/extras.js';
import type { ChannelService } from './channels.js';
import type { MessageDto } from './dto.js';
import type { MessageService } from './messages.js';

const MAX_PER_CHANNEL = 10;

export interface WebhookDto {
  id: string;
  channelId: string;
  name: string;
  createdBy: string;
  createdAt: string;
  lastUsedAt: string | null;
}

const toDto = (w: WebhookDoc): WebhookDto => ({
  id: w._id.toString(),
  channelId: w.channelId.toString(),
  name: w.name,
  createdBy: w.createdBy.toString(),
  createdAt: w.createdAt.toISOString(),
  lastUsedAt: w.lastUsedAt ? w.lastUsedAt.toISOString() : null,
});

/**
 * Incoming webhooks: a secret URL that other tools (CI, GitHub, a cron job) can POST to,
 * and the text appears in the channel. The secret is shown once and only its hash is kept.
 */
export class WebhookService {
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(
    private readonly channels: ChannelService,
    private readonly messages: MessageService,
    private readonly appUrl: string,
  ) {}

  async list(userId: string, channelId: string): Promise<WebhookDto[]> {
    await this.channels.requireManager(userId, channelId);
    const rows = await Webhook.find({ channelId }).sort({ createdAt: 1 }).lean<WebhookDoc[]>();
    return rows.map(toDto);
  }

  /** Returns the full URL. It contains the secret, so it is only ever shown here. */
  async create(userId: string, channelId: string, name: string): Promise<{ webhook: WebhookDto; url: string }> {
    const { channel } = await this.channels.requireManager(userId, channelId);
    const clean = name.trim();
    if (clean.length < 2) throw badRequest('Give the integration a name, like “GitHub” or “Deploys”.');
    if ((await Webhook.countDocuments({ channelId: channel._id })) >= MAX_PER_CHANNEL)
      throw badRequest(`A channel can have up to ${MAX_PER_CHANNEL} integrations.`);
    const secret = newRefreshToken();
    const doc = (
      await Webhook.create({
        channelId: channel._id,
        name: clean,
        tokenHash: hashToken(secret),
        createdBy: new Types.ObjectId(userId),
      })
    ).toObject();
    await this.messages.system(userId, channelId, `added an integration: ${clean}`);
    return { webhook: toDto(doc), url: `${this.appUrl}/api/hooks/${doc._id.toString()}/${secret}` };
  }

  async remove(userId: string, webhookId: string): Promise<void> {
    const hook = await Webhook.findById(webhookId).lean<WebhookDoc>();
    if (!hook) throw notFound('That integration doesn’t exist.');
    const channelId = hook.channelId.toString();
    await this.channels.requireManager(userId, channelId);
    await Webhook.deleteOne({ _id: hook._id });
    await this.messages.system(userId, channelId, `removed the integration ${hook.name}`);
  }

  /** The public endpoint. Wrong id and wrong secret look the same from outside. */
  async post(webhookId: string, secret: string, input: { text: string; username?: string | undefined }): Promise<MessageDto> {
    const hook = Types.ObjectId.isValid(webhookId) ? await Webhook.findById(webhookId).lean<WebhookDoc>() : null;
    const expected = Buffer.from(hook?.tokenHash ?? '0'.repeat(64));
    const actual = Buffer.from(hashToken(secret));
    if (!hook || !timingSafeEqual(expected, actual)) throw notFound('Unknown webhook.');

    let bucket = this.buckets.get(webhookId);
    if (!bucket) {
      bucket = new TokenBucket(20, 1);
      this.buckets.set(webhookId, bucket);
    }
    if (!bucket.take()) throw tooMany('Slow down: at most one message a second.');

    const name = (input.username?.trim() || hook.name).slice(0, 40);
    const { message } = await this.messages.send(hook.createdBy.toString(), {
      channelId: hook.channelId.toString(),
      text: input.text,
      webhook: { id: hook._id, name },
    });
    await Webhook.updateOne({ _id: hook._id }, { $set: { lastUsedAt: new Date() } });
    return message;
  }
}
