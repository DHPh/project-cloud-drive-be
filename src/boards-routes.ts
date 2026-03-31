import { pipeline } from 'node:stream/promises';
import express, { type Request, type Response } from 'express';
import type { DataSource } from 'typeorm';
import { z } from 'zod';
import { createBoards, maxBoardItems, supportsBoardExcerpt } from './boards';
import { ApiError, notFound, storageUnavailable, unsupportedMedia } from './errors';
import { attachmentHeader } from './multipart';
import type { ObjectStorage } from './object-storage';
import type { User } from './session';
import { fileIdSchema, folderUuidSchema, paginationQuerySchema } from './validation';

const visibility = z.enum(['draft', 'link', 'discoverable']);
const validText = (text: string, max: number) => [...text].length <= max && !/[\u0000\uD800-\uDFFF]/u.test(text);
const title = z.string().trim().min(1).refine(value => validText(value, 120));
const description = z.string().refine(value => validText(value, 2000)).nullable().optional();
const createInput = z.strictObject({ title, description });
const updateInput = z.strictObject({ title: title.optional(), description, visibility: visibility.optional() })
  .refine(value => Object.keys(value).length > 0);
const itemInput = z.strictObject({ fileId: fileIdSchema });
const itemUpdateInput = z.strictObject({ published: z.boolean().optional(), allowDownload: z.boolean().optional() })
  .refine(value => Object.keys(value).length > 0);
const itemOrderInput = z.strictObject({ itemIds: z.array(folderUuidSchema).max(maxBoardItems) });
const previewLimitBytes = 4096;

async function openObject(storage: ObjectStorage, key: string) {
  try {
    return await storage.read(key);
  } catch {
    throw storageUnavailable();
  }
}

async function readExcerpt(storage: ObjectStorage, key: string, size: number) {
  const stream = await openObject(storage, key);
  const parts: Buffer[] = [];
  let remaining = previewLimitBytes;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const part = bytes.subarray(0, remaining);
      parts.push(part);
      remaining -= part.length;
      if (!remaining) break;
    }
  } catch {
    throw storageUnavailable();
  } finally {
    stream.destroy();
  }
  const received = previewLimitBytes - remaining;
  if (received !== Math.min(size, previewLimitBytes)) throw storageUnavailable();
  const truncated = size > previewLimitBytes;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts, received), { stream: truncated });
    return { text, truncated };
  } catch {
    throw unsupportedMedia();
  }
}

export function createBoardRouter(db: DataSource, storage: ObjectStorage, currentUser: (request: Request) => Promise<User>) {
  const router = express.Router();
  const json = express.json({ limit: '32kb' });
  const boards = createBoards(db);
  let activePublicReads = 0;

  async function withPublicRead(res: Response, work: () => Promise<void>) {
    if (activePublicReads >= 4) {
      res.setHeader('Retry-After', '1');
      throw new ApiError(429, 'RATE_LIMITED', 'Too many requests. Try again later.');
    }
    activePublicReads++;
    try { await work(); }
    finally { activePublicReads--; }
  }

  router.get('/boards', async (req, res) => {
    const actor = await currentUser(req);
    res.json({ success: true, ...await boards.ownedList(actor.id, paginationQuerySchema.parse(req.query)) });
  });

  router.post('/boards', json, async (req, res) => {
    const actor = await currentUser(req);
    const input = createInput.parse(req.body);
    res.status(201).json({ success: true, data: await boards.create(actor.id, input.title, input.description ?? null) });
  });

  router.get('/boards/:boardId', async (req, res) => {
    const actor = await currentUser(req);
    res.json({ success: true, data: await boards.ownedGet(actor.id, fileIdSchema.parse(req.params.boardId)) });
  });

  router.patch('/boards/:boardId', json, async (req, res) => {
    const actor = await currentUser(req);
    const data = await boards.update(actor.id, fileIdSchema.parse(req.params.boardId), updateInput.parse(req.body));
    res.json({ success: true, data });
  });

  router.delete('/boards/:boardId', async (req, res) => {
    const actor = await currentUser(req);
    res.json({ success: true, data: await boards.remove(actor.id, fileIdSchema.parse(req.params.boardId)) });
  });

  router.post('/boards/:boardId/items', json, async (req, res) => {
    const actor = await currentUser(req);
    const data = await boards.addItem(actor.id, fileIdSchema.parse(req.params.boardId), itemInput.parse(req.body).fileId);
    res.status(201).json({ success: true, data });
  });

  router.patch('/boards/:boardId/items/:itemId', json, async (req, res) => {
    const actor = await currentUser(req);
    const data = await boards.updateItem(actor.id, fileIdSchema.parse(req.params.boardId), fileIdSchema.parse(req.params.itemId), itemUpdateInput.parse(req.body));
    res.json({ success: true, data });
  });

  router.delete('/boards/:boardId/items/:itemId', async (req, res) => {
    const actor = await currentUser(req);
    const data = await boards.removeItem(actor.id, fileIdSchema.parse(req.params.boardId), fileIdSchema.parse(req.params.itemId));
    res.json({ success: true, data });
  });

  router.put('/boards/:boardId/items/order', json, async (req, res) => {
    const actor = await currentUser(req);
    const data = await boards.orderItems(actor.id, fileIdSchema.parse(req.params.boardId), itemOrderInput.parse(req.body).itemIds);
    res.json({ success: true, data });
  });

  router.get('/public/boards', async (req, res) => {
    res.json({ success: true, ...await boards.publicList(paginationQuerySchema.parse(req.query)) });
  });

  router.get('/public/boards/:publicId', async (req, res) => {
    res.json({ success: true, data: await boards.publicGet(fileIdSchema.parse(req.params.publicId)) });
  });

  router.get('/public/boards/:publicId/items/:itemId/preview', async (req, res) => {
    const asset = await boards.publicObject(fileIdSchema.parse(req.params.publicId), fileIdSchema.parse(req.params.itemId));
    if (!supportsBoardExcerpt(asset.mime_type)) throw notFound();
    await withPublicRead(res, async () => {
      const data = await readExcerpt(storage, asset.object_key, Number(asset.size_bytes));
      const payload = JSON.stringify({ success: true, data }).replace(/[<>&]/g, ch => '\\u00' + ch.charCodeAt(0).toString(16));
      res.type('application/json').send(payload);
    });
  });

  router.get('/public/boards/:publicId/items/:itemId/download', async (req, res) => {
    const asset = await boards.publicObject(fileIdSchema.parse(req.params.publicId), fileIdSchema.parse(req.params.itemId));
    if (!asset.allow_download) throw notFound();
    await withPublicRead(res, async () => {
      const stream = await openObject(storage, asset.object_key);
      res.set({
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': attachmentHeader(asset.original_name),
        'Content-Length': String(asset.size_bytes),
      });
      if (req.method === 'HEAD') {
        stream.destroy();
        res.end();
        return;
      }
      await pipeline(stream, res);
    });
  });

  router.get('/admin/boards', async (req, res) => {
    const actor = await currentUser(req);
    res.json({ success: true, ...await boards.moderatorList(actor, paginationQuerySchema.parse(req.query)) });
  });

  router.post('/admin/boards/:boardId/hide', async (req, res) => {
    const actor = await currentUser(req);
    res.json({ success: true, data: await boards.hide(actor.id, fileIdSchema.parse(req.params.boardId)) });
  });

  return router;
}
