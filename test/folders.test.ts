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
import { AddFileTrash1763683200000 } from '../src/migrations/1763683200000-AddFileTrash';
import { AddFileShares1764201600000 } from '../src/migrations/1764201600000-AddFileShares';
import type { ObjectStorage } from '../src/object-storage';
import { hashPassword } from '../src/session';

const testDatabase = process.env.BACKEND_TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:3000';

test('DRIVE-02 upgrades SHARE-01 data and makes folder topology changes safely', { skip: !testDatabase }, async (t) => {
  const url = testDatabase!;
  const admin = await createDatabase(url).initialize();
  const schema = 'folder_test_' + randomBytes(8).toString('hex');
  const schemaOptions = { schema, extra: { options: '-c search_path=' + schema, statement_timeout: 10000 } };
  const previous = createDatabase(url).setOptions({
    ...schemaOptions, migrations: [Baseline1762214400000, AddFileTrash1763683200000, AddFileShares1764201600000],
  });
  const db = createDatabase(url).setOptions(schemaOptions);
  let server: ReturnType<typeof createServer> | undefined;
  t.after(async () => {
    try {
      const activeServer = server;
      if (activeServer?.listening) {
        await new Promise<void>((resolve) => activeServer.close(() => resolve()));
      }
      if (previous.isInitialized) await previous.destroy();
      if (db.isInitialized) await db.destroy();
      await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    } finally {
      await admin.destroy();
    }
  });

  await admin.query('CREATE SCHEMA ' + schema);
  await previous.initialize();
  assert.equal((await previous.runMigrations()).length, 3);

  const ownerId = randomUUID();
  const recipientId = randomUUID();
  const sourceId = randomUUID();
  const childId = randomUUID();
  const destinationId = randomUUID();
  const privateId = randomUUID();
  const fileId = randomUUID();
  const rootFileId = randomUUID();
  const objectKey = 'files/' + fileId;
  const fileName = 'Tệp theo thư mục.txt';
  const bytes = Buffer.from('Nội dung và quyền chia sẻ giữ nguyên.\n', 'utf8');
  const password = 'Synthetic folder pass!';
  const passwordHash = await hashPassword(password);
  await previous.query(`
    INSERT INTO users (id, email, name, password_hash, quota_bytes, used_bytes)
    VALUES ($1, 'owner@example.test', 'Test Owner', $3, 200, $4),
           ($2, 'recipient@example.test', 'Test Recipient', $3, 200, 0)
  `, [ownerId, recipientId, passwordHash, bytes.length + 1]);
  await previous.query(`
    INSERT INTO folders (id, owner_id, parent_id, name)
    VALUES ($1, $5, NULL, 'Projects'), ($2, $5, $1, 'Child'),
           ($3, $5, NULL, 'Destination'), ($4, $6, NULL, 'Projects')
  `, [sourceId, childId, destinationId, privateId, ownerId, recipientId]);
  await previous.query(`
    INSERT INTO files (id, owner_id, folder_id, original_name, mime_type, size_bytes, object_key, upload_state)
    VALUES ($1, $3, $4, $5, 'text/plain', $6, $7, 'ready'),
           ($2, $3, NULL, 'Root only file.txt', 'text/plain', 1, $8, 'ready')
  `, [fileId, rootFileId, ownerId, childId, fileName, bytes.length, objectKey, 'files/' + rootFileId]);
  await previous.query(`
    INSERT INTO file_shares (file_id, recipient_id, granted_at, expires_at)
    VALUES ($1, $2, statement_timestamp(), statement_timestamp() + INTERVAL '7 days')
  `, [fileId, recipientId]);
  const snapshotFiles = await previous.query<Record<string, unknown>[]>('SELECT * FROM files ORDER BY id');
  const snapshotFolders = await previous.query<Record<string, unknown>[]>('SELECT * FROM folders ORDER BY id');
  const snapshotShares = await previous.query('SELECT * FROM file_shares');
  const snapshotQuota = await previous.query('SELECT id, used_bytes, quota_bytes FROM users ORDER BY id');
  await previous.destroy();

  await db.initialize();
  assert.deepEqual((await db.runMigrations()).map((migration) => migration.name), [
    'AddFolderSiblingUniqueness1764806400000',
    'AddFolderShares1765152000000',
    'AddFolderTrash1765238400000',
    'AddTrashPurge1765324800000',
    'AddFolderDescription1765411200000',
    'AddAccountAdministration1765497600000',
  ]);
  assert.deepEqual(await db.runMigrations(), []);
  assert.deepEqual(await db.query('SELECT * FROM folders ORDER BY id'),
    snapshotFolders.map((folder) => ({ ...folder, trash_root_id: null, trashed_at: null, trash_event_id: null, description: null })));
  let storageReads = 0;
  const storage: ObjectStorage = {
    async read(key) {
      storageReads++;
      assert.equal(key, objectKey);
      return Readable.from([Buffer.from(bytes)]);
    },
    async put() { throw new Error('Folder writes must leave file objects untouched'); },
    async remove() { throw new Error('Folder writes must leave file objects untouched'); },
  };
  server = createServer(createApp(db, storage, appConfig({ APP_ORIGIN: origin })));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
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

  async function json(response: Response, status: number) {
    assert.equal(response.status, status);
    return response.json();
  }

  function send(path: string, method: 'POST' | 'PATCH', body: object, cookie?: string) {
    return request(path, cookie, { method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  }

  async function signIn(email: string) {
    const response = await send('/auth/login', 'POST', { email, password });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('Set-Cookie')?.split(';')[0];
    assert.ok(cookie);
    return cookie;
  }

  const owner = await signIn('owner@example.test');
  const recipient = await signIn('recipient@example.test');
  const folders = '/folders';
  const create = (body: object) => send(folders, 'POST', body, owner);
  const patch = (id: string, body: object) => send(folders + '/' + id, 'PATCH', body, owner);
  const contents = async (id = 'root', query = '') => json(await request(folders + '/' + id + '/contents' + query, owner), 200);
  const items = (body: { data: { items: { id: string; kind: string }[] } }) => body.data.items;
  const file = '/files/' + fileId;
  const sharedBefore = (await json(await request(file, recipient), 200)).data;

  await json(await send(folders, 'POST', { name: 'Signed out' }), 401);
  await json(await create({ name: '   ' }), 400);
  await json(await create({ name: 'Oversize ' + 'a'.repeat(255) }), 400);
  await json(await create({ name: 'Bad parent', parentId: 'root' }), 400);
  await json(await create({ name: 'Other parent', parentId: privateId }), 404);
  await json(await create({ name: 'Missing parent', parentId: randomUUID() }), 404);
  await json(await patch(privateId, { name: 'Inaccessible' }), 404);
  await json(await send(folders + '/' + sourceId, 'PATCH', { name: 'Inaccessible' }, recipient), 404);
  await json(await patch(sourceId, {}), 400);
  await json(await patch(sourceId, { parentId: privateId }), 404);
  await json(await request(folders + '/root/contents?type=files', owner), 400);

  const duplicate = await json(await create({ name: ' Projects ', parentId: null }), 409);
  assert.equal(duplicate.error.code, 'FOLDER_NAME_CONFLICT');
  const caseVariant = (await json(await create({ name: ' projects ' }), 201)).data;
  assert.equal(caseVariant.name, 'projects');
  assert.equal(caseVariant.parentId, null);
  const sibling = (await json(await create({ name: 'Projects', parentId: destinationId }), 201)).data;
  assert.equal(sibling.parentId, destinationId);
  assert.equal((await json(await patch(caseVariant.id, { name: 'Projects' }), 409)).error.code, 'FOLDER_NAME_CONFLICT');
  assert.equal((await json(await patch(sourceId, { parentId: destinationId }), 409)).error.code, 'FOLDER_NAME_CONFLICT');
  const partial = (await json(await patch(sourceId, { name: ' Dự án ' }), 200)).data;
  assert.equal(partial.name, 'Dự án');
  assert.equal(partial.parentId, null);

  const combined = await contents('root', '?limit=1');
  const folderOnly = await contents('root', '?type=folders&limit=1');
  assert.equal(combined.pagination.total, folderOnly.pagination.total + 1);
  assert.equal(folderOnly.pagination.total, folderOnly.pagination.totalPages);
  assert.equal(items(folderOnly).length, 1);
  assert.equal(items(folderOnly)[0]?.kind, 'folder');
  assert.deepEqual(items(await contents('root', '?type=folders&q=Root%20only')), []);
  assert.equal((await contents('root', '?type=folders&q=Root%20only')).pagination.total, 0);
  assert.deepEqual(items(await contents('root', '?q=Root%20only')).map(({ id }) => id), [rootFileId]);

  assert.equal((await json(await patch(sourceId, { parentId: sourceId }), 409)).error.code, 'INVALID_FOLDER_MOVE');
  assert.equal((await json(await patch(sourceId, { parentId: childId }), 409)).error.code, 'INVALID_FOLDER_MOVE');
  const moved = (await json(await patch(sourceId, { name: 'Dự án', parentId: destinationId }), 200)).data;
  assert.equal(moved.id, sourceId);
  assert.equal(moved.parentId, destinationId);
  assert.equal(moved.createdAt, partial.createdAt);
  assert.deepEqual((await json(await patch(sourceId, { name: ' Dự án ', parentId: destinationId.toUpperCase() }), 200)).data, moved);
  assert.equal(items(await contents()).some(({ id }) => id === sourceId), false);
  const nested = await contents(childId);
  assert.deepEqual(nested.data.breadcrumbs, [
    { id: destinationId, name: 'Destination' }, { id: sourceId, name: 'Dự án' }, { id: childId, name: 'Child' },
  ]);
  assert.deepEqual(items(nested).map(({ id }) => id), [fileId]);
  assert.equal(items(await contents(destinationId, '?type=folders')).some(({ id }) => id === sourceId), true);

  assert.deepEqual((await json(await request(file, recipient), 200)).data, sharedBefore);
  const download = await request(file + '/download', recipient);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('Content-Disposition'), "attachment; filename*=UTF-8''" + encodeURIComponent(fileName));
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  assert.equal(storageReads, 1);
  assert.equal((await json(await patch(sourceId, { parentId: null }), 200)).data.parentId, null);

  const concurrentCreates = await Promise.all([create({ name: 'Concurrent A' }), create({ name: ' Concurrent A ' })]);
  assert.deepEqual(concurrentCreates.map((response) => response.status).sort(), [201, 409]);
  const created = concurrentCreates.find((response) => response.status === 201);
  assert.ok(created);
  const a = (await created.json()).data;
  const b = (await json(await create({ name: 'Concurrent B' }), 201)).data;
  const opposing = await Promise.all([patch(a.id, { parentId: b.id }), patch(b.id, { parentId: a.id })]);
  assert.deepEqual(opposing.map((response) => response.status).sort(), [200, 409]);
  const deniedMove = opposing.find((response) => response.status === 409);
  assert.ok(deniedMove);
  assert.equal((await deniedMove.json()).error.code, 'INVALID_FOLDER_MOVE');
  const topology = await db.query<{ parent_id: string | null }[]>('SELECT parent_id FROM folders WHERE id IN ($1, $2)', [a.id, b.id]);
  assert.equal(topology.filter(({ parent_id }) => parent_id === null).length, 1);

  assert.deepEqual(await db.query('SELECT * FROM files ORDER BY id'),
    snapshotFiles.map((file) => ({ ...file, trash_event_id: null })));
  assert.deepEqual(await db.query('SELECT * FROM file_shares'), snapshotShares);
  assert.deepEqual(await db.query('SELECT id, used_bytes, quota_bytes FROM users ORDER BY id'), snapshotQuota);
});
