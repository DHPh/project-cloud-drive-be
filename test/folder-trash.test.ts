import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createApp } from '../src/app';
import { appConfig } from '../src/config';
import { createDatabase } from '../src/database';
import { AddFolderTrash1765238400000 } from '../src/migrations/1765238400000-AddFolderTrash';
import type { ObjectStorage } from '../src/object-storage';
import { hashPassword } from '../src/session';

const testDatabase = process.env.BACKEND_TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:3000';

test('TRASH-02 restores a private batch, retains separate deletions, and resolves name conflicts', {
  skip: !testDatabase,
}, async (t) => {
  const admin = await createDatabase(testDatabase!).initialize();
  const schema = 'folder_trash_test_' + randomBytes(8).toString('hex');
  const schemaOptions = { schema, extra: { options: '-c search_path=' + schema, statement_timeout: 10000 } };
  const db = createDatabase(testDatabase!).setOptions(schemaOptions);
  const migrations = db.options.migrations;
  assert.ok(Array.isArray(migrations));
  const previous = createDatabase(testDatabase!).setOptions({ ...schemaOptions, migrations: migrations.slice(0, 5) });
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
  assert.equal((await previous.runMigrations()).length, 5);
  const ownerId = randomUUID();
  const viewerId = randomUUID();
  const sharedParent = randomUUID();
  const project = randomUUID();
  const child = randomUUID();
  const independentFolder = randomUUID();
  const existingFolder = randomUUID();
  const privateParent = randomUUID();
  const privateChild = randomUUID();
  const directFile = randomUUID();
  const independentFile = randomUUID();
  const existingFile = randomUUID();
  const occupiedSuffix = randomUUID();
  const bytes = Buffer.from('Nội dung kiểm chứng khôi phục.\n', 'utf8');
  const fileName = 'Báo cáo.v2.txt';
  const password = 'Synthetic folder trash password!';
  const passwordHash = await hashPassword(password);
  await previous.query(`
    INSERT INTO users (id, email, name, password_hash, quota_bytes, used_bytes)
    VALUES ($1, 'owner@example.test', 'Test Owner', $3, 1000, $4),
           ($2, 'viewer@example.test', 'Test Viewer', $3, 1000, 0)
  `, [ownerId, viewerId, passwordHash, bytes.length * 4]);
  for (const [id, name, parentId] of [
    [sharedParent, 'Đã chia sẻ', null],
    [project, 'Dự án', sharedParent],
    [child, 'Tài liệu', project],
    [independentFolder, 'Đã xóa riêng', project],
    [existingFolder, 'Dự án', null],
    [randomUUID(), 'Dự án - khôi phục', null],
    [privateParent, 'Riêng tư', null],
    [privateChild, 'Về chỗ cũ', privateParent],
  ]) {
    await previous.query('INSERT INTO folders (id, owner_id, name, parent_id) VALUES ($1, $2, $3, $4)', [
      id, ownerId, name, parentId,
    ]);
  }
  for (const [id, name, parentId, trashedAt] of [
    [directFile, 'Đọc đúng byte.txt', child, null],
    [independentFile, fileName, child, new Date('2026-03-01T12:00:00Z')],
    [existingFile, fileName, null, null],
    [occupiedSuffix, 'Báo cáo.v2 - khôi phục.txt', null, null],
  ]) {
    await previous.query(`
      INSERT INTO files (id, owner_id, folder_id, original_name, mime_type, size_bytes, object_key, upload_state, trashed_at)
      VALUES ($1, $2, $3, $4, 'text/plain', $5, $6, 'ready', $7)
    `, [id, ownerId, parentId, name, bytes.length, 'files/' + id, trashedAt]);
  }
  await previous.query(`
    INSERT INTO folder_shares (folder_id, recipient_id, granted_at, expires_at)
    SELECT f.id, $1, statement_timestamp(), statement_timestamp() + INTERVAL '1 day'
    FROM folders f WHERE f.id IN ($2, $3, $4)
  `, [viewerId, sharedParent, project, child]);
  await previous.query(`
    INSERT INTO file_shares (file_id, recipient_id, granted_at, expires_at)
    VALUES ($1, $2, statement_timestamp(), statement_timestamp() + INTERVAL '1 day')
  `, [directFile, viewerId]);
  const legacyFolders = await previous.query<Record<string, unknown>[]>('SELECT * FROM folders ORDER BY id');
  const originalFiles = await previous.query('SELECT id, object_key, size_bytes FROM files ORDER BY id');
  const originalQuota = await previous.query('SELECT id, used_bytes, quota_bytes FROM users ORDER BY id');
  await previous.destroy();

  await db.initialize();
  assert.deepEqual((await db.runMigrations()).map((migration) => migration.name), [
    'AddFolderTrash1765238400000', 'AddTrashPurge1765324800000', 'AddFolderDescription1765411200000',
    'AddAccountAdministration1765497600000',
  ]);
  assert.deepEqual(await db.runMigrations(), []);
  assert.deepEqual(await db.query('SELECT * FROM folders ORDER BY id'),
    legacyFolders.map((folder) => ({ ...folder, trash_root_id: null, trashed_at: null, trash_event_id: null, description: null })));

  let operationsOnObjects = 0;
  const storage: ObjectStorage = {
    async read(key) {
      assert.equal(key, 'files/' + directFile);
      return Readable.from([Buffer.from(bytes)]);
    },
    async put() { operationsOnObjects++; throw new Error('Trash must preserve the object'); },
    async remove() { operationsOnObjects++; throw new Error('Trash must preserve the object'); },
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
  const folder = '/folders/' + project;
  const childPath = '/folders/' + child;
  const file = '/files/' + directFile;
  const changeFolder = (id: string, action: 'trash' | 'restore') => request(`/folders/${id}/${action}`, owner, 'POST');
  const restoreFile = () => request('/files/' + independentFile + '/restore', owner, 'POST');
  const mixedList = '/trash?includeFolders=true';

  await json(await request(folder + '/trash', viewer, 'POST'), 404);
  await json(await request(folder + '/trash', undefined, 'POST'), 401);
  await json(await request('/trash?includeFolders=1', owner), 400);
  await json(await request(childPath + '/contents', viewer), 200);
  await json(await request(file, viewer), 200);
  await json(await changeFolder(independentFolder, 'trash'), 200);

  // A failed grant deletion must roll back the entire folder batch.
  await db.query(`
    CREATE FUNCTION reject_subtree_revoke() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Synthetic revocation failure'; END;
    $$
  `);
  await db.query(`
    CREATE TRIGGER fail_subtree_revoke BEFORE DELETE ON file_shares FOR EACH ROW
    EXECUTE FUNCTION reject_subtree_revoke()
  `);
  await json(await changeFolder(project, 'trash'), 500);
  await json(await request(childPath + '/contents', viewer), 200);
  assert.equal((await json(await request(childPath + '/shares', owner), 200)).pagination.total, 1);
  await db.query('DROP TRIGGER fail_subtree_revoke ON file_shares');

  const [grant, trashed] = await Promise.all([
    request(file + '/shares', owner, 'PUT', { email: 'viewer@example.test' }), changeFolder(project, 'trash'),
  ]);
  assert.ok([200, 404].includes(grant.status));
  const trashedData = (await json(trashed, 200)).data;
  assert.equal(trashedData.parentId, sharedParent);
  assert.ok(trashedData.trashedAt);
  assert.deepEqual((await json(await changeFolder(project, 'trash'), 200)).data, trashedData);

  for (const actor of [owner, viewer]) {
    await json(await request(folder + '/contents', actor), 404);
    await json(await request(childPath + '/contents', actor), 404);
    await json(await request(file, actor), 404);
    await json(await request(file + '/download', actor), 404);
  }
  await json(await request(childPath + '/shares', owner), 404);
  await json(await request(file + '/shares', owner), 404);
  await json(await request(file, owner, 'PATCH', { folderId: null }), 404);
  await json(await request(childPath, owner, 'PATCH', { parentId: null }), 404);
  await json(await request('/folders', owner, 'POST', { name: 'Hidden new folder', parentId: child }), 404);
  const upload = new FormData();
  upload.set('folderId', child);
  upload.set('file', new Blob([bytes], { type: 'text/plain' }), 'Hidden upload.txt');
  await json(await fetch(baseUrl + '/files', {
    method: 'POST', headers: { Cookie: owner, Origin: origin }, body: upload,
  }), 404);
  await json(await changeFolder(child, 'restore'), 404);
  await json(await request(file + '/restore', owner, 'POST'), 404);
  await assert.rejects(db.transaction((manager) => new AddFolderTrash1765238400000().down(manager.queryRunner!)),
    /Restore folder trash before reverting this migration/);

  const currentShared = (await json(await request('/shared-folders', viewer), 200)).data.items;
  assert.deepEqual(currentShared.map((item: { id: string }) => item.id), [sharedParent]);
  assert.equal((await json(await request('/shared-with-me', viewer), 200)).pagination.total, 0);
  assert.equal((await json(await request(`/folders/${sharedParent}/contents?q=D%E1%BB%B1`, owner), 200)).pagination.total, 0);
  const fileOnly = await json(await request('/trash', owner), 200);
  assert.deepEqual(fileOnly.data.items.map((item: { id: string }) => item.id), [independentFile]);
  assert.deepEqual((await json(await request('/trash?includeFolders=false', owner), 200)), fileOnly);
  for (const [index, id] of [project, independentFolder, independentFile].entries()) {
    const page = await json(await request(mixedList + '&limit=1&page=' + (index + 1), owner), 200);
    assert.equal(page.data.items[0].id, id);
    assert.deepEqual(page.pagination, { page: index + 1, limit: 1, total: 3, totalPages: 3 });
  }
  assert.equal((await json(await request(mixedList, viewer), 200)).pagination.total, 0);

  // The independent file falls back to root while its containing folder is still in Trash.
  const fileRestores = await Promise.all([restoreFile(), restoreFile()]);
  const restoredName = 'Báo cáo.v2 - khôi phục 2.txt';
  for (const response of fileRestores) {
    assert.deepEqual((await json(response, 200)).data, {
      id: independentFile, folderId: null, originalName: restoredName, trashedAt: null,
    });
  }
  assert.equal((await json(await request('/files/' + existingFile, owner), 200)).data.originalName, fileName);

  const folderRestores = await Promise.all([changeFolder(project, 'restore'), changeFolder(project, 'restore')]);
  for (const response of folderRestores) {
    assert.deepEqual((await json(response, 200)).data, {
      id: project, parentId: null, name: 'Dự án - khôi phục 2', trashedAt: null,
    });
  }
  assert.equal((await json(await request(`/folders/${existingFolder}/contents`, owner), 200)).data.folder.name, 'Dự án');
  assert.equal((await json(await request(childPath + '/contents', owner), 200)).data.folder.parentId, project);
  await json(await request(childPath + '/contents', viewer), 404);
  await json(await request(file + '/download', viewer), 404);
  assert.equal((await json(await request(childPath + '/shares', owner), 200)).pagination.total, 0);
  assert.equal((await json(await request(file + '/shares', owner), 200)).pagination.total, 0);
  const download = await request(file + '/download', owner);
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  assert.deepEqual((await json(await request(mixedList, owner), 200)).data.items.map((item: { id: string }) => item.id),
    [independentFolder]);
  assert.equal((await json(await changeFolder(independentFolder, 'restore'), 200)).data.parentId, project);

  await json(await changeFolder(privateChild, 'trash'), 200);
  const newSibling = (await json(await request('/folders', owner, 'POST', {
    parentId: privateParent, name: 'Về chỗ cũ',
  }), 201)).data;
  assert.notEqual(newSibling.id, privateChild);
  assert.deepEqual((await json(await changeFolder(privateChild, 'restore'), 200)).data, {
    id: privateChild, parentId: privateParent, name: 'Về chỗ cũ - khôi phục', trashedAt: null,
  });

  assert.equal(operationsOnObjects, 0);
  assert.deepEqual(await db.query('SELECT id, object_key, size_bytes FROM files ORDER BY id'), originalFiles);
  assert.deepEqual(await db.query('SELECT id, used_bytes, quota_bytes FROM users ORDER BY id'), originalQuota);
  assert.equal((await json(await request(mixedList, owner), 200)).pagination.total, 0);
  await db.undoLastMigration();
  await db.undoLastMigration();
  await db.undoLastMigration();
  await db.undoLastMigration();
  assert.deepEqual((await db.runMigrations()).map((migration) => migration.name), [
    'AddFolderTrash1765238400000', 'AddTrashPurge1765324800000', 'AddFolderDescription1765411200000',
    'AddAccountAdministration1765497600000',
  ]);
});
