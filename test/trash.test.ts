import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createApp } from '../src/app';
import { appConfig } from '../src/config';
import { createDatabase } from '../src/database';
import { Baseline1762214400000 } from '../src/migrations/1762214400000-Baseline';
import type { ObjectStorage } from '../src/object-storage';
import { hashPassword } from '../src/session';

const testDatabase = process.env.BACKEND_TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:3000';

test('TRASH-01 upgrades a populated DRIVE-01 schema and preserves each file through trash and restore', {
  skip: !testDatabase,
}, async (t) => {
  const url = testDatabase!;
  const admin = await createDatabase(url).initialize();
  const schema = 'trash_test_' + randomBytes(8).toString('hex');
  const schemaOptions = { schema, extra: { options: '-c search_path=' + schema, statement_timeout: 10000 } };
  const legacy = createDatabase(url).setOptions({ ...schemaOptions, migrations: [Baseline1762214400000] });
  const db = createDatabase(url).setOptions(schemaOptions);
  t.after(async () => {
    try {
      if (legacy.isInitialized) await legacy.destroy();
      if (db.isInitialized) await db.destroy();
      await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    } finally {
      await admin.destroy();
    }
  });

  await admin.query('CREATE SCHEMA ' + schema);
  await legacy.initialize();
  assert.deepEqual((await legacy.runMigrations()).map((migration) => migration.name), [
    'Baseline1762214400000',
  ]);

  const owner = randomUUID();
  const other = randomUUID();
  const folder = randomUUID();
  const primary = randomUUID();
  const sibling = randomUUID();
  const newest = randomUUID();
  const otherFile = randomUUID();
  const pending = randomUUID();
  const bytes = Buffer.from('Dữ liệu cần giữ nguyên.\n', 'utf8');
  const objectKey = 'files/' + primary;
  const password = 'Synthetic trash pass!';
  const passwordHash = await hashPassword(password);
  await legacy.query(`
    INSERT INTO users (id, email, name, password_hash, quota_bytes, used_bytes)
    VALUES ($1, 'owner@example.test', 'Test Owner', $3, 200, $4),
           ($2, 'other@example.test', 'Other Owner', $3, 200, 1)
  `, [owner, other, passwordHash, bytes.length + 3]);
  await legacy.query('INSERT INTO folders (id, owner_id, name) VALUES ($1, $2, $3)', [
    folder, owner, 'Documents',
  ]);
  await legacy.query(`
    INSERT INTO files (id, owner_id, folder_id, original_name, mime_type, size_bytes, object_key, upload_state)
    VALUES ($1, $6, $8, 'Kế hoạch.txt', 'text/plain', $9, $10, 'ready'),
           ($2, $6, $8, 'Sibling.txt', 'text/plain', 1, 'files/' || ($2::uuid)::text, 'ready'),
           ($3, $6, NULL, 'Newest.txt', 'text/plain', 1, 'files/' || ($3::uuid)::text, 'ready'),
           ($4, $7, NULL, 'Other.txt', 'text/plain', 1, 'files/' || ($4::uuid)::text, 'ready'),
           ($5, $6, NULL, 'Unfinished.txt', 'text/plain', 1, 'files/' || ($5::uuid)::text, 'pending')
  `, [primary, sibling, newest, otherFile, pending, owner, other, folder, bytes.length, objectKey]);
  await legacy.query("UPDATE files SET description = 'Fixture', tags = '{plan}' WHERE id = $1", [primary]);
  const legacyFiles = await legacy.query<Record<string, unknown>[]>('SELECT * FROM files ORDER BY id');
  const legacyQuota = await legacy.query('SELECT id, quota_bytes, used_bytes FROM users ORDER BY id');
  await legacy.destroy();

  await db.initialize();
  assert.deepEqual((await db.runMigrations()).map((migration) => migration.name), [
    'AddFileTrash1763683200000',
    'AddFileShares1764201600000',
    'AddFolderSiblingUniqueness1764806400000',
    'AddFolderShares1765152000000',
  ]);
  assert.deepEqual(await db.runMigrations(), []);
  const readMetadata = () => db.query('SELECT to_jsonb(files) - \'trashed_at\' AS metadata FROM files ORDER BY id');
  const initialMetadata = await readMetadata();
  const addedColumn = await db.query<{ trashed_at: Date | null }[]>('SELECT trashed_at FROM files');
  assert.deepEqual(addedColumn, legacyFiles.map(() => ({ trashed_at: null })));
  const migratedFiles = await db.query<Record<string, unknown>[]>('SELECT * FROM files ORDER BY id');
  assert.deepEqual(migratedFiles, legacyFiles.map((file) => ({ ...file, trashed_at: null })));

  let readCount = 0;
  let writes = 0;
  const storage: ObjectStorage = {
    async read(key) {
      readCount++;
      assert.equal(key, objectKey);
      return Readable.from([Buffer.from(bytes)]);
    },
    async put() {
      writes++;
      throw new Error('TRASH-01 must leave objects in storage');
    },
    async remove() {
      writes++;
      throw new Error('TRASH-01 must leave objects in storage');
    },
  };
  const server = createServer(createApp(db, storage, appConfig({ APP_ORIGIN: origin })));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = 'http://127.0.0.1:' + address.port + '/api/v1';

  async function request(path: string, cookie?: string, options: RequestInit = {}) {
    const headers = new Headers(options.headers);
    if (cookie) headers.set('Cookie', cookie);
    if (options.method && !headers.has('Origin')) headers.set('Origin', origin);
    const response = await fetch(baseUrl + path, { ...options, headers });
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    return response;
  }

  async function signIn(email: string): Promise<string> {
    const response = await request('/auth/login', undefined, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('Set-Cookie')?.split(';')[0];
    assert.ok(cookie);
    return cookie;
  }

  function change(id: string, action: 'trash' | 'restore', cookie?: string, requestOrigin = origin) {
    return request('/files/' + id + '/' + action, cookie, { method: 'POST', headers: { Origin: requestOrigin } });
  }

  async function json(response: Response, status: number) {
    assert.equal(response.status, status);
    return response.json();
  }

  async function list(cookie: string, query = '') {
    return json(await request('/trash' + query, cookie), 200);
  }

  const cookie = await signIn('owner@example.test');
  const otherCookie = await signIn('other@example.test');
  const emptyTrash = await list(cookie);
  assert.deepEqual(emptyTrash, {
    success: true, data: { items: [] }, pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
  });

  await json(await request('/trash'), 401);
  await json(await request('/trash?page=0', cookie), 400);
  await json(await request('/trash?limit=101', cookie), 400);
  await json(await change(primary, 'trash'), 401);
  await json(await change(primary, 'trash', cookie, 'https://another.example.test'), 403);
  await json(await change('invalid-id', 'trash', cookie), 400);
  for (const action of ['trash', 'restore'] as const) {
    await json(await change(primary, action, otherCookie), 404);
    await json(await change(pending, action, cookie), 404);
    await json(await change(randomUUID(), action, cookie), 404);
  }
  assert.deepEqual(await json(await change(primary, 'restore', cookie), 200), {
    success: true, data: { id: primary, folderId: folder, trashedAt: null },
  });

  const drivePath = '/folders/' + folder + '/contents';
  const initialSearch = await json(await request(drivePath + '?q=K%E1%BA%BF', cookie), 200);
  assert.deepEqual(initialSearch.data.items.map((file: { id: string }) => file.id), [primary]);
  const trashResponses = await Promise.all([
    change(primary, 'trash', cookie), change(primary, 'trash', cookie),
  ]);
  const [first, repeated] = await Promise.all(trashResponses.map((response) => json(response, 200)));
  assert.equal(first.success, true);
  assert.equal(first.data.id, primary);
  assert.equal(new Date(first.data.trashedAt).toISOString(), first.data.trashedAt);
  assert.deepEqual(repeated, first);

  const [hidden, browse] = await Promise.all([
    json(await request(drivePath + '?q=K%E1%BA%BF', cookie), 200),
    json(await request(drivePath, cookie), 200),
  ]);
  assert.deepEqual(hidden.data.items, []);
  assert.equal(hidden.pagination.total, 0);
  assert.deepEqual(browse.data.items.map((file: { id: string }) => file.id), [sibling]);
  await json(await request('/files/' + primary + '/download', cookie), 404);
  await json(await request('/files/' + primary, cookie, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ originalName: 'Unavailable.txt' }),
  }), 404);
  assert.equal(readCount, 0);
  assert.deepEqual((await list(cookie)).data.items, [{
    ...initialSearch.data.items[0], trashedAt: first.data.trashedAt,
  }]);

  await json(await change(otherFile, 'trash', otherCookie), 200);
  assert.deepEqual((await list(otherCookie)).data.items.map((file: { id: string }) => file.id), [otherFile]);
  await json(await change(sibling, 'trash', cookie), 200);
  await json(await change(newest, 'trash', cookie), 200);

  // Give two rows an identical time to exercise the ID tie-breaker across pages.
  await db.query(`
    UPDATE files SET trashed_at = CASE WHEN id = $1 THEN '2025-11-22T12:00:00Z'::timestamptz
      ELSE '2025-11-22T11:00:00Z'::timestamptz END
    WHERE id IN ($1, $2, $3)
  `, [newest, primary, sibling]);
  const order = [newest, ...[primary, sibling].sort()];
  for (const [index, id] of order.entries()) {
    const page = await list(cookie, '?limit=1&page=' + (index + 1));
    assert.deepEqual(page.pagination, { page: index + 1, limit: 1, total: 3, totalPages: 3 });
    assert.deepEqual(page.data.items.map((file: { id: string }) => file.id), [id]);
  }
  assert.deepEqual((await list(cookie, '?page=4&limit=1')).data.items, []);
  assert.deepEqual(await readMetadata(), initialMetadata);
  assert.deepEqual(await db.query('SELECT id, quota_bytes, used_bytes FROM users ORDER BY id'), legacyQuota);
  assert.equal(writes, 0);

  const restoreResponses = await Promise.all([
    change(primary, 'restore', cookie), change(primary, 'restore', cookie),
  ]);
  for (const response of restoreResponses) {
    assert.deepEqual(await json(response, 200), {
      success: true, data: { id: primary, folderId: folder, trashedAt: null },
    });
  }
  const restored = await json(await request(drivePath + '?q=K%E1%BA%BF', cookie), 200);
  assert.deepEqual(restored.data.items, initialSearch.data.items);
  assert.equal((await list(cookie)).pagination.total, 2);
  const download = await request('/files/' + primary + '/download', cookie);
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  assert.equal(readCount, 1);
  assert.equal(writes, 0);
  assert.deepEqual(await readMetadata(), initialMetadata);
  assert.deepEqual(await db.query('SELECT id, quota_bytes, used_bytes FROM users ORDER BY id'), legacyQuota);
});
