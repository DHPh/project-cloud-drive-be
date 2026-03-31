import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import test from 'node:test';
import express, { type Request } from 'express';
import { createBoardRouter } from '../src/boards-routes';
import { createDatabase } from '../src/database';
import { sendError } from '../src/errors';
import { createFiles } from '../src/files';
import { createFolder } from '../src/folders';
import type { ObjectStorage } from '../src/object-storage';
import { createSessions, hashPassword } from '../src/session';
import { setFileTrashed, setFolderTrashed } from '../src/trash';

const testDatabase = process.env.BACKEND_TEST_DATABASE_URL;

test('BOARD-01 keeps drafts, permissions, public projection, Trash and moderation separate', { skip: !testDatabase }, async (t) => {
  const url = testDatabase!;
  const schema = 'boards_test_' + randomBytes(8).toString('hex');
  const adminDb = await createDatabase(url).initialize();
  const db = createDatabase(url);
  db.setOptions({ schema, extra: { options: '-c search_path=' + schema, statement_timeout: 10000 } });
  let server: ReturnType<typeof createServer> | undefined;
  t.after(async () => {
    try {
      const activeServer = server;
      if (activeServer?.listening) await new Promise<void>(resolve => activeServer.close(() => resolve()));
      if (db.isInitialized) await db.destroy();
      await adminDb.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    } finally {
      await adminDb.destroy();
    }
  });
  await adminDb.query('CREATE SCHEMA ' + schema);
  await db.initialize();
  await db.runMigrations();

  const ownerId = randomUUID();
  const viewerId = randomUUID();
  const adminId = randomUUID();
  const password = 'Synthetic board fixture!';
  const hash = await hashPassword(password);
  await db.query(`
    INSERT INTO users (id, email, name, password_hash, quota_bytes, role)
    VALUES ($1, 'board-owner@example.test', 'Private Owner', $4, 8192, 'user'),
           ($2, 'board-viewer@example.test', 'Private Viewer', $4, 8192, 'user'),
           ($3, 'board-admin@example.test', 'Synthetic Moderator', $4, 8192, 'admin')
  `, [ownerId, viewerId, adminId, hash]);
  const objects = new Map<string, Buffer>();
  const storage: ObjectStorage = {
    async put(key, value) { objects.set(key, Buffer.from(value)); },
    async read(key) {
      const bytes = objects.get(key);
      if (!bytes) throw new Error('Fixture object is absent');
      return Readable.from([bytes]);
    },
    async remove(key) { objects.delete(key); },
  };
  const files = createFiles(db, storage, 300000);
  const folder = await createFolder(db, ownerId, { name: 'Fixture folder' });
  const prefix = 'Bản công bố & mục <giấy>\n';
  const excerpt = prefix + 'x'.repeat(4095 - Buffer.byteLength(prefix));
  const bytes = Buffer.from(excerpt + 'é\n');
  const file = await files.upload(ownerId, { originalName: 'Báo cáo công khai.txt', bytes, mimeType: 'text/plain', folderId: null });
  await files.update(ownerId, file.id, { description: 'Private fixture description', tags: ['private-fixture-tag'] });
  const nested = await files.upload(ownerId, { originalName: 'Tệp trong cây.bin', bytes: Buffer.from('Nested fixture'), mimeType: 'application/octet-stream', folderId: folder.id });
  const foreign = await files.upload(viewerId, { originalName: 'Tệp của tài khoản khác.txt', bytes, mimeType: 'text/plain', folderId: null });

  const sessions = createSessions(db, 3600000, false);
  const emptyRequest = { headers: {} } as Request;
  async function cookie(email: string) {
    return sessions.cookieName + '=' + (await sessions.login(email, password, emptyRequest)).token;
  }
  const owner = await cookie('board-owner@example.test');
  const viewer = await cookie('board-viewer@example.test');
  const admin = await cookie('board-admin@example.test');
  const app = express();
  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.use('/api/v1', createBoardRouter(db, storage, sessions.currentUser));
  app.use(sendError);
  server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = 'http://127.0.0.1:' + address.port + '/api/v1';

  async function request(path: string, actor?: string, method = 'GET', body?: object) {
    const headers = new Headers();
    if (actor) headers.set('Cookie', actor);
    if (body) headers.set('Content-Type', 'application/json');
    const response = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    return response;
  }

  async function json(response: Response, status: number) {
    assert.equal(response.status, status);
    return response.json();
  }

  const board = (await json(await request('/boards', owner, 'POST', { title: 'Board fixture', description: 'Published summary' }), 201)).data;
  const ownerPath = '/boards/' + board.id;
  const publicPath = '/public/boards/' + board.publicId;
  assert.equal(board.visibility, 'draft');
  assert.notEqual(board.id, board.publicId);
  await json(await request(publicPath), 404);
  await json(await request(ownerPath, viewer), 404);
  assert.equal((await json(await request('/admin/boards', admin), 200)).pagination.total, 0);
  await json(await request(ownerPath + '/items', owner, 'POST', { fileId: foreign.id }), 404);

  const first = (await json(await request(ownerPath + '/items', owner, 'POST', { fileId: file.id }), 201)).data;
  const second = (await json(await request(ownerPath + '/items', owner, 'POST', { fileId: nested.id }), 201)).data;
  assert.equal(first.published, false);
  assert.equal(first.allowDownload, false);
  assert.equal((await json(await request(ownerPath + '/items', owner, 'POST', { fileId: file.id }), 409)).error.code, 'BOARD_ITEM_EXISTS');
  await json(await request(ownerPath + '/items/order', owner, 'PUT', { itemIds: [first.id] }), 400);
  await json(await request(ownerPath + '/items/order', owner, 'PUT', { itemIds: [second.id.toUpperCase(), first.id] }), 200);
  assert.deepEqual((await json(await request(ownerPath, owner), 200)).data.items.map((item: { id: string }) => item.id), [second.id, first.id]);

  await json(await request(ownerPath, owner, 'PATCH', { visibility: 'link' }), 200);
  assert.deepEqual((await json(await request(publicPath), 200)).data.items, []);
  assert.equal((await json(await request('/public/boards'), 200)).pagination.total, 0);
  assert.equal((await json(await request('/admin/boards', admin), 200)).pagination.total, 1);
  await json(await request(ownerPath + '/items/' + first.id, owner, 'PATCH', { published: true, allowDownload: true }), 200);
  await json(await request(ownerPath + '/items/' + second.id, owner, 'PATCH', { published: true }), 200);
  const visible = (await json(await request(publicPath), 200)).data;
  assert.deepEqual(Object.keys(visible).sort(), ['description', 'items', 'publicId', 'title']);
  assert.deepEqual(Object.keys(visible.items[0]).sort(), ['allowDownload', 'canPreview', 'id', 'mimeType', 'originalName', 'size']);
  assert.deepEqual(visible.items.map((item: { id: string }) => item.id), [second.id, first.id]);
  const visibleText = JSON.stringify(visible);
  for (const value of [ownerId, file.id, nested.id, 'Private fixture description', 'private-fixture-tag']) {
    assert.ok(!visibleText.includes(value));
  }
  const preview = await request(publicPath + '/items/' + first.id + '/preview');
  assert.equal(preview.status, 200);
  const wire = await preview.text();
  assert.match(wire, /\\u003c/u);
  assert.deepEqual(JSON.parse(wire).data, { text: excerpt, truncated: true });
  await json(await request(publicPath + '/items/' + second.id + '/preview'), 404);
  await json(await request(publicPath + '/items/' + second.id + '/download'), 404);
  const download = await request(publicPath + '/items/' + first.id + '/download');
  assert.equal(download.status, 200);
  assert.match(download.headers.get('Content-Disposition') ?? '', /filename\*=UTF-8''/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);

  await json(await request(ownerPath, owner, 'PATCH', { visibility: 'discoverable' }), 200);
  assert.equal((await json(await request('/public/boards?page=1&limit=1'), 200)).pagination.total, 1);
  await setFileTrashed(db, ownerId, file.id, true);
  await json(await request(publicPath + '/items/' + first.id + '/download'), 404);
  await setFileTrashed(db, ownerId, file.id, false);
  await json(await request(publicPath + '/items/' + first.id + '/download'), 404);
  await json(await request(ownerPath + '/items/' + first.id, owner, 'PATCH', { published: true }), 200);
  await json(await request(ownerPath + '/items/' + second.id, owner, 'PATCH', { published: false }), 200);
  const [republished] = await Promise.all([
    request(ownerPath + '/items/' + second.id, owner, 'PATCH', { published: true }),
    setFolderTrashed(db, ownerId, folder.id, true),
  ]);
  assert.ok([200, 404].includes(republished.status));
  assert.deepEqual((await json(await request(publicPath), 200)).data.items.map((item: { id: string }) => item.id), [first.id]);
  await setFolderTrashed(db, ownerId, folder.id, false);
  assert.deepEqual((await json(await request(publicPath), 200)).data.items.map((item: { id: string }) => item.id), [first.id]);

  await db.query('UPDATE users SET disabled_at = statement_timestamp() WHERE id = $1', [ownerId]);
  await json(await request(publicPath), 404);
  await db.query('UPDATE users SET disabled_at = NULL WHERE id = $1', [ownerId]);
  await json(await request(publicPath), 200);
  await json(await request('/admin/boards/' + board.id + '/hide', viewer, 'POST'), 403);
  const hidden = await json(await request('/admin/boards/' + board.id + '/hide', admin, 'POST'), 200);
  assert.deepEqual(await json(await request('/admin/boards/' + board.id + '/hide', admin, 'POST'), 200), hidden);
  assert.equal((await db.query<{ count: string }[]>("SELECT count(*) AS count FROM admin_audit WHERE action = 'board_hidden'"))[0]?.count, '1');
  await json(await request(ownerPath, owner, 'PATCH', { visibility: 'link' }), 200);
  await json(await request(publicPath), 404);
  await json(await request(ownerPath, owner, 'DELETE'), 200);
  assert.equal((await db.query<{ count: string }[]>('SELECT count(*) AS count FROM board_items'))[0]?.count, '0');
  assert.equal(objects.size, 3);
});
