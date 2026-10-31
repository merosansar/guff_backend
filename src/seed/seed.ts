import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Types } from 'mongoose';
import { BACKEND_DIR } from '../config/env.js';
import { hashPassword } from '../lib/password.js';
import { TokenService } from '../lib/tokens.js';
import { excerpt, extractMentionIds } from '../lib/text.js';
import { Channel, Membership, Message, User } from '../models/index.js';
import { dmKeyFor } from '../models/channel.js';
import type { MessageDoc } from '../models/message.js';
import { AVATAR_COLORS } from '../models/user.js';
import { FileService } from '../services/files.js';
import {
  CHANNELS,
  CHANNEL_SCRIPT,
  type ChannelKey,
  DEMO_PASSWORD,
  DM_SCRIPT,
  PEOPLE,
  type PersonKey,
  type ScriptLine,
  UNREAD,
  type When,
  emailOf,
} from './demo-script.js';

const KATHMANDU_OFFSET_MIN = 5 * 60 + 45;
const ASSETS = join(BACKEND_DIR, 'seed-assets');

/** { day: 2, at: '15:30' } → 2 days ago at 15:30 in Kathmandu. { ago: 45 } → 45 minutes ago. */
export function resolveWhen(when: When, now: Date): Date {
  if ('ago' in when) return new Date(now.getTime() - when.ago * 60_000);
  const local = new Date(now.getTime() + KATHMANDU_OFFSET_MIN * 60_000);
  const [hh, mm] = when.at.split(':').map(Number) as [number, number];
  const utc = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate() - when.day,
    hh,
    mm,
  );
  return new Date(utc - KATHMANDU_OFFSET_MIN * 60_000);
}

/** An ObjectId whose timestamp is `at`. A running counter keeps same-second ids in order. */
const PROCESS_PART = randomBytes(5).toString('hex');
let counter = 0;
const idAt = (at: Date) =>
  new Types.ObjectId(
    Math.floor(at.getTime() / 1000)
      .toString(16)
      .padStart(8, '0') +
      PROCESS_PART +
      (counter++ % 0xffffff).toString(16).padStart(6, '0'),
  );

export interface SeedSummary {
  people: number;
  channels: number;
  messages: number;
}

export async function seedDemo(jwtSecret: string, now = new Date()): Promise<SeedSummary> {
  const files = new FileService(new TokenService(jwtSecret, 900));
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const weekAgo = resolveWhen({ day: 7, at: '09:00' }, now);

  // ---- people -------------------------------------------------------------
  const keys = Object.keys(PEOPLE) as PersonKey[];
  const userIds = {} as Record<PersonKey, Types.ObjectId>;
  for (const [i, key] of keys.entries()) {
    const person = PEOPLE[key];
    const user = await User.create({
      email: emailOf(key),
      name: person.name,
      title: person.title,
      passwordHash,
      color: AVATAR_COLORS[i % AVATAR_COLORS.length],
      demoBot: person.bot,
      lastSeenAt: resolveWhen({ day: 1, at: '19:30' }, now),
    });
    userIds[key] = user._id;
  }
  const mentionize = (text: string) =>
    text.replace(
      /@(aarav|sita|bikash|anjali|nima|prakash|sunita|rohan)\b/g,
      (_m, k: PersonKey) => `<@${userIds[k]}>`,
    );

  let messageCount = 0;

  /** Writes one conversation's lines in time order, then sets everyone's read marker. */
  async function writeConversation(
    channelId: Types.ObjectId,
    members: PersonKey[],
    lines: ScriptLine[],
    unreadFor: (person: PersonKey) => number,
  ) {
    const byRef = new Map<string, MessageDoc>();
    const ordered = lines
      .map((line, i) => ({ line, at: resolveWhen(line.when, now), i }))
      .sort((a, b) => a.at.getTime() - b.at.getTime() || a.i - b.i);
    const ids: Types.ObjectId[] = [];

    for (const { line, at } of ordered) {
      const text = mentionize(line.text);
      const original = line.replyTo ? byRef.get(line.replyTo) : undefined;
      if (line.replyTo && !original) throw new Error(`Seed reply to unknown ref "${line.replyTo}"`);

      const attachments = [];
      if (line.attach) {
        const buffer = await readFile(join(ASSETS, line.attach.file));
        const uploaded = await files.upload(userIds[line.by].toString(), {
          buffer,
          originalname: line.attach.name,
        });
        attachments.push(
          ...(await files.claim(userIds[line.by].toString(), [uploaded.id], channelId.toString())),
        );
      }

      const doc = {
        _id: idAt(at),
        channelId,
        authorId: userIds[line.by],
        kind: 'user' as const,
        clientId: null,
        text: line.deleted ? '' : text,
        mentions: line.deleted ? [] : extractMentionIds(text).map((id) => new Types.ObjectId(id)),
        replyTo: original
          ? {
              messageId: original._id,
              authorId: original.authorId,
              excerpt: excerpt(original.text),
            }
          : null,
        reactions: line.deleted
          ? []
          : Object.entries(line.reactions ?? {}).map(([emoji, people]) => ({
              emoji,
              userIds: (people ?? []).map((p) => userIds[p]),
            })),
        attachments: line.deleted ? [] : attachments,
        automated: false,
        editedAt: line.edited ? new Date(at.getTime() + 3 * 60_000) : null,
        deletedAt: line.deleted ? new Date(at.getTime() + 60_000) : null,
      };
      await Message.collection.insertOne(doc);
      if (line.ref) byRef.set(line.ref, doc as MessageDoc);
      ids.push(doc._id);
      messageCount += 1;
    }

    const last = ordered.at(-1);
    if (last)
      await Channel.collection.updateOne({ _id: channelId }, { $set: { lastMessageAt: last.at } });

    for (const person of members) {
      const unread = Math.min(unreadFor(person), ids.length);
      const lastReadId = ids[ids.length - 1 - unread] ?? null;
      await Membership.updateOne({ channelId, userId: userIds[person] }, { $set: { lastReadId } });
    }
  }

  // ---- channels -------------------------------------------------------------
  let channelCount = 0;
  for (const [key, spec] of Object.entries(CHANNELS) as [
    ChannelKey,
    (typeof CHANNELS)[ChannelKey],
  ][]) {
    const created = new Date(weekAgo.getTime() + channelCount * 7 * 60_000);
    const channelId = new Types.ObjectId();
    await Channel.collection.insertOne({
      _id: channelId,
      kind: spec.kind,
      name: key,
      topic: spec.topic,
      createdBy: userIds[spec.by],
      isDefault: spec.isDefault ?? false,
      dmKey: null,
      memberCount: spec.members.length,
      lastMessageAt: null,
      createdAt: created,
      updatedAt: created,
    });
    await Membership.insertMany(
      spec.members.map((p) => ({
        channelId,
        userId: userIds[p],
        role: p === spec.by ? 'owner' : 'member',
        joinedAt: created,
        lastReadId: null,
      })),
    );
    await Message.collection.insertOne({
      _id: idAt(created),
      channelId,
      authorId: userIds[spec.by],
      kind: 'system',
      clientId: null,
      text: `created #${key}`,
      mentions: [],
      replyTo: null,
      reactions: [],
      attachments: [],
      automated: false,
      editedAt: null,
      deletedAt: null,
    });
    messageCount += 1;
    await writeConversation(
      channelId,
      spec.members,
      CHANNEL_SCRIPT[key],
      (p) => UNREAD[p]?.[key] ?? 0,
    );
    channelCount += 1;
  }

  // ---- direct messages ------------------------------------------------------------
  for (const dm of DM_SCRIPT) {
    const [a, b] = dm.between;
    const channelId = new Types.ObjectId();
    const first = resolveWhen(dm.lines[0]!.when, now);
    await Channel.collection.insertOne({
      _id: channelId,
      kind: 'dm',
      name: '',
      topic: '',
      createdBy: userIds[dm.lines[0]!.by],
      isDefault: false,
      dmKey: dmKeyFor(userIds[a].toString(), userIds[b].toString()),
      memberCount: 2,
      lastMessageAt: null,
      createdAt: first,
      updatedAt: first,
    });
    await Membership.insertMany(
      [a, b].map((p) => ({
        channelId,
        userId: userIds[p],
        role: 'member',
        joinedAt: first,
        lastReadId: null,
      })),
    );
    await writeConversation(channelId, [a, b], dm.lines, (p) => {
      const other = p === a ? b : a;
      return UNREAD[p]?.[`dm:${other}`] ?? 0;
    });
    channelCount += 1;
  }

  return { people: keys.length, channels: channelCount, messages: messageCount };
}
