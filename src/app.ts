import { pipeline } from 'node:stream/promises';
import express, { type Request, type Response } from 'express';
import type { DataSource } from 'typeorm';
import type { appConfig } from './config';
import { ApiError, notFound, sendError } from './errors';
import { createFiles } from './files';
import { listFolder } from './folders';
import { attachmentHeader, readUpload } from './multipart';
import type { ObjectStorage } from './object-storage';
import { createSessions } from './session';
import {
  fileIdSchema, folderIdSchema, folderQuerySchema, loginSchema, paginationQuerySchema, updateFileSchema,
} from './validation';

function rateLimited(res: Response, retryAfter: number): never {
  res.setHeader('Retry-After', String(retryAfter));
  throw new ApiError(429, 'RATE_LIMITED', 'Too many requests. Try again later.');
}

function createRateLimit(maxAttempts: number, windowMs: number) {
  const windows = new Map<string, { reset: number; attempts: number }>();
  let nextSweep = 0;
  return (key: string, res: Response): void => {
    const now = Date.now();
    if (now >= nextSweep) {
      for (const [key, window] of windows) {
        if (window.reset <= now) windows.delete(key);
      }
      nextSweep = now + 60000;
    }
    let window = windows.get(key);
    if (!window || window.reset <= now) {
      if (!window && windows.size >= 10000) {
        rateLimited(res, 60);
      }
      window = { reset: now + windowMs, attempts: 0 };
      windows.set(key, window);
    }
    if (window.attempts >= maxAttempts) {
      rateLimited(res, Math.max(1, Math.ceil((window.reset - now) / 1000)));
    }
    window.attempts++;
  };
}

export function createApp(
  db: DataSource, storage: ObjectStorage, config: ReturnType<typeof appConfig>
) {
  const app = express();
  const api = express.Router();
  const json = express.json({ limit: '32kb' });
  const sessions = createSessions(db, config.sessionTtlMs, config.secureCookie);
  const files = createFiles(db, storage, config.uploadRecoveryAgeMs);
  const limitLogin = createRateLimit(30, 900000);
  const limitUpload = createRateLimit(60, 60000);
  const maxActiveUploads = Math.max(1, Math.min(8, Math.floor((80 * 1024 * 1024) / config.maxUploadBytes)));
  let activeUploads = 0;

  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.get('/health', async (_req, res) => {
    await db.query('SELECT 1');
    res.json({ success: true, data: { status: 'ready' } });
  });

  api.use((req, _res, next) => {
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) && req.get('origin') !== config.origin) {
      throw new ApiError(403, 'FORBIDDEN', 'The request is outside the allowed application origin.');
    }
    next();
  });

  api.post('/auth/login', json, async (req, res) => {
    limitLogin(req.ip ?? req.socket.remoteAddress ?? 'unknown', res);
    const { email, password } = loginSchema.parse(req.body);
    const { token, user } = await sessions.login(email, password, req);
    res.cookie(sessions.cookieName, token, { ...sessions.cookieOptions, maxAge: sessions.ttlMs });
    res.json({ success: true, data: user });
  });

  api.get('/auth/me', async (req, res) => {
    const user = await sessions.currentUser(req);
    res.json({ success: true, data: user });
  });

  api.post('/auth/logout', async (req, res) => {
    await sessions.logout(req);
    res.clearCookie(sessions.cookieName, sessions.cookieOptions);
    res.json({ success: true, data: { signedOut: true } });
  });

  api.get('/folders/:folderId/contents', async (req, res) => {
    const user = await sessions.currentUser(req);
    const folderId = folderIdSchema.parse(req.params.folderId);
    const result = await listFolder(db, user.id, folderId, folderQuerySchema.parse(req.query));
    res.json({ success: true, ...result });
  });

  api.post('/files', async (req, res) => {
    const user = await sessions.currentUser(req);
    if (activeUploads >= maxActiveUploads) rateLimited(res, 1);
    limitUpload(user.id, res);
    activeUploads++;
    try {
      const file = await files.upload(user.id, await readUpload(req, config.maxUploadBytes));
      res.status(201).json({ success: true, data: file });
    } finally {
      activeUploads--;
    }
  });

  api.patch('/files/:fileId', json, async (req, res) => {
    const user = await sessions.currentUser(req);
    const file = await files.update(
      user.id, fileIdSchema.parse(req.params.fileId), updateFileSchema.parse(req.body)
    );
    res.json({ success: true, data: file });
  });

  api.post('/files/:fileId/trash', async (req, res) => {
    const user = await sessions.currentUser(req);
    const data = await files.setTrashed(user.id, fileIdSchema.parse(req.params.fileId), true);
    res.json({ success: true, data });
  });

  api.post('/files/:fileId/restore', async (req, res) => {
    const user = await sessions.currentUser(req);
    const data = await files.setTrashed(user.id, fileIdSchema.parse(req.params.fileId), false);
    res.json({ success: true, data });
  });

  api.get('/trash', async (req, res) => {
    const user = await sessions.currentUser(req);
    const result = await files.listTrash(user.id, paginationQuerySchema.parse(req.query));
    res.json({ success: true, ...result });
  });

  api.get('/files/:fileId/download', async (req, res) => {
    const user = await sessions.currentUser(req);
    const { stream, name, size } = await files.download(user.id, fileIdSchema.parse(req.params.fileId));
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': attachmentHeader(name),
      'Content-Length': String(size),
    });

    if (req.method === 'HEAD') {
      stream.destroy();
      res.end();
      return;
    }
    await pipeline(stream, res);
  });

  app.use('/api/v1', api);
  app.use((_req: Request, _res: Response) => { throw notFound(); });
  app.use(sendError);
  return app;
}
