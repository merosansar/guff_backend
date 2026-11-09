import { Channel } from './channel.js';
import {
  AuthToken,
  Bookmark,
  LinkCache,
  PushSubscription,
  Scheduled,
  Setting,
  Webhook,
} from './extras.js';
import { Membership } from './membership.js';
import { Message } from './message.js';
import { Session } from './session.js';
import { User } from './user.js';

export {
  AuthToken,
  Bookmark,
  Channel,
  LinkCache,
  Membership,
  Message,
  PushSubscription,
  Scheduled,
  Session,
  Setting,
  User,
  Webhook,
};
export const ALL_MODELS = [
  User,
  Channel,
  Membership,
  Message,
  Session,
  Bookmark,
  Scheduled,
  AuthToken,
  PushSubscription,
  Webhook,
  LinkCache,
  Setting,
] as const;

/** Builds every index the models declare. Safe to run on every start. */
export async function ensureIndexes(): Promise<void> {
  await Promise.all(ALL_MODELS.map((m) => m.createIndexes()));
}
