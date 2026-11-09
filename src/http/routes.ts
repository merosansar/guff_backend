import { Router, type CookieOptions, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
import multer from 'multer';
import { z } from 'zod';
import type { Env } from '../config/env.js';
import { badRequest, notFound, parse } from '../lib/errors.js';
import { objectIdString } from '../lib/ids.js';
import type { TokenService } from '../lib/tokens.js';
import { NOTIFY_LEVELS } from '../models/membership.js';
import type { AiService } from '../services/ai.js';
import type { AuthService, SessionResult } from '../services/auth.js';
import type { ChannelService } from '../services/channels.js';
import type { FileService } from '../services/files.js';
import type { MessageService } from '../services/messages.js';
import type { PeopleService } from '../services/people.js';
import type { PushService } from '../services/push.js';
import type { Scheduler } from '../services/scheduler.js';
import type { WebhookService } from '../services/webhooks.js';
import { requireAppHeader, requireAuth, userIdOf } from './middleware.js';

export const REFRESH_COOKIE = 'guff_refresh';

export interface RouteDeps {
  env: Env;
  tokens: TokenService;
  auth: AuthService;
  people: PeopleService;
  channels: ChannelService;
  messages: MessageService;
  files: FileService;
  scheduler: Scheduler;
  webhooks: WebhookService;
  push: PushService;
  ai: AiService;
  iceServers: unknown[];
}

const email = z.email('Enter a valid email address.').max(254);
const password = z
  .string()
  .min(8, 'Use at least 8 characters for your password.')
  .max(72, 'Passwords can be up to 72 characters.');
const personName = z
  .string()
  .trim()
  .min(2, 'Enter your name.')
  .max(60, 'Names can be up to 60 characters.');

const schemas = {
  register: z.object({ name: personName, email, password }),
  login: z.object({ email, password: z.string().min(1, 'Enter your password.').max(200) }),
  profile: z.object({
    name: personName.optional(),
    title: z.string().trim().max(80, 'Titles can be up to 80 characters.').optional(),
    customStatus: z
      .object({
        emoji: z.string().max(16).default(''),
        text: z.string().trim().max(100, 'A status can be up to 100 characters.').default(''),
        expiresAt: z.coerce.date().nullable().default(null),
      })
      .nullable()
      .optional(),
    dndUntil: z.coerce.date().nullable().optional(),
  }),
  forgot: z.object({ email }),
  reset: z.object({ token: z.string().min(20).max(100), password }),
  token: z.object({ token: z.string().min(20).max(100) }),
  pin: z.object({ pinned: z.boolean() }),
  bookmark: z.object({ saved: z.boolean() }),
  role: z.object({ role: z.enum(['admin', 'member']) }),
  archive: z.object({ archived: z.boolean() }),
  notify: z.object({ level: z.enum(NOTIFY_LEVELS) }),
  schedule: z.object({
    channelId: objectIdString,
    text: z.string().max(4000, 'Messages can be up to 4,000 characters.'),
    sendAt: z.coerce.date(),
    threadRootId: objectIdString.optional(),
  }),
  reminder: z.object({ messageId: objectIdString, remindAt: z.coerce.date() }),
  webhook: z.object({ name: z.string().max(40, 'Names can be up to 40 characters.') }),
  hookPost: z.object({
    text: z.string().min(1, 'Send some "text".').max(4000, 'Messages can be up to 4,000 characters.'),
    username: z.string().max(40).optional(),
  }),
  pushSub: z.object({
    endpoint: z.url().max(1000),
    keys: z.object({ p256dh: z.string().min(40).max(200), auth: z.string().min(10).max(100) }),
  }),
  pushUnsub: z.object({ endpoint: z.string().max(1000) }),
  voice: z.object({
    durationMs: z.coerce.number().min(0).max(10 * 60_000),
    waveform: z
      .string()
      .max(1000)
      .transform((raw, ctx) => {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.every((n) => typeof n === 'number')) return parsed as number[];
        } catch {
          /* fall through */
        }
        ctx.addIssue({ code: 'custom', message: 'The waveform isn’t valid.' });
        return z.NEVER;
      }),
  }),
  createChannel: z.object({
    name: z.string().min(1, 'Give the channel a name.').max(60),
    topic: z.string().trim().max(250, 'Topics can be up to 250 characters.').optional(),
    kind: z.enum(['public', 'private']).default('public'),
    memberIds: z.array(objectIdString).max(100).optional(),
  }),
  updateChannel: z.object({
    name: z.string().min(1).max(60).optional(),
    topic: z.string().max(250, 'Topics can be up to 250 characters.').optional(),
  }),
  addMembers: z.object({
    userIds: z.array(objectIdString).min(1, 'Choose at least one person.').max(100),
  }),
  page: z.object({
    before: objectIdString.optional(),
    after: objectIdString.optional(),
    around: objectIdString.optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  }),
  send: z.object({
    clientId: z
      .string()
      .min(8)
      .max(64)
      .regex(/^[\w-]+$/)
      .optional(),
    text: z.string().max(4000, 'Messages can be up to 4,000 characters.').default(''),
    replyToId: objectIdString.optional(),
    attachmentIds: z.array(objectIdString).max(10, 'Attach up to 10 files at a time.').optional(),
    threadRootId: objectIdString.optional(),
  }),
  edit: z.object({ text: z.string().max(4000, 'Messages can be up to 4,000 characters.') }),
  react: z.object({ emoji: z.string().min(1).max(16) }),
  read: z.object({ messageId: objectIdString }),
  dm: z.object({ userId: objectIdString }),
  search: z.object({ q: z.string().max(200).default('') }),
  browse: z.object({ q: z.string().max(100).default('') }),
  file: z.object({ exp: z.coerce.number().int(), sig: z.string().min(10).max(100) }),
};

const id = (req: Request, name = 'id') => parse(objectIdString, req.params[name]);

function contentDisposition(type: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function apiRoutes(deps: RouteDeps): Router {
  const { env, tokens, auth, people, channels, messages, files, scheduler, webhooks, push, ai } = deps;
  const router = Router();
  const authed = requireAuth(tokens);

  const cookieOptions = (maxAge?: number): CookieOptions => ({
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production' && !env.CORS_ORIGIN.startsWith('http://'),
    path: '/api/auth',
    ...(maxAge ? { maxAge } : {}),
  });
  const sendSession = (res: Response, result: SessionResult, status = 200) => {
    res.cookie(REFRESH_COOKIE, result.refreshToken, cookieOptions(auth.refreshTtlMs));
    res.status(status).json(result.session);
  };

  const authLimiter = rateLimit({
    windowMs: 10 * 60_000,
    limit: env.AUTH_RATE_LIMIT,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { message: 'Too many attempts. Wait a few minutes and try again.' },
  });

  // ---- health -------------------------------------------------------------
  router.get('/health', (_req, res) => {
    const up = mongoose.connection.readyState === 1;
    res
      .status(up ? 200 : 503)
      .json({ status: up ? 'ok' : 'degraded', database: up ? 'up' : 'down', time: new Date() });
  });

  // ---- auth ---------------------------------------------------------------
  router.post('/auth/register', authLimiter, async (req, res) => {
    sendSession(
      res,
      await auth.register(parse(schemas.register, req.body), req.get('user-agent')),
      201,
    );
  });
  router.post('/auth/login', authLimiter, async (req, res) => {
    sendSession(res, await auth.login(parse(schemas.login, req.body), req.get('user-agent')));
  });
  router.post('/auth/refresh', requireAppHeader, async (req, res) => {
    try {
      sendSession(res, await auth.refresh(req.cookies?.[REFRESH_COOKIE], req.get('user-agent')));
    } catch (error) {
      res.clearCookie(REFRESH_COOKIE, cookieOptions());
      throw error;
    }
  });
  router.post('/auth/logout', requireAppHeader, async (req, res) => {
    await auth.logout(req.cookies?.[REFRESH_COOKIE]);
    res.clearCookie(REFRESH_COOKIE, cookieOptions());
    res.status(204).end();
  });
  router.get('/auth/me', authed, async (req, res) => {
    res.json(await people.get(userIdOf(req)));
  });
  // Forgotten passwords: the same answer whether or not the email has an account.
  router.post('/auth/forgot', authLimiter, async (req, res) => {
    await auth.forgotPassword(parse(schemas.forgot, req.body).email);
    res.status(204).end();
  });
  router.post('/auth/reset', authLimiter, async (req, res) => {
    const input = parse(schemas.reset, req.body);
    await auth.resetPassword(input.token, input.password);
    res.clearCookie(REFRESH_COOKIE, cookieOptions());
    res.status(204).end();
  });
  router.post('/auth/verify-email/send', authed, async (req, res) => {
    await auth.sendVerification(userIdOf(req));
    res.status(204).end();
  });
  router.post('/auth/verify-email', authLimiter, async (req, res) => {
    await auth.verifyEmail(parse(schemas.token, req.body).token);
    res.status(204).end();
  });

  // ---- what this server can do --------------------------------------------------
  router.get('/config', authed, (_req, res) => {
    res.json({
      ai: ai.enabled,
      pushKey: push.publicKey,
      iceServers: deps.iceServers,
      maxUploadMb: env.MAX_UPLOAD_MB,
    });
  });

  // ---- people -------------------------------------------------------------
  router.get('/users', authed, async (_req, res) => {
    res.json(await people.list());
  });
  router.patch('/users/me', authed, async (req, res) => {
    res.json(await people.updateProfile(userIdOf(req), parse(schemas.profile, req.body)));
  });
  router.get('/users/:id', authed, async (req, res) => {
    res.json(await people.get(id(req)));
  });

  // ---- channels -----------------------------------------------------------
  router.get('/channels', authed, async (req, res) => {
    res.json(await channels.listForUser(userIdOf(req)));
  });
  router.get('/channels/browse', authed, async (req, res) => {
    res.json(await channels.browse(userIdOf(req), parse(schemas.browse, req.query).q));
  });
  router.post('/channels', authed, async (req, res) => {
    res
      .status(201)
      .json(await channels.create(userIdOf(req), parse(schemas.createChannel, req.body)));
  });
  router.get('/channels/:id', authed, async (req, res) => {
    res.json(await channels.get(userIdOf(req), id(req)));
  });
  router.patch('/channels/:id', authed, async (req, res) => {
    res.json(await channels.update(userIdOf(req), id(req), parse(schemas.updateChannel, req.body)));
  });
  router.post('/channels/:id/join', authed, async (req, res) => {
    res.json(await channels.join(userIdOf(req), id(req)));
  });
  router.post('/channels/:id/leave', authed, async (req, res) => {
    await channels.leave(userIdOf(req), id(req));
    res.status(204).end();
  });
  router.get('/channels/:id/members', authed, async (req, res) => {
    res.json(await channels.members(userIdOf(req), id(req)));
  });
  router.post('/channels/:id/members', authed, async (req, res) => {
    res.json(
      await channels.addMembers(
        userIdOf(req),
        id(req),
        parse(schemas.addMembers, req.body).userIds,
      ),
    );
  });
  router.post('/channels/:id/read', authed, async (req, res) => {
    await channels.markRead(userIdOf(req), id(req), parse(schemas.read, req.body).messageId);
    res.status(204).end();
  });
  router.post('/channels/:id/members/:userId/role', authed, async (req, res) => {
    await channels.setRole(userIdOf(req), id(req), id(req, 'userId'), parse(schemas.role, req.body).role);
    res.status(204).end();
  });
  router.delete('/channels/:id/members/:userId', authed, async (req, res) => {
    await channels.removeMember(userIdOf(req), id(req), id(req, 'userId'));
    res.status(204).end();
  });
  router.post('/channels/:id/archive', authed, async (req, res) => {
    res.json(await channels.setArchived(userIdOf(req), id(req), parse(schemas.archive, req.body).archived));
  });
  router.put('/channels/:id/notify', authed, async (req, res) => {
    res.json(await channels.setNotify(userIdOf(req), id(req), parse(schemas.notify, req.body).level));
  });
  router.get('/channels/:id/pins', authed, async (req, res) => {
    res.json(await messages.pins(userIdOf(req), id(req)));
  });
  router.post('/channels/:id/summary', authed, async (req, res) => {
    res.json(await ai.summarize(userIdOf(req), id(req)));
  });
  router.get('/channels/:id/webhooks', authed, async (req, res) => {
    res.json(await webhooks.list(userIdOf(req), id(req)));
  });
  router.post('/channels/:id/webhooks', authed, async (req, res) => {
    res.status(201).json(await webhooks.create(userIdOf(req), id(req), parse(schemas.webhook, req.body).name));
  });
  router.delete('/webhooks/:id', authed, async (req, res) => {
    await webhooks.remove(userIdOf(req), id(req));
    res.status(204).end();
  });
  router.post('/dms', authed, async (req, res) => {
    res.json(await channels.openDm(userIdOf(req), parse(schemas.dm, req.body).userId));
  });

  // ---- messages -----------------------------------------------------------
  router.get('/channels/:id/messages', authed, async (req, res) => {
    res.json(await messages.page(userIdOf(req), id(req), parse(schemas.page, req.query)));
  });
  // Browsers send over the socket; this route is for scripts and integrations.
  router.post('/channels/:id/messages', authed, async (req, res) => {
    const result = await messages.send(userIdOf(req), {
      channelId: id(req),
      ...parse(schemas.send, req.body),
    });
    res.status(result.duplicate ? 200 : 201).json(result.message);
  });
  router.patch('/messages/:id', authed, async (req, res) => {
    res.json(await messages.edit(userIdOf(req), id(req), parse(schemas.edit, req.body).text));
  });
  router.delete('/messages/:id', authed, async (req, res) => {
    res.json(await messages.remove(userIdOf(req), id(req)));
  });
  router.post('/messages/:id/reactions', authed, async (req, res) => {
    res.json(
      await messages.toggleReaction(userIdOf(req), id(req), parse(schemas.react, req.body).emoji),
    );
  });
  router.post('/messages/:id/pin', authed, async (req, res) => {
    res.json(await messages.pin(userIdOf(req), id(req), parse(schemas.pin, req.body).pinned));
  });
  router.put('/messages/:id/bookmark', authed, async (req, res) => {
    res.json(await messages.bookmark(userIdOf(req), id(req), parse(schemas.bookmark, req.body).saved));
  });
  router.get('/messages/:id/history', authed, async (req, res) => {
    res.json(await messages.history(userIdOf(req), id(req)));
  });
  router.get('/messages/:id/thread', authed, async (req, res) => {
    res.json(await messages.thread(userIdOf(req), id(req)));
  });
  router.get('/bookmarks', authed, async (req, res) => {
    res.json(await messages.bookmarks(userIdOf(req)));
  });

  // ---- later: scheduled messages and reminders ---------------------------------------
  router.get('/scheduled', authed, async (req, res) => {
    res.json(await scheduler.list(userIdOf(req)));
  });
  router.post('/scheduled', authed, async (req, res) => {
    res.status(201).json(await scheduler.scheduleMessage(userIdOf(req), parse(schemas.schedule, req.body)));
  });
  router.post('/reminders', authed, async (req, res) => {
    const input = parse(schemas.reminder, req.body);
    res.status(201).json(await scheduler.scheduleReminder(userIdOf(req), input.messageId, input.remindAt));
  });
  router.delete('/scheduled/:id', authed, async (req, res) => {
    await scheduler.cancel(userIdOf(req), id(req));
    res.status(204).end();
  });

  // ---- push notifications -----------------------------------------------------------
  router.post('/push/subscribe', authed, async (req, res) => {
    await push.subscribe(userIdOf(req), parse(schemas.pushSub, req.body));
    res.status(204).end();
  });
  router.post('/push/unsubscribe', authed, async (req, res) => {
    await push.unsubscribe(userIdOf(req), parse(schemas.pushUnsub, req.body).endpoint);
    res.status(204).end();
  });

  // ---- incoming webhooks (public: the secret in the URL is the permission) ------------
  const hookLimiter = rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { message: 'Too many requests. Slow down.' },
  });
  router.post('/hooks/:id/:secret', hookLimiter, async (req, res) => {
    const secret = String(req.params.secret ?? '');
    if (!/^[\w-]{20,100}$/.test(secret)) throw notFound('Unknown webhook.');
    const message = await webhooks.post(String(req.params.id), secret, parse(schemas.hookPost, req.body));
    res.status(201).json({ ok: true, id: message.id });
  });

  router.get('/search', authed, async (req, res) => {
    res.json(await messages.search(userIdOf(req), parse(schemas.search, req.query).q));
  });

  // ---- files --------------------------------------------------------------
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
  });
  const uploadLimiter = rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) => userIdOf(req),
    message: { message: 'Too many uploads at once. Wait a minute and try again.' },
  });
  router.post('/uploads', authed, uploadLimiter, upload.single('file'), async (req, res) => {
    if (!req.file) throw badRequest('Choose a file to upload.');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const voice = body.voice === '1' ? parse(schemas.voice, body) : undefined;
    res.status(201).json(await files.upload(userIdOf(req), req.file, voice));
  });

  // No bearer token here: <img> tags can't send one. The signed link is the permission.
  router.get('/files/:id', async (req, res) => {
    const q = parse(schemas.file, req.query);
    const file = await files.open(id(req), q.exp, q.sig);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    // Audio players (Safari in particular) ask for byte ranges.
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.get('range') ?? '');
    let part: { start: number; end: number } | undefined;
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : file.size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : file.size - 1;
      start = Math.max(0, start);
      end = Math.min(end, file.size - 1);
      if (start > end || start >= file.size) {
        res.status(416).setHeader('Content-Range', `bytes */${file.size}`).end();
        return;
      }
      part = { start, end: end + 1 };
      res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${file.size}`);
    }
    res.setHeader('Content-Length', String(part ? part.end - part.start : file.size));
    res.setHeader(
      'Content-Disposition',
      contentDisposition(file.inline ? 'inline' : 'attachment', file.name),
    );
    res.setHeader('Cache-Control', 'private, max-age=86400');
    if (file.contentType !== 'application/pdf')
      res.setHeader('Content-Security-Policy', "default-src 'none'");
    const stream = file.stream(part);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });

  // Express 5 passes errors thrown in async handlers (like the ones above) to the error handler.
  router.use((_req, _res) => {
    throw notFound('There’s nothing at that address.');
  });

  return router;
}
