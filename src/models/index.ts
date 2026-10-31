import { Channel } from './channel.js';
import { Membership } from './membership.js';
import { Message } from './message.js';
import { Session } from './session.js';
import { User } from './user.js';

export { Channel, Membership, Message, Session, User };
export const ALL_MODELS = [User, Channel, Membership, Message, Session] as const;

/** Builds every index the models declare. Safe to run on every start. */
export async function ensureIndexes(): Promise<void> {
  await Promise.all(ALL_MODELS.map((m) => m.createIndexes()));
}
