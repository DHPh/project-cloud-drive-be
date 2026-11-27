import { pipeline } from 'node:stream/promises';
import express, { type Request, type Response } from 'express';
import type { DataSource } from 'typeorm';
import { createAccounts } from './accounts';
import { createAdminAdministration } from './admin';
import type { appConfig } from './config';
import { createBoardRouter } from './boards-routes';
import { listDriveTimeline, searchDrive } from './drive-listing';
import { ApiError, notFound, sendError } from './errors';
import { createFiles } from './files';
import { prepareFolderArchive, writeFolderArchive } from './folder-archive';
import { createFolder, listFolder, updateFolder } from './folders';
import { attachmentHeader, readUpload } from './multipart';
import type { ObjectStorage } from './object-storage';
import { getPreview } from './preview';
import { createSessions } from './session';
import { createShareAdministration, listOutgoingShares, listSharedFiles, listSharedFolders } from './shares';
import { listTrash, setFileTrashed, setFolderTrashed } from './trash';
import { emptyTrash, purgeTrashItem } from './trash-purge';
import {
  acceptInviteSchema, accountProfileSchema, adminInviteQuerySchema, adminUserQuerySchema, changePasswordSchema,
  createFolderSchema, createInviteSchema, driveSearchQuerySchema, driveTimelineQuerySchema, emptyTrashSchema, fileIdSchema,
  folderIdSchema, folderQuerySchema, folderUuidSchema, grantFileShareSchema, loginSchema, outgoingShareQuerySchema,
  paginationQuerySchema, resetPasswordSchema, trashEventSchema, trashKindSchema, trashQuerySchema,
  updateAdminUserSchema, updateFileSchema, updateFolderSchema,
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
  const accounts = createAccounts(db);
  const admin = createAdminAdministration(db);
  const files = createFiles(db, storage, config.uploadRecoveryAgeMs);
  const shares = createShareAdministration(db, 'file');
  const folderShares = createShareAdministration(db, 'folder');
  const limitLogin = createRateLimit(30, 900000);
  const limitAccountLinks = createRateLimit(20, 900000);
  const limitPasswordChanges = createRateLimit(12, 900000);
  const limitUpload = createRateLimit(60, 60000);
  const maxActiveUploads = Math.max(1, Math.min(8, Math.floor((80 * 1024 * 1024) / config.maxUploadBytes)));
  let activeUploads = 0;
  let activePreviews = 0;
  let activeArchives = 0;

  app.disable('x-powered-by');
  if (config.trustedProxyRanges.length) app.set('trust proxy', config.trustedProxyRanges);
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
    const requestOrigin = req.get('origin');
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) && (!requestOrigin || !config.origins.includes(requestOrigin))) {
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

  api.post('/auth/accept-invite', json, async (req, res) => {
    limitAccountLinks(req.ip ?? req.socket.remoteAddress ?? 'unknown', res);
    const { token, password, name } = acceptInviteSchema.parse(req.body);
    const data = await accounts.acceptInvite(token, name, password);
    res.status(201).json({ success: true, data });
  });

  api.post('/auth/reset-password', json, async (req, res) => {
    limitAccountLinks(req.ip ?? req.socket.remoteAddress ?? 'unknown', res);
    const { token, password } = resetPasswordSchema.parse(req.body);
    await accounts.resetPassword(token, password);
    res.json({ success: true, data: { passwordChanged: true } });
  });

  api.get('/account', async (req, res) => {
    const user = await sessions.currentUser(req);
    const data = await accounts.get(user.id);
    res.json({ success: true, data });
  });

  api.patch('/account', json, async (req, res) => {
    const user = await sessions.currentUser(req);
    const { name } = accountProfileSchema.parse(req.body);
    const data = await accounts.setName(user.id, name);
    res.json({ success: true, data });
  });

  api.post('/account/password', json, async (req, res) => {
    const user = await sessions.currentUser(req);
    limitPasswordChanges(user.id, res);
    const { currentPassword, password } = changePasswordSchema.parse(req.body);
    await accounts.changePassword(user.id, currentPassword, password);
    res.clearCookie(sessions.cookieName, sessions.cookieOptions);
    res.json({ success: true, data: { passwordChanged: true } });
  });

  api.get('/admin/invites', async (req, res) => {
    const user = await sessions.currentUser(req);
    const result = await admin.listInvites(user, adminInviteQuerySchema.parse(req.query));
    res.json({ success: true, ...result });
  });

  api.post('/admin/invites', json, async (req, res) => {
    const user = await sessions.currentUser(req);
    const { email } = createInviteSchema.parse(req.body);
    const data = await admin.createInvite(user.id, email);
    res.status(201).json({ success: true, data });
  });

  api.delete('/admin/invites/:inviteId', async (req, res) => {
    const user = await sessions.currentUser(req);
    const data = await admin.revokeInvite(user.id, folderUuidSchema.parse(req.params.inviteId));
    res.json({ success: true, data });
  });

  api.get('/admin/users', async (req, res) => {
    const user = await sessions.currentUser(req);
    const result = await admin.listUsers(user, adminUserQuerySchema.parse(req.query));
    res.json({ success: true, ...result });
  });

  api.patch('/admin/users/:userId', json, async (req, res) => {
    const user = await sessions.currentUser(req);
    const data = await admin.updateUser(user.id, folderUuidSchema.parse(req.params.userId), updateAdminUserSchema.parse(req.body));
    res.json({ success: true, data });
  });

  api.post('/admin/users/:userId/reset-password', async (req, res) => {
    const user = await sessions.currentUser(req);
    const data = await admin.issuePasswordReset(user.id, folderUuidSchema.parse(req.params.userId));
    res.status(201).json({ success: true, data });
  });

  api.get('/admin/audit', async (req, res) => {
    const user = await sessions.currentUser(req);
    const result = await admin.listAudit(user, paginationQuerySchema.parse(req.query));
    res.json({ success: true, ...result });
  });

  api.get('/drive/search', async (req, res) => {
    const user = await sessions.currentUser(req);
    const result = await searchDrive(db, user.id, driveSearchQuerySchema.parse(req.query));
    res.json({ success: true, ...result });
  });

  api.get('/drive/timeline', async (req, res) => {
    const user = await sessions.currentUser(req);
    const result = await listDriveTimeline(db, user.id, driveTimelineQuerySchema.parse(req.query));
    res.json({ success: true, ...result });
  });

  api.get('/folders/:folderId/contents', async (req, res) => {
    const user = await sessions.currentUser(req);
    const folderId = folderIdSchema.parse(req.params.folderId);
    const result = await listFolder(db, user.id, folderId, folderQuerySchema.parse(req.query));
    res.json({ success: true, ...result });
  });

  api.post('/folders', json, async (req, res) => {
    const user = await sessions.currentUser(req);
    const folder = await createFolder(db, user.id, createFolderSchema.parse(req.body));
    res.status(201).json({ success: true, data: folder });
  });

  api.patch('/folders/:folderId', json, async (req, res) => {
    const user = await sessions.currentUser(req);
    const folder = await updateFolder(
      db, user.id, folderUuidSchema.parse(req.params.folderId), updateFolderSchema.parse(req.body)
    );
    res.json({ success: true, data: folder });
  });

  api.post('/folders/:folderId/trash', async (req, res) => {
    const user = await sessions.currentUser(req);
    const data = await setFolderTrashed(db, user.id, folderUuidSchema.parse(req.params.folderId), true);
    res.json({ success: true, data });
  });

  api.post('/folders/:folderId/restore', json, async (req, res) => {
    const user = await sessions.currentUser(req);
    const event = trashEventSchema.optional().parse(req.body);
    const data = await setFolderTrashed(db, user.id, folderUuidSchema.parse(req.params.folderId), false, event?.trashEventId);
    res.json({ success: true, data });
  });

  api.get('/folders/:folderId/shares', async (req, res) => {
    const user = await sessions.currentUser(req);
    const result = await folderShares.listGrants(
      user.id, folderUuidSchema.parse(req.params.folderId), paginationQuerySchema.parse(req.query)
    );
    res.json({ success: true, ...result });
  });

  api.put('/folders/:folderId/shares', json, async (req, res) => {
    const user = await sessions.currentUser(req);
    const data = await folderShares.grant(
      user.id, folderUuidSchema.parse(req.params.folderId), grantFileShareSchema.parse(req.body)
    );
    res.json({ success: true, data });
  });

  api.delete('/folders/:folderId/shares/:recipientId', async (req, res) => {
    const user = await sessions.currentUser(req);
    await folderShares.revoke(
      user.id, folderUuidSchema.parse(req.params.folderId), fileIdSchema.parse(req.params.recipientId)
    );
    res.json({ success: true, data: { revoked: true } });
  });

  api.get('/shared-folders', async (req, res) => {
    const user = await sessions.currentUser(req);
    const result = await listSharedFolders(db, user.id, paginationQuerySchema.parse(req.query));
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

  api.get('/files/:fileId', async (req, res) => {
    const user = await sessions.currentUser(req);
    const file = await files.get(user.id, fileIdSchema.parse(req.params.fileId));
    res.json({ success: true, data: file });
  });

  api.get('/files/:fileId/shares', async (req, res) => {
    const user = await sessions.currentUser(req);
    const result = await shares.listGrants(
      user.id, fileIdSchema.parse(req.params.fileId), paginationQuerySchema.parse(req.query)
    );
    res.json({ success: true, ...result });
  });

  api.put('/files/:fileId/shares', json, async (req, res) => {
    const user = await sessions.currentUser(req);
    const data = await shares.grant(
      user.id, fileIdSchema.parse(req.params.fileId), grantFileShareSchema.parse(req.body)
    );
    res.json({ success: true, data });
  });

  api.delete('/files/:fileId/shares/:recipientId', async (req, res) => {
    const user = await sessions.currentUser(req);
    await shares.revoke(user.id, fileIdSchema.parse(req.params.fileId), fileIdSchema.parse(req.params.recipientId));
    res.json({ success: true, data: { revoked: true } });
  });

  api.get('/shared-with-me', async (req, res) => {
    const user = await sessions.currentUser(req);
    const result = await listSharedFiles(db, user.id, paginationQuerySchema.parse(req.query));
    res.json({ success: true, ...result });
  });

  api.get('/shared-by-me', async (req, res) => {
    const user = await sessions.currentUser(req);
    const result = await listOutgoingShares(db, user.id, outgoingShareQuerySchema.parse(req.query));
    res.json({ success: true, ...result });
  });

  api.get('/files/:fileId/preview', async (req, res) => {
    const user = await sessions.currentUser(req);
    const id = fileIdSchema.parse(req.params.fileId);
    if (activePreviews >= 4) rateLimited(res, 1);
    activePreviews++;
    try {
      const preview = await getPreview(files, user.id, id);
      res.setHeader('Content-Type', preview.mimeType);
      res.setHeader('Content-Disposition', attachmentHeader(preview.name).replace(/^attachment/, 'inline'));
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; base-uri 'none'");
      res.send(preview.body);
    } finally {
      activePreviews--;
    }
  });

  api.get('/folders/:folderId/download', async (req, res) => {
    const user = await sessions.currentUser(req);
    const id = folderUuidSchema.parse(req.params.folderId);
    if (activeArchives >= 2) rateLimited(res, 1);
    activeArchives++;
    try {
      const manifest = await prepareFolderArchive(db, user.id, id);
      if (res.destroyed) return;
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', attachmentHeader(manifest.name));
      await writeFolderArchive(manifest, files, user.id, res);
    } finally {
      activeArchives--;
    }
  });

  api.post('/files/:fileId/trash', async (req, res) => {
    const user = await sessions.currentUser(req);
    const data = await setFileTrashed(db, user.id, fileIdSchema.parse(req.params.fileId), true);
    res.json({ success: true, data });
  });

  api.post('/files/:fileId/restore', json, async (req, res) => {
    const user = await sessions.currentUser(req);
    const event = trashEventSchema.optional().parse(req.body);
    const data = await setFileTrashed(db, user.id, fileIdSchema.parse(req.params.fileId), false, event?.trashEventId);
    res.json({ success: true, data });
  });

  api.get('/trash', async (req, res) => {
    const user = await sessions.currentUser(req);
    const result = await listTrash(db, user.id, trashQuerySchema.parse(req.query));
    res.json({ success: true, ...result });
  });

  api.post('/trash/:kind/:itemId/purge', json, async (req, res) => {
    const user = await sessions.currentUser(req);
    const kind = trashKindSchema.parse(req.params.kind);
    const itemId = folderUuidSchema.parse(req.params.itemId);
    const { trashEventId } = trashEventSchema.parse(req.body);
    const data = await purgeTrashItem(db, user.id, kind, itemId, trashEventId);
    res.status(202).json({ success: true, data });
  });

  api.post('/trash/empty', json, async (req, res) => {
    const user = await sessions.currentUser(req);
    const { requestId } = emptyTrashSchema.parse(req.body);
    const data = await emptyTrash(db, user.id, requestId);
    res.status(202).json({ success: true, data });
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

  api.use(createBoardRouter(db, storage, sessions.currentUser));
  app.use('/api/v1', api);
  app.use((_req: Request, _res: Response) => { throw notFound(); });
  app.use(sendError);
  return app;
}
