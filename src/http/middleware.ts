import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import type { Logger } from 'pino';
import { HttpError, isDuplicateKey, unauthorized } from '../lib/errors.js';
import type { TokenService } from '../lib/tokens.js';

const AUTH = Symbol('auth');
type WithAuth = Request & { [AUTH]?: string };

/** Requires "Authorization: Bearer <access token>". */
export function requireAuth(tokens: TokenService): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const header = req.get('authorization') ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) throw unauthorized();
    (req as WithAuth)[AUTH] = (await tokens.verifyAccess(token)).userId;
    next();
  };
}

export function userIdOf(req: Request): string {
  const id = (req as WithAuth)[AUTH];
  if (!id) throw unauthorized();
  return id;
}

/**
 * Cookie-based endpoints (refresh, logout) also need this header. A plain cross-site form
 * can't set it, and a script on another site would need CORS approval first.
 */
export const requireAppHeader: RequestHandler = (req, _res, next) => {
  if (req.get('x-guff-client') !== 'web') throw new HttpError(403, 'Missing X-Guff-Client header.');
  next();
};

export function errorHandler(log: Logger): ErrorRequestHandler {
  return (error: unknown, req, res, _next) => {
    if (error instanceof HttpError) {
      res.status(error.status).json({ message: error.message });
      return;
    }
    if (error instanceof multer.MulterError) {
      const tooBig = error.code === 'LIMIT_FILE_SIZE';
      res.status(tooBig ? 413 : 400).json({
        message: tooBig ? 'That file is too large.' : 'Send one file in a field called "file".',
      });
      return;
    }
    if (error instanceof mongoose.Error.CastError) {
      res.status(404).json({ message: 'That item doesn’t exist.' });
      return;
    }
    if (isDuplicateKey(error)) {
      res.status(409).json({ message: 'That already exists.' });
      return;
    }
    const status = (error as { status?: number; type?: string }).status;
    if (status === 400 && (error as { type?: string }).type === 'entity.parse.failed') {
      res.status(400).json({ message: 'The request body isn’t valid JSON.' });
      return;
    }
    if (status === 404) {
      // A website file that doesn't exist (an old asset after a new deploy, say).
      res.status(404).json({ message: 'Not found.' });
      return;
    }
    if (status === 413) {
      res.status(413).json({ message: 'That request is too large.' });
      return;
    }
    log.error({ err: error, method: req.method, url: req.originalUrl }, 'request failed');
    res.status(500).json({ message: 'Something went wrong on the server. Try again.' });
  };
}
