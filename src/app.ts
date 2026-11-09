import { existsSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import { join } from 'node:path';
import { createAdapter } from '@socket.io/mongo-adapter';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import mongoose from 'mongoose';
import type { Logger } from 'pino';
import { BACKEND_DIR, type Env } from './config/env.js';
import { errorHandler } from './http/middleware.js';
import { apiRoutes } from './http/routes.js';
import { connectWithDnsFallback, tidyConnectionString } from './lib/mongo.js';
import { TokenService } from './lib/tokens.js';
import { ensureIndexes } from './models/index.js';
import { RealtimeBus } from './realtime/bus.js';
import { type GuffServer, createSocketServer } from './realtime/socket.js';
import { AiService } from './services/ai.js';
import { AuthService } from './services/auth.js';
import { ChannelService } from './services/channels.js';
import { DemoReplies } from './services/demo-replies.js';
import { FileService } from './services/files.js';
import { cachedPreviews } from './services/links.js';
import { type Mailer, createMailer } from './services/mail.js';
import { MessageService, type PreviewFetcher } from './services/messages.js';
import { PeopleService } from './services/people.js';
import { PushService } from './services/push.js';
import { Scheduler } from './services/scheduler.js';
import { WebhookService } from './services/webhooks.js';

const ADAPTER_COLLECTION = 'socket.io-adapter-events';
/** Where `npm run build` in guff_frontend/ puts the website. */
export const WEB_DIR = join(BACKEND_DIR, '..', 'guff_frontend', 'dist');

function trustProxySetting(value: string): boolean | number | string {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return /^\d+$/.test(value) ? Number(value) : value;
}

export interface Guff {
  app: express.Express;
  httpServer: HttpServer;
  io: GuffServer;
  services: {
    tokens: TokenService;
    channels: ChannelService;
    messages: MessageService;
    people: PeopleService;
    files: FileService;
    auth: AuthService;
    scheduler: Scheduler;
    webhooks: WebhookService;
    push: PushService;
    ai: AiService;
  };
  listen(port: number): Promise<number>;
  close(): Promise<void>;
}

/** Connects to MongoDB once per process (tests start several Guff instances on one connection). */
export async function connectDatabase(env: Env): Promise<void> {
  if (mongoose.connection.readyState === 1) return;
  // Request data reaches queries only after zod has turned it into plain strings and
  // numbers, so operator injection like {"$gt": ""} can't get through.
  mongoose.set('strictQuery', true);
  const tidy = tidyConnectionString(env.MONGODB_URI);
  if (!tidy.ok) throw new Error(`MONGODB_URI in guff_backend/.env: ${tidy.problem}`);
  await connectWithDnsFallback(tidy.uri, env.MONGODB_DB);
  await ensureIndexes();
}

/**
 * The built website, from the same address as the API: no cross-site cookies, and the
 * real-time connection goes to the same host. Unknown paths get index.html (the app's routes).
 */
function serveWebsite(app: express.Express): void {
  const index = join(WEB_DIR, 'index.html');
  if (!existsSync(index)) {
    throw new Error(
      `SERVE_WEB is on, but ${index} is missing. Run "npm run build" in guff_frontend/ first.`,
    );
  }
  // File names in assets/ contain a hash of their content, so they can be cached for good.
  app.use(
    '/assets',
    express.static(join(WEB_DIR, 'assets'), {
      immutable: true,
      maxAge: '365d',
      fallthrough: false,
    }),
  );
  app.use(express.static(WEB_DIR, { index: false, maxAge: '1h' }));
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path.startsWith('/api/') || req.path === '/api') return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(index);
  });
}

async function supportsChangeStreams(): Promise<boolean> {
  const hello = await mongoose.connection.db!.admin().command({ hello: 1 });
  return Boolean(hello.setName || hello.msg === 'isdbgrid');
}

/** The free public STUN server lets calls find a path through most home routers. */
function iceServersFrom(raw: string, log: Logger): unknown[] {
  const servers: unknown[] = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (!raw.trim()) return servers;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return [...servers, ...parsed];
  } catch {
    /* reported below */
  }
  log.warn('ICE_SERVERS is not a JSON list; calls will only use the public STUN server');
  return servers;
}

export interface GuffOptions {
  /** Replace the mailer (tests read the emails it collects). */
  mailer?: Mailer;
  /** Replace how link previews are fetched (tests don't go on the internet). */
  previews?: PreviewFetcher | null;
}

export async function createGuff(env: Env, log: Logger, options: GuffOptions = {}): Promise<Guff> {
  const corsOrigin = env.CORS_ORIGIN.split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  const tokens = new TokenService(env.JWT_SECRET, env.ACCESS_TOKEN_TTL_SECONDS);
  const bus = new RealtimeBus();
  const files = new FileService(tokens);
  const channels = new ChannelService(bus);
  const messages = new MessageService(bus, channels, files);
  const people = new PeopleService(bus, env.DEMO_REPLIES);
  const mailer = options.mailer ?? createMailer({ apiKey: env.RESEND_API_KEY, from: env.MAIL_FROM, log });
  const auth = new AuthService(tokens, env.REFRESH_TOKEN_TTL_DAYS, channels, people, bus, {
    mailer,
    appUrl: env.APP_URL,
    log,
  });
  const previews = options.previews !== undefined ? options.previews : env.LINK_PREVIEWS ? cachedPreviews() : null;
  if (previews) messages.usePreviews(previews);
  const scheduler = new Scheduler(channels, messages, bus, log);
  const webhooks = new WebhookService(channels, messages, env.APP_URL);
  const push = new PushService(bus, log, env.VAPID_SUBJECT);
  await push.init({ publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY });
  push.listen(messages);
  const ai = new AiService(channels, env.ANTHROPIC_API_KEY, env.AI_MODEL, log);
  const iceServers = iceServersFrom(env.ICE_SERVERS, log);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxySetting(env.TRUST_PROXY));
  app.use(
    helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'same-site' } }),
  );
  app.use(cors({ origin: corsOrigin, credentials: true }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use(
    '/api',
    apiRoutes({
      env,
      tokens,
      auth,
      people,
      channels,
      messages,
      files,
      scheduler,
      webhooks,
      push,
      ai,
      iceServers,
    }),
  );
  if (env.SERVE_WEB) {
    serveWebsite(app);
  } else {
    app.get('/', (_req, res) => {
      res.type('text').send('Guff API. The app runs on the website; the API is under /api.');
    });
  }
  app.use(errorHandler(log));

  const httpServer = createServer(app);
  const io = createSocketServer(httpServer, {
    tokens,
    bus,
    channels,
    messages,
    people,
    log,
    corsOrigin,
  });

  if (env.SOCKET_ADAPTER === 'mongo') {
    if (!(await supportsChangeStreams())) {
      throw new Error(
        'SOCKET_ADAPTER=mongo needs a replica set (MongoDB Atlas is one). Use SOCKET_ADAPTER=memory for a single server.',
      );
    }
    const db = mongoose.connection.db!;
    const existing = await db.listCollections({ name: ADAPTER_COLLECTION }).toArray();
    if (existing.length === 0) {
      await db.createCollection(ADAPTER_COLLECTION, { capped: true, size: 1_000_000 });
    }
    io.adapter(createAdapter(db.collection(ADAPTER_COLLECTION)));
    log.info('real-time events are shared between API processes through MongoDB');
  }

  const demo = new DemoReplies(messages, bus, log);
  if (env.DEMO_REPLIES) demo.start();

  const orphanSweep = setInterval(() => {
    files
      .removeOrphans()
      .catch((error: unknown) => log.warn({ err: error }, 'orphan sweep failed'));
  }, 3_600_000);
  orphanSweep.unref();
  if (env.NODE_ENV !== 'test') scheduler.start(env.SCHEDULER_INTERVAL_MS);

  return {
    app,
    httpServer,
    io,
    services: { tokens, channels, messages, people, files, auth, scheduler, webhooks, push, ai },
    listen: (port) =>
      new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, () => {
          const address = httpServer.address();
          resolve(typeof address === 'object' && address ? address.port : port);
        });
      }),
    close: async () => {
      clearInterval(orphanSweep);
      scheduler.stop();
      demo.stop();
      await new Promise<void>((resolve) => io.close(() => resolve()));
      if (httpServer.listening)
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
