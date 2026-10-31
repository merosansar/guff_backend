import type { Server } from 'socket.io';
import type { ServerToClientEvents } from '../services/dto.js';

type EventName = keyof ServerToClientEvents;
type Payload<E extends EventName> = Parameters<ServerToClientEvents[E]>;

export const userRoom = (userId: string) => `user:${userId}`;
export const channelRoom = (channelId: string) => `ch:${channelId}`;

/**
 * How services talk to connected browsers. Rooms: every socket of a person is in
 * "user:<id>", and in "ch:<id>" for each channel they belong to. With the MongoDB
 * adapter these calls reach sockets on every API process, not just this one.
 */
export class RealtimeBus {
  private io: Server | null = null;

  attach(io: Server): void {
    this.io = io;
  }

  toChannel<E extends EventName>(channelId: string, event: E, ...payload: Payload<E>): void {
    this.io?.to(channelRoom(channelId)).emit(event, ...(payload as never[]));
  }

  toUser<E extends EventName>(userId: string, event: E, ...payload: Payload<E>): void {
    this.io?.to(userRoom(userId)).emit(event, ...(payload as never[]));
  }

  toAll<E extends EventName>(event: E, ...payload: Payload<E>): void {
    this.io?.emit(event, ...(payload as never[]));
  }

  /** Puts every open tab of this person into the channel's room. */
  joinChannel(userId: string, channelId: string): void {
    this.io?.in(userRoom(userId)).socketsJoin(channelRoom(channelId));
  }

  leaveChannel(userId: string, channelId: string): void {
    this.io?.in(userRoom(userId)).socketsLeave(channelRoom(channelId));
  }

  /** Socket counts per person, across every API process. */
  async connectedUsers(): Promise<Map<string, { sockets: number; idle: number }>> {
    const result = new Map<string, { sockets: number; idle: number }>();
    if (!this.io) return result;
    for (const s of await this.io.fetchSockets()) {
      const data = s.data as { userId?: string; idle?: boolean };
      if (!data.userId) continue;
      const entry = result.get(data.userId) ?? { sockets: 0, idle: 0 };
      entry.sockets += 1;
      if (data.idle) entry.idle += 1;
      result.set(data.userId, entry);
    }
    return result;
  }

  async userSockets(userId: string): Promise<{ sockets: number; idle: number }> {
    if (!this.io) return { sockets: 0, idle: 0 };
    const sockets = await this.io.in(userRoom(userId)).fetchSockets();
    return {
      sockets: sockets.length,
      idle: sockets.filter((s) => (s.data as { idle?: boolean }).idle).length,
    };
  }
}
