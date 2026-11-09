import mongoose from 'mongoose';
import { type Socket, io as connect } from 'socket.io-client';
import { type Guff, type GuffOptions, connectDatabase, createGuff } from '../src/app.js';
import { type Env, loadEnvFile, readEnv } from '../src/config/env.js';
import { createLogger } from '../src/lib/logger.js';
import { Channel } from '../src/models/index.js';
import type { Ack } from '../src/services/dto.js';

loadEnvFile();

export const TEST_SECRET = 'test-secret-that-is-long-enough-for-hs256-0123456789';

/** Tests use their own database ("guff_test" by default) on the configured MongoDB. */
export function testEnv(overrides: Record<string, string> = {}): Env {
  return readEnv({
    ...process.env,
    NODE_ENV: 'test',
    MONGODB_DB: process.env.TEST_MONGODB_DB ?? 'guff_test',
    JWT_SECRET: TEST_SECRET,
    AUTH_RATE_LIMIT: '1000',
    DEMO_REPLIES: 'false',
    SOCKET_ADAPTER: 'memory',
    LOG_LEVEL: 'silent',
    ...overrides,
  });
}

export const silentLog = createLogger('silent', true);

/** Empties every collection but keeps the indexes. */
export async function clearDatabase(): Promise<void> {
  const db = mongoose.connection.db!;
  for (const c of await db.listCollections({}, { nameOnly: false }).toArray()) {
    const options = (c as { options?: { capped?: boolean } }).options;
    if (c.name.startsWith('system.') || options?.capped) continue;
    await db.collection(c.name).deleteMany({});
  }
}

export interface TestApp {
  guff: Guff;
  url: string;
  env: Env;
  close(): Promise<void>;
}

export async function startApp(
  overrides: Record<string, string> = {},
  options: GuffOptions = {},
): Promise<TestApp> {
  const env = testEnv(overrides);
  await connectDatabase(env);
  const guff = await createGuff(env, silentLog, { previews: null, ...options });
  const port = await guff.listen(0);
  return { guff, url: `http://127.0.0.1:${port}`, env, close: () => guff.close() };
}

/** The #general channel every new person joins. */
export async function createGeneral(ownerId?: string) {
  return Channel.create({
    kind: 'public',
    name: 'general',
    topic: 'Everyone',
    isDefault: true,
    createdBy: ownerId ?? new mongoose.Types.ObjectId(),
  });
}

export interface TestUser {
  id: string;
  token: string;
  refreshToken: string;
  name: string;
}

let counter = 0;
export async function makeUser(app: TestApp, name = `Person ${++counter}`): Promise<TestUser> {
  const email = `${name.toLowerCase().replace(/\W+/g, '.')}.${Date.now()}.${++counter}@test.local`;
  const result = await app.guff.services.auth.register({ name, email, password: 'password123' });
  return {
    id: result.session.user.id,
    token: result.session.accessToken,
    refreshToken: result.refreshToken,
    name,
  };
}

export const bearer = (user: TestUser) => ({ authorization: `Bearer ${user.token}` });

const openSockets = new Set<Socket>();

export function connectSocket(app: TestApp, token: string): Promise<Socket> {
  const socket = connect(app.url, {
    auth: { token },
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
  });
  openSockets.add(socket);
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (error) => reject(error));
  });
}

export function closeSockets(): void {
  for (const s of openSockets) s.disconnect();
  openSockets.clear();
}

export function emit<T = unknown>(
  socket: Socket,
  event: string,
  payload: unknown,
): Promise<Ack<T>> {
  return socket.timeout(5000).emitWithAck(event, payload) as Promise<Ack<T>>;
}

export async function emitOk<T = unknown>(
  socket: Socket,
  event: string,
  payload: unknown,
): Promise<T> {
  const ack = await emit<T>(socket, event, payload);
  if (!ack.ok) throw new Error(`${event} failed: ${ack.error.status} ${ack.error.message}`);
  return ack.data;
}

/** Resolves with the first event that matches, or rejects after `ms`. */
export function waitFor<T = unknown>(
  socket: Socket,
  event: string,
  match: (payload: T) => boolean = () => true,
  ms = 3000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out waiting for "${event}"`));
    }, ms);
    const handler = (payload: T) => {
      if (!match(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

/** Fails if the event arrives within `ms`. */
export function expectSilence(
  socket: Socket,
  event: string,
  match: (p: unknown) => boolean = () => true,
  ms = 400,
) {
  return new Promise<void>((resolve, reject) => {
    const handler = (payload: unknown) => {
      if (!match(payload)) return;
      socket.off(event, handler);
      clearTimeout(timer);
      reject(new Error(`Did not expect "${event}"`));
    };
    const timer = setTimeout(() => {
      socket.off(event, handler);
      resolve();
    }, ms);
    socket.on(event, handler);
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const clientId = () => `c-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
