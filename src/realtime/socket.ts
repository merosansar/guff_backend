import type { Server as HttpServer } from 'node:http';
import type { Logger } from 'pino';
import { Server, type Socket } from 'socket.io';
import { z } from 'zod';
import { HttpError, describeZodError } from '../lib/errors.js';
import { objectIdString } from '../lib/ids.js';
import { TokenBucket } from '../lib/rate-limiter.js';
import type { TokenService } from '../lib/tokens.js';
import { Channel, type ChannelDoc } from '../models/channel.js';
import { Membership } from '../models/membership.js';
import { User } from '../models/user.js';
import type { ChannelService } from '../services/channels.js';
import type { Ack, ServerToClientEvents } from '../services/dto.js';
import type { MessageService } from '../services/messages.js';
import type { PeopleService } from '../services/people.js';
import { type RealtimeBus, channelRoom, userRoom } from './bus.js';

/**
 * socket.data travels between API processes (fetchSockets copies it through MongoDB),
 * so it holds plain values only. Timers and rate limiters stay in LocalState.
 */
export interface SocketData {
  userId: string;
  idle: boolean;
}

interface LocalState {
  /** Channel rooms to join, loaded during the handshake. */
  rooms: string[];
  expiryTimer?: NodeJS.Timeout;
  buckets: { messages: TokenBucket; typing: TokenBucket; actions: TokenBucket; calls: TokenBucket };
}

type AckFn = (response: Ack) => void;
type ClientEvents = Record<string, (payload: unknown, ack?: AckFn) => void>;
export type GuffServer = Server<
  ClientEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;
type GuffSocket = Socket<ClientEvents, ServerToClientEvents, Record<string, never>, SocketData>;

const text = z.string().max(4000, 'Messages can be up to 4,000 characters.');
const schemas = {
  send: z.object({
    channelId: objectIdString,
    clientId: z
      .string()
      .min(8)
      .max(64)
      .regex(/^[\w-]+$/)
      .optional(),
    text: text.default(''),
    replyToId: objectIdString.optional(),
    attachmentIds: z.array(objectIdString).max(10, 'Attach up to 10 files at a time.').optional(),
    threadRootId: objectIdString.optional(),
  }),
  edit: z.object({ messageId: objectIdString, text }),
  remove: z.object({ messageId: objectIdString }),
  react: z.object({ messageId: objectIdString, emoji: z.string().min(1).max(16) }),
  read: z.object({ channelId: objectIdString, messageId: objectIdString }),
  typing: z.object({ channelId: objectIdString, typing: z.boolean() }),
  idle: z.object({ idle: z.boolean() }),
  renew: z.object({ token: z.string().min(10) }),
  callInvite: z.object({
    callId: z.string().regex(/^[\w-]{8,64}$/),
    channelId: objectIdString,
    video: z.boolean(),
  }),
  callReply: z.object({
    callId: z.string().regex(/^[\w-]{8,64}$/),
    channelId: objectIdString,
    toSocketId: z.string().min(1).max(64),
  }),
  callSignal: z.object({
    callId: z.string().regex(/^[\w-]{8,64}$/),
    channelId: objectIdString,
    toSocketId: z.string().min(1).max(64),
    data: z.unknown(),
  }),
  callEnd: z.object({
    callId: z.string().regex(/^[\w-]{8,64}$/),
    channelId: objectIdString,
    /** Only the caller logs the call, once: "missed" if nobody answered. */
    log: z.enum(['missed', 'ended']).optional(),
    durationSec: z.number().int().min(0).max(86_400).optional(),
    video: z.boolean().optional(),
  }),
};

const formatDuration = (sec: number) =>
  sec < 60 ? `${sec} sec` : sec < 3600 ? `${Math.round(sec / 60)} min` : `${Math.floor(sec / 3600)} h ${Math.round((sec % 3600) / 60)} min`;

export interface RealtimeDeps {
  tokens: TokenService;
  bus: RealtimeBus;
  channels: ChannelService;
  messages: MessageService;
  people: PeopleService;
  log: Logger;
  corsOrigin: string[];
}

export function createSocketServer(httpServer: HttpServer, deps: RealtimeDeps): GuffServer {
  const { tokens, bus, channels, messages, people, log } = deps;
  const io: GuffServer = new Server(httpServer, {
    path: '/socket.io',
    serveClient: false,
    cors: { origin: deps.corsOrigin, credentials: true },
    maxHttpBufferSize: 64 * 1024,
  });
  bus.attach(io as unknown as Server);
  const local = new WeakMap<GuffSocket, LocalState>();

  // Every connection must bring a valid access token, checked once here...
  io.use(async (socket, next) => {
    try {
      const token = (socket.handshake.auth as { token?: unknown }).token;
      if (typeof token !== 'string') throw new Error('unauthorized');
      const claims = await tokens.verifyAccess(token);
      if (!(await User.exists({ _id: claims.userId }))) throw new Error('unauthorized');
      const memberships = await Membership.find({ userId: claims.userId }, { channelId: 1 }).lean();
      socket.data = { userId: claims.userId, idle: false };
      local.set(socket, {
        rooms: memberships.map((m) => channelRoom(m.channelId.toString())),
        buckets: {
          messages: new TokenBucket(8, 1),
          typing: new TokenBucket(6, 1),
          actions: new TokenBucket(20, 3),
          // Call setup sends a burst of ICE candidates.
          calls: new TokenBucket(120, 20),
        },
      });
      scheduleExpiry(socket, claims.exp);
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  // ...and the socket is closed when that token expires, unless the browser renews it.
  function scheduleExpiry(socket: GuffSocket, exp: number) {
    const state = local.get(socket)!;
    clearTimeout(state.expiryTimer);
    const ms = Math.max(exp * 1000 - Date.now(), 0);
    state.expiryTimer = setTimeout(
      () => {
        socket.emit('auth:expired');
        socket.disconnect(true);
      },
      Math.min(ms, 2 ** 31 - 1),
    );
  }

  // Handlers are registered synchronously, so nothing the browser sends right after
  // connecting can arrive before there is someone listening.
  io.on('connection', (socket) => {
    const { userId } = socket.data;
    const state = local.get(socket)!;
    socket.join([userRoom(userId), ...state.rooms]);
    void people.announce(userId);

    const handle = <S extends z.ZodType>(
      event: string,
      schema: S,
      bucket: keyof LocalState['buckets'] | null,
      fn: (input: z.infer<S>) => Promise<unknown>,
    ) => {
      socket.on(event, async (payload: unknown, ack?: AckFn) => {
        const reply: AckFn = typeof ack === 'function' ? ack : () => {};
        if (bucket && !state.buckets[bucket].take()) {
          return reply({
            ok: false,
            error: {
              status: 429,
              message: 'You’re going a bit fast. Wait a moment and try again.',
            },
          });
        }
        const parsed = schema.safeParse(payload);
        if (!parsed.success)
          return reply({
            ok: false,
            error: { status: 400, message: describeZodError(parsed.error) },
          });
        try {
          reply({ ok: true, data: await fn(parsed.data) });
        } catch (error) {
          if (error instanceof HttpError)
            return reply({ ok: false, error: { status: error.status, message: error.message } });
          log.error({ err: error, event }, 'socket handler failed');
          reply({
            ok: false,
            error: { status: 500, message: 'Something went wrong on the server. Try again.' },
          });
        }
      });
    };

    handle(
      'message:send',
      schemas.send,
      'messages',
      async (input) => (await messages.send(userId, input)).message,
    );
    handle('message:edit', schemas.edit, 'actions', (input) =>
      messages.edit(userId, input.messageId, input.text),
    );
    handle('message:delete', schemas.remove, 'actions', (input) =>
      messages.remove(userId, input.messageId),
    );
    handle('reaction:toggle', schemas.react, 'actions', (input) =>
      messages.toggleReaction(userId, input.messageId, input.emoji),
    );
    handle('channel:read', schemas.read, null, (input) =>
      channels.markRead(userId, input.channelId, input.messageId),
    );

    // Typing is relayed, never stored. Only to channels this socket is in.
    socket.on('typing', (payload: unknown) => {
      const parsed = schemas.typing.safeParse(payload);
      if (!parsed.success || !state.buckets.typing.take()) return;
      const room = channelRoom(parsed.data.channelId);
      if (!socket.rooms.has(room)) return;
      socket
        .to(room)
        .emit('typing', { channelId: parsed.data.channelId, userId, typing: parsed.data.typing });
    });

    handle('presence:idle', schemas.idle, 'actions', async (input) => {
      if (socket.data.idle !== input.idle) {
        socket.data.idle = input.idle;
        await people.announce(userId);
      }
      return null;
    });

    handle('auth:renew', schemas.renew, 'actions', async (input) => {
      const claims = await tokens.verifyAccess(input.token);
      if (claims.userId !== userId) throw new HttpError(401, 'That token belongs to someone else.');
      scheduleExpiry(socket, claims.exp);
      return null;
    });

    // ---- calls: the server only relays between the two people in a DM ----------------

    /** The other person in a DM you're in. Calls only happen one to one. */
    const partnerIn = async (channelId: string): Promise<string> => {
      const channel = await Channel.findById(channelId).lean<ChannelDoc>();
      if (!channel || channel.kind !== 'dm') throw new HttpError(400, 'Calls work in direct messages.');
      const members = await Membership.find({ channelId: channel._id }, { userId: 1 }).lean();
      if (!members.some((m) => m.userId.equals(userId))) throw new HttpError(404, 'That conversation doesn’t exist.');
      const other = members.find((m) => !m.userId.equals(userId));
      if (!other) throw new HttpError(400, 'You can’t call yourself.');
      return other.userId.toString();
    };
    /** Signals go to one tab, and only a tab of the person you're talking to. */
    const partnerSocket = async (channelId: string, socketId: string) => {
      const partner = await partnerIn(channelId);
      const sockets = await io.in(userRoom(partner)).fetchSockets();
      if (!sockets.some((s) => s.id === socketId)) throw new HttpError(410, 'The call ended.');
      return partner;
    };

    handle('call:invite', schemas.callInvite, 'actions', async (input) => {
      const partner = await partnerIn(input.channelId);
      const online = await io.in(userRoom(partner)).fetchSockets();
      if (online.length === 0) throw new HttpError(409, 'They’re offline right now. Try again later.');
      io.to(userRoom(partner)).emit('call:incoming', {
        callId: input.callId,
        channelId: input.channelId,
        fromUserId: userId,
        fromSocketId: socket.id,
        video: input.video,
      });
      return null;
    });
    handle('call:accept', schemas.callReply, 'calls', async (input) => {
      await partnerSocket(input.channelId, input.toSocketId);
      const event = { callId: input.callId, bySocketId: socket.id, byUserId: userId };
      io.to(input.toSocketId).emit('call:accepted', event);
      // Your other tabs stop ringing.
      socket.to(userRoom(userId)).emit('call:accepted', event);
      return null;
    });
    handle('call:decline', schemas.callReply, 'calls', async (input) => {
      await partnerSocket(input.channelId, input.toSocketId);
      io.to(input.toSocketId).emit('call:declined', { callId: input.callId, reason: 'declined' });
      socket.to(userRoom(userId)).emit('call:ended', { callId: input.callId });
      return null;
    });
    handle('call:signal', schemas.callSignal, 'calls', async (input) => {
      await partnerSocket(input.channelId, input.toSocketId);
      io.to(input.toSocketId).emit('call:signal', { callId: input.callId, fromSocketId: socket.id, data: input.data });
      return null;
    });
    handle('call:end', schemas.callEnd, 'calls', async (input) => {
      const partner = await partnerIn(input.channelId);
      io.to([userRoom(partner), userRoom(userId)]).emit('call:ended', { callId: input.callId });
      if (input.log) {
        const kind = input.video ? 'video call' : 'call';
        await messages.system(
          userId,
          input.channelId,
          input.log === 'missed'
            ? `started a ${kind} · no answer`
            : `had a ${kind} · ${formatDuration(input.durationSec ?? 0)}`,
        );
      }
      return null;
    });

    socket.on('disconnect', () => {
      clearTimeout(state.expiryTimer);
      void people.announce(userId, true);
    });
  });

  return io;
}
