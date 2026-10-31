import { notFound } from '../lib/errors.js';
import { User, type UserDoc, toPublicUser } from '../models/user.js';
import type { RealtimeBus } from '../realtime/bus.js';
import type { PresenceStatus, UserWithPresence } from './dto.js';

type Counts = { sockets: number; idle: number };

/**
 * Who's here. A person is online if any of their tabs is connected, away if every
 * connected tab has been idle, and offline otherwise. Demo teammates count as online
 * while demo replies are on.
 */
export class PeopleService {
  constructor(
    private readonly bus: RealtimeBus,
    private readonly demoReplies: boolean,
  ) {}

  statusOf(user: Pick<UserDoc, 'demoBot'>, counts: Counts | undefined): PresenceStatus {
    if (counts && counts.sockets > 0) return counts.idle === counts.sockets ? 'away' : 'online';
    return this.demoReplies && user.demoBot ? 'online' : 'offline';
  }

  async withPresence(user: UserDoc, counts?: Counts): Promise<UserWithPresence> {
    const c = counts ?? (await this.bus.userSockets(user._id.toString()));
    return {
      ...toPublicUser(user),
      status: this.statusOf(user, c),
      demo: this.demoReplies && user.demoBot,
    };
  }

  async list(): Promise<UserWithPresence[]> {
    const [users, connected] = await Promise.all([
      User.find().sort({ name: 1 }).lean<UserDoc[]>(),
      this.bus.connectedUsers(),
    ]);
    return users.map((u) => ({
      ...toPublicUser(u),
      status: this.statusOf(u, connected.get(u._id.toString())),
      demo: this.demoReplies && u.demoBot,
    }));
  }

  async get(id: string): Promise<UserWithPresence> {
    const user = await User.findById(id).lean<UserDoc>();
    if (!user) throw notFound('That person doesn’t have an account.');
    return this.withPresence(user);
  }

  async updateProfile(
    id: string,
    input: { name?: string | undefined; title?: string | undefined },
  ): Promise<UserWithPresence> {
    const changes: Record<string, string> = {};
    if (input.name !== undefined) changes.name = input.name.trim();
    if (input.title !== undefined) changes.title = input.title.trim();
    const user = await User.findByIdAndUpdate(
      id,
      { $set: changes },
      { returnDocument: 'after' },
    ).lean<UserDoc>();
    if (!user) throw notFound('That person doesn’t have an account.');
    const dto = await this.withPresence(user);
    this.bus.toAll('user:upsert', dto);
    return dto;
  }

  /** Called whenever one of a person's tabs connects, disconnects or goes idle. */
  async announce(userId: string, disconnected = false): Promise<void> {
    const counts = await this.bus.userSockets(userId);
    let user: UserDoc | null;
    if (disconnected && counts.sockets === 0) {
      user = await User.findByIdAndUpdate(
        userId,
        { $set: { lastSeenAt: new Date() } },
        { returnDocument: 'after' },
      ).lean<UserDoc>();
    } else {
      user = await User.findById(userId).lean<UserDoc>();
    }
    if (!user) return;
    this.bus.toAll('presence', {
      userId,
      status: this.statusOf(user, counts),
      lastSeenAt: user.lastSeenAt ? user.lastSeenAt.toISOString() : null,
    });
  }
}
