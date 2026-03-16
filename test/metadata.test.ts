import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createApp } from '../src/app';
import { appConfig } from '../src/config';
import { createDatabase } from '../src/database';
import type { ObjectStorage } from '../src/object-storage';
import { hashPassword } from '../src/session';

const databaseUrl = process.env.BACKEND_TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:3000';

test('DRIVE-03 adds folder descriptions and returns file detail access within the existing permission scope', {
  skip: !databaseUrl,
}, async (t) => {
  const admin = await createDatabase(databaseUrl!).initialize();
  const schema = 'metadata_test_' + randomBytes(8).toString('hex');
  const options = { schema, extra: { options: '-c search_path=' + schema, statement_timeout: 10000 } };
  const db = createDatabase(databaseUrl!).setOptions(options);
  const migrations = db.options.migrations;
  assert.ok(Array.isArray(migrations));
  const previous = createDatabase(databaseUrl!).setOptions({ ...options, migrations: migrations.slice(0, 7) });
  let server: ReturnType<typeof createServer> | undefined;
  t.after(async () => {
    try {
      const running = server;
      if (running?.listening) await new Promise<void>((resolve) => running.close(() => resolve()));
      if (previous.isInitialized) await previous.destroy();
      if (db.isInitialized) await db.destroy();
      await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    } finally {
      await admin.destroy();
    }
  });

  await admin.query('CREATE SCHEMA ' + schema);
  await previous.initialize();
  assert.equal((await previous.runMigrations()).length, 7);
  const ownerId = randomUUID();
  const viewerId = randomUUID();
  const ancestorId = randomUUID();
  const folderId = randomUUID();
  const fileId = randomUUID();
  const password = 'Synthetic metadata password!';
  const bytes = Buffer.from('Nội dung dùng để kiểm tra metadata.\n', 'utf8');
  const key = 'files/' + fileId;
  await previous.query(`
    INSERT INTO users (id, email, name, password_hash, quota_bytes, used_bytes)
    VALUES ($1, 'owner@example.test', 'Owner', $3, 10000, $4),
           ($2, 'viewer@example.test', 'Viewer', $3, 10000, 0)
  `, [ownerId, viewerId, await hashPassword(password), bytes.length]);
  await previous.query(`
    INSERT INTO folders (id, owner_id, parent_id, name)
    VALUES ($1, $3, NULL, 'Gốc riêng'), ($2, $3, $1, 'Thư mục sẵn có')
  `, [ancestorId, folderId, ownerId]);
  await previous.query(`
    INSERT INTO files (id, owner_id, folder_id, original_name, mime_type, size_bytes, object_key, upload_state)
    VALUES ($1, $2, $3, 'Tệp cũ.txt', 'text/plain', $4, $5, 'ready')
  `, [fileId, ownerId, folderId, bytes.length, key]);
  const legacyFolders = await previous.query<Record<string, unknown>[]>('SELECT * FROM folders ORDER BY id');
  const contentIdentity = await previous.query('SELECT id, object_key, size_bytes FROM files');
  const quota = await previous.query('SELECT id, used_bytes FROM users ORDER BY id');
  await previous.destroy();

  await db.initialize();
  assert.deepEqual((await db.runMigrations()).map((migration) => migration.name), ['AddFolderDescription1765411200000']);
  assert.deepEqual(await db.runMigrations(), []);
  assert.deepEqual(await db.query('SELECT * FROM folders ORDER BY id'),
    legacyFolders.map((folder) => ({ ...folder, description: null })));

  const storage: ObjectStorage = {
    async read(requestedKey) { assert.equal(requestedKey, key); return Readable.from([bytes]); },
    async put() { assert.fail('Changing metadata must preserve the object'); },
    async remove() { assert.fail('Changing metadata must preserve the object'); },
  };
  server = createServer(createApp(db, storage, appConfig({ APP_ORIGIN: origin })));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = 'http://127.0.0.1:' + address.port + '/api/v1';

  async function request(path: string, cookie?: string, method = 'GET', body?: object) {
    const headers = new Headers();
    if (cookie) headers.set('Cookie', cookie);
    if (method !== 'GET') headers.set('Origin', origin);
    if (body) headers.set('Content-Type', 'application/json');
    const response = await fetch(baseUrl + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    return response;
  }

  async function data(response: Response, status = 200) {
    assert.equal(response.status, status);
    return (await response.json()).data;
  }

  async function signIn(email: string) {
    const response = await request('/auth/login', undefined, 'POST', { email, password });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('Set-Cookie')?.split(';')[0];
    assert.ok(cookie);
    return cookie;
  }

  const owner = await signIn('owner@example.test');
  const viewer = await signIn('viewer@example.test');
  const ancestor = '/folders/' + ancestorId;
  const folder = '/folders/' + folderId;
  const file = '/files/' + fileId;
  assert.equal((await data(await request(folder + '/contents', owner))).folder.description, null);
  assert.equal((await data(await request(file, owner))).access, 'owner');
  assert.equal((await request(file, viewer)).status, 404);

  const folderDescription = 'Mô tả tiếng Việt\nGiữ nguyên <b>văn bản</b>.';
  await data(await request(ancestor, owner, 'PATCH', { description: 'Mô tả riêng của thư mục cấp trên' }));
  const changes = await Promise.all([
    request(folder, owner, 'PATCH', { description: folderDescription }),
    request(folder, owner, 'PATCH', { name: 'Tên đã đổi đồng thời' }),
  ]);
  for (const change of changes) await data(change);
  const moved = await data(await request(folder, owner, 'PATCH', { parentId: null }));
  assert.equal(moved.name, 'Tên đã đổi đồng thời');
  assert.equal(moved.description, folderDescription);
  assert.equal(moved.parentId, null);
  await data(await request(folder, owner, 'PATCH', { parentId: ancestorId }));

  const emoji = '🙂';
  const maxDescription = emoji.repeat(2000);
  const maxTag = emoji.repeat(64);
  for (const invalid of [{}, { description: maxDescription + emoji }, { description: 'a\u0000b' }, { tags: ['không áp dụng'] }]) {
    assert.equal((await request(folder, owner, 'PATCH', invalid)).status, 400);
  }
  assert.equal((await request('/folders', owner, 'POST', { name: 'Từ chối', description: 123 })).status, 400);
  const nested = await data(await request('/folders', owner, 'POST', {
    name: 'Mô tả đủ 2.000 ký tự', parentId: folderId, description: maxDescription,
  }), 201);
  assert.equal(nested.description, maxDescription);
  const folderEntries = await data(await request(folder + '/contents?type=folders', owner));
  assert.equal(folderEntries.items[0].description, nested.description);

  for (const invalid of [{ description: maxDescription + emoji }, { tags: [maxTag + emoji] }]) {
    assert.equal((await request(file, owner, 'PATCH', invalid)).status, 400);
  }
  const patchedFile = await data(await request(file, owner, 'PATCH', { description: maxDescription, tags: ['thẻ', maxTag] }));
  assert.equal('access' in patchedFile, false);
  assert.equal(patchedFile.description, maxDescription);
  assert.deepEqual(patchedFile.tags, ['thẻ', maxTag]);
  await data(await request(folder + '/shares', owner, 'PUT', { email: 'viewer@example.test' }));
  const visibleFolder = await data(await request(folder + '/contents', viewer));
  assert.equal(visibleFolder.access, 'viewer');
  assert.equal(visibleFolder.folder.description, folderDescription);
  assert.equal(visibleFolder.folder.parentId, null);
  assert.deepEqual(visibleFolder.breadcrumbs, [{ id: folderId, name: moved.name }]);
  assert.equal((await request(ancestor + '/contents', viewer)).status, 404);
  assert.equal((await data(await request('/folders/' + nested.id + '/contents', viewer))).folder.description, nested.description);
  assert.deepEqual(await data(await request(file, viewer)), { ...patchedFile, access: 'viewer' });
  assert.equal((await request(file, viewer, 'PATCH', { description: null })).status, 404);
  assert.equal((await request(folder, viewer, 'PATCH', { description: null })).status, 404);

  await data(await request(folder + '/shares/' + viewerId, owner, 'DELETE'));
  assert.equal((await request(file, viewer)).status, 404);
  assert.equal((await request(folder + '/contents', viewer)).status, 404);
  const trashed = await data(await request(folder + '/trash', owner, 'POST'));
  assert.equal('description' in trashed, false);
  const trash = await data(await request('/trash?includeFolders=true', owner));
  assert.equal(trash.items[0].description, folderDescription);
  await data(await request(folder + '/restore', owner, 'POST'));
  assert.equal((await data(await request(folder + '/contents', owner))).folder.description, folderDescription);

  assert.equal((await data(await request(folder, owner, 'PATCH', { description: null }))).description, null);
  const cleared = await data(await request(file, owner, 'PATCH', { description: null, tags: [] }));
  assert.equal(cleared.description, null);
  assert.deepEqual(cleared.tags, []);
  const download = await request(file + '/download', owner);
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  assert.deepEqual(await db.query('SELECT id, object_key, size_bytes FROM files'), contentIdentity);
  assert.deepEqual(await db.query('SELECT id, used_bytes FROM users ORDER BY id'), quota);
});
