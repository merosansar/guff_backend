import { Router, type CookieOptions, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
import multer from 'multer';
import { z } from 'zod';
import type { Env } from '../config/env.js';
import { badRequest, notFound, parse } from '../lib/errors.js';
import { objectIdString } from '../lib/ids.js';
import type { TokenService } from '../lib/tokens.js';
import type { AuthService, SessionResult } from '../services/auth.js';
import type { ChannelService } from '../services/channels.js';
import type { FileService } from '../services/files.js';
import type { MessageService } from '../services/messages.js';
import type { PeopleService } from '../services/people.js';
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
  const { env, tokens, auth, people, channels, messages, files } = deps;
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
    res.status(201).json(await files.upload(userIdOf(req), req.file));
  });

  // No bearer token here: <img> tags can't send one. The signed link is the permission.
  router.get('/files/:id', async (req, res) => {
    const q = parse(schemas.file, req.query);
    const file = await files.open(id(req), q.exp, q.sig);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Length', String(file.size));
    res.setHeader(
      'Content-Disposition',
      contentDisposition(file.inline ? 'inline' : 'attachment', file.name),
    );
    res.setHeader('Cache-Control', 'private, max-age=86400');
    if (file.contentType !== 'application/pdf')
      res.setHeader('Content-Security-Policy', "default-src 'none'");
    const stream = file.stream();
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });

  // Express 5 passes errors thrown in async handlers (like the ones above) to the error handler.
  router.use((_req, _res) => {
    throw notFound('There’s nothing at that address.');
  });

  return router;
}
