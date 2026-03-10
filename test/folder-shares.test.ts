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

const testDatabase = process.env.BACKEND_TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:3000';

test('SHARE-02 interprets live ancestor grants and restores files privately', { skip: !testDatabase }, async (t) => {
  const admin = await createDatabase(testDatabase!).initialize();
  const schema = 'folder_share_test_' + randomBytes(8).toString('hex');
  const schemaOptions = { schema, extra: { options: '-c search_path=' + schema, statement_timeout: 10000 } };
  const db = createDatabase(testDatabase!).setOptions(schemaOptions);
  const migrations = db.options.migrations;
  assert.ok(Array.isArray(migrations));
  const previous = createDatabase(testDatabase!).setOptions({
    ...schemaOptions, migrations: migrations.slice(0, 4),
  });
  let server: ReturnType<typeof createServer> | undefined;
  t.after(async () => {
    try {
      const activeServer = server;
      if (activeServer?.listening) await new Promise<void>((resolve) => activeServer.close(() => resolve()));
      if (previous.isInitialized) await previous.destroy();
      if (db.isInitialized) await db.destroy();
      await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    } finally {
      await admin.destroy();
    }
  });

  await admin.query('CREATE SCHEMA ' + schema);
  await previous.initialize();
  assert.equal((await previous.runMigrations()).length, 4);
  const ownerId = randomUUID();
  const viewerId = randomUUID();
  const outsiderId = randomUUID();
  const hiddenId = randomUUID();
  const sharedId = randomUUID();
  const childId = randomUUID();
  const privateId = randomUUID();
  const externalId = randomUUID();
  const directFileId = randomUUID();
  const movingFileId = randomUUID();
  const fileName = 'Tệp trong thư mục.txt';
  const bytes = Buffer.from('Nội dung được chia sẻ.\n', 'utf8');
  const password = 'Synthetic ancestor pass!';
  const hash = await hashPassword(password);
  await previous.query(`
    INSERT INTO users (id, email, name, password_hash, quota_bytes, used_bytes)
    VALUES ($1, 'owner@example.test', 'Test Owner', $4, 200, $5),
           ($2, 'viewer@example.test', 'Test Viewer', $4, 200, 0),
           ($3, 'outsider@example.test', 'Other Owner', $4, 200, 0)
  `, [ownerId, viewerId, outsiderId, hash, bytes.length * 2]);
  for (const [id, owner, parent, name] of [
    [hiddenId, ownerId, null, 'Private ancestor'],
    [sharedId, ownerId, hiddenId, 'Shared folder'],
    [childId, ownerId, sharedId, 'Child folder'],
    [privateId, ownerId, null, 'Private destination'],
    [externalId, outsiderId, null, 'Outsider folder'],
  ]) {
    await previous.query('INSERT INTO folders (id, owner_id, parent_id, name) VALUES ($1,$2,$3,$4)', [
      id, owner, parent, name,
    ]);
  }
  for (const [id, name] of [[directFileId, fileName], [movingFileId, 'Second fixture.txt']]) {
    await previous.query(`
      INSERT INTO files (id, owner_id, folder_id, original_name, mime_type, size_bytes, object_key, upload_state)
      VALUES ($1,$2,$3,$4,'text/plain',$5,$6,'ready')
    `, [id, ownerId, childId, name, bytes.length, 'files/' + id]);
  }
  const originalFiles = await previous.query<Record<string, unknown>[]>('SELECT * FROM files ORDER BY id');
  const originalQuota = await previous.query('SELECT id, used_bytes, quota_bytes FROM users ORDER BY id');
  await previous.destroy();

  await db.initialize();
  assert.deepEqual((await db.runMigrations()).map((migration) => migration.name), [
    'AddFolderShares1765152000000',
    'AddFolderTrash1765238400000',
    'AddTrashPurge1765324800000',
  ]);
  assert.deepEqual(await db.runMigrations(), []);
  assert.deepEqual(await db.query('SELECT * FROM files ORDER BY id'),
    originalFiles.map((file) => ({ ...file, trash_event_id: null })));
  let storageReads = 0;
  const storage: ObjectStorage = {
    async read(key) {
      storageReads++;
      assert.ok([directFileId, movingFileId].some((id) => key === 'files/' + id));
      return Readable.from([Buffer.from(bytes)]);
    },
    async put() { throw new Error('Permission and topology writes must not update storage'); },
    async remove() { throw new Error('Permission and topology writes must not delete storage'); },
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

  async function json(response: Response, status: number) {
    assert.equal(response.status, status);
    return response.json();
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
  const outsider = await signIn('outsider@example.test');
  const folder = (id: string) => '/folders/' + id;
  const file = (id: string) => '/files/' + id;
  const contents = async (id: string, cookie: string, status = 200, query = '') =>
    json(await request(folder(id) + '/contents' + query, cookie), status);
  const grants = (id: string) => folder(id) + '/shares';
  const grant = (id: string) => request(grants(id), owner, 'PUT', { email: 'viewer@example.test' });
  const revoke = (id: string) => request(grants(id) + '/' + viewerId, owner, 'DELETE');
  const read = (id: string, cookie: string) => request(file(id), cookie);
  const moveFile = (id: string, folderId: string | null) => request(file(id), owner, 'PATCH', { folderId });
  const trash = (id: string) => request(file(id) + '/trash', owner, 'POST');
  const restore = (id: string) => request(file(id) + '/restore', owner, 'POST');
  const expire = (id: string) => db.query(`
    UPDATE folder_shares SET granted_at = statement_timestamp() - INTERVAL '1 day', expires_at = statement_timestamp()
    WHERE folder_id = $1 AND recipient_id = $2
  `, [id, viewerId]);

  await contents(sharedId, viewer, 404);
  await json(await read(directFileId, viewer), 404);
  await json(await request('/shared-folders'), 401);
  const grantSummary = (await json(await grant(sharedId), 200)).data;
  const [month] = await db.query<{ expires_at: Date }[]>(
    'SELECT default_file_share_expiry($1::timestamptz) AS expires_at', [grantSummary.grantedAt]
  );
  assert.equal(grantSummary.expiresAt, month?.expires_at.toISOString());
  assert.deepEqual((await json(await grant(sharedId), 200)).data, grantSummary);
  assert.equal((await json(await request(grants(sharedId), owner, 'PUT', { email: 'missing@example.test' }), 404))
    .error.code, 'RECIPIENT_NOT_FOUND');
  const sharedList = await json(await request('/shared-folders?limit=1&page=1', viewer), 200);
  assert.deepEqual(sharedList.data.items, [{
    kind: 'folder', id: sharedId, name: 'Shared folder', ownerName: 'Test Owner',
    sharedAt: grantSummary.grantedAt, expiresAt: grantSummary.expiresAt,
  }]);
  assert.deepEqual(sharedList.pagination, { page: 1, limit: 1, total: 1, totalPages: 1 });
  assert.deepEqual((await json(await request('/shared-with-me', viewer), 200)).data.items, []);
  assert.deepEqual((await json(await request('/shared-folders', outsider), 200)).data.items, []);
  const boundary = (await contents(sharedId, viewer)).data;
  assert.equal(boundary.access, 'viewer');
  assert.equal(boundary.folder.parentId, null);
  assert.deepEqual(boundary.breadcrumbs, [{ id: sharedId, name: 'Shared folder' }]);
  const descendant = (await contents(childId, viewer)).data;
  assert.deepEqual(descendant.breadcrumbs, [{ id: sharedId, name: 'Shared folder' }, { id: childId, name: 'Child folder' }]);
  assert.equal(descendant.folder.parentId, sharedId);
  assert.equal((await contents(sharedId, owner)).data.folder.parentId, hiddenId);
  await contents(hiddenId, viewer, 404);
  await contents(childId, outsider, 404);
  const root = (await contents('root', viewer)).data;
  assert.equal(root.access, 'owner');
  assert.deepEqual(root.items, []);
  for (const [path, method, body] of [
    [grants(sharedId), 'GET', undefined],
    [grants(sharedId), 'PUT', { email: 'outsider@example.test' }],
    [grants(sharedId) + '/' + outsiderId, 'DELETE', undefined],
    [folder(childId), 'PATCH', { name: 'Denied' }],
    ['/folders', 'POST', { name: 'Denied', parentId: childId }],
    [file(directFileId), 'PATCH', { folderId: null }],
    [file(directFileId) + '/trash', 'POST', undefined],
  ] as const) await json(await request(path, viewer, method, body), 404);
  await json(await read(movingFileId, viewer), 200);
  await json(await read(movingFileId, outsider), 404);

  const [limit] = await db.query<{ expires_at: Date }[]>(
    "SELECT date_trunc('milliseconds', statement_timestamp()) + INTERVAL '2 days' AS expires_at"
  );
  assert.ok(limit);
  const customExpiry = limit.expires_at.toISOString();
  const directChildGrant = (await json(await request(grants(childId), owner, 'PUT', {
    email: 'viewer@example.test', expiresAt: customExpiry,
  }), 200)).data;
  assert.equal(directChildGrant.expiresAt, customExpiry);
  await expire(sharedId);
  await contents(sharedId, viewer, 404);
  assert.deepEqual((await contents(childId, viewer)).data.breadcrumbs, [{ id: childId, name: 'Child folder' }]);
  assert.equal((await contents(childId, viewer)).data.folder.parentId, null);
  await json(await read(movingFileId, viewer), 200);
  assert.equal((await json(await request(grants(sharedId), owner), 200)).data.items[0].isActive, false);
  assert.deepEqual((await json(await request('/shared-folders', viewer), 200)).data.items.map((row: { id: string }) => row.id), [childId]);
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(await json(await revoke(childId), 200), { success: true, data: { revoked: true } });
  }
  await json(await read(movingFileId, viewer), 404);
  await json(await request(file(movingFileId) + '/download', viewer), 404);

  await json(await grant(sharedId), 200);
  await json(await request(file(directFileId) + '/shares', owner, 'PUT', { email: 'viewer@example.test' }), 200);
  await json(await request(folder(childId), owner, 'PATCH', { parentId: privateId }), 200);
  await contents(childId, viewer, 404);
  await json(await read(directFileId, viewer), 200);
  await json(await read(movingFileId, viewer), 404);
  await json(await request(folder(childId), owner, 'PATCH', { parentId: sharedId }), 200);
  await json(await read(movingFileId, viewer), 200);
  assert.equal((await json(await moveFile(directFileId, privateId), 200)).data.folderId, privateId);
  await json(await read(directFileId, viewer), 200);
  await json(await moveFile(directFileId, childId), 200);
  await json(await moveFile(movingFileId, externalId), 404);
  assert.equal((await json(await moveFile(movingFileId, privateId), 200)).data.folderId, privateId);
  await json(await read(movingFileId, viewer), 404);
  assert.equal((await json(await moveFile(movingFileId, childId), 200)).data.folderId, childId);
  await json(await read(movingFileId, viewer), 200);
  const downloaded = await request(file(movingFileId) + '/download', viewer);
  assert.equal(downloaded.status, 200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);

  assert.equal((await json(await trash(directFileId), 200)).data.folderId, childId);
  await json(await read(directFileId, viewer), 404);
  assert.deepEqual((await json(await restore(directFileId), 200)).data, {
    id: directFileId, folderId: null, originalName: fileName, trashedAt: null,
  });
  await json(await read(directFileId, viewer), 404);
  assert.deepEqual((await json(await request('/shared-with-me', viewer), 200)).data.items, []);
  assert.equal((await json(await restore(movingFileId), 200)).data.folderId, childId);

  await json(await trash(movingFileId), 200);
  const [restored, revoked] = await Promise.all([restore(movingFileId), revoke(sharedId)]);
  const result = (await json(restored, 200)).data;
  assert.ok(result.folderId === null || result.folderId === childId);
  await json(revoked, 200);
  await json(await read(movingFileId, viewer), 404);
  await json(await moveFile(movingFileId, childId), 200);
  await json(await grant(sharedId), 200);
  await expire(sharedId);
  await json(await trash(movingFileId), 200);
  assert.equal((await json(await restore(movingFileId), 200)).data.folderId, childId);
  await json(await read(movingFileId, viewer), 404);

  const restoredDownload = await request(file(directFileId) + '/download', owner);
  assert.equal(restoredDownload.status, 200);
  assert.equal(restoredDownload.headers.get('Content-Disposition'), "attachment; filename*=UTF-8''" + encodeURIComponent(fileName));
  assert.deepEqual(Buffer.from(await restoredDownload.arrayBuffer()), bytes);
  assert.equal(storageReads, 2);
  assert.deepEqual(await db.query('SELECT id, used_bytes, quota_bytes FROM users ORDER BY id'), originalQuota);
  assert.deepEqual(await db.query<{ count: string }[]>('SELECT count(*) FROM file_shares'), [{ count: '0' }]);
});
