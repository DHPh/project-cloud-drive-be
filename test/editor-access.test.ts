import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createApp } from '../src/app';
import { appConfig } from '../src/config';
import { createDatabase } from '../src/database';
import { createFiles } from '../src/files';
import type { ObjectStorage } from '../src/object-storage';
import { hashPassword } from '../src/session';

const databaseUrl = process.env.BACKEND_TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:3000';

test('ACCESS-01 upgrades grants, enforces effective editor rights and reconciles an upload after revocation', {
  skip: !databaseUrl,
}, async (t) => {
  const admin = await createDatabase(databaseUrl!).initialize();
  const schema = 'editor_access_test_' + randomBytes(8).toString('hex');
  const options = { schema, extra: { options: '-c search_path=' + schema, statement_timeout: 10000 } };
  const db = createDatabase(databaseUrl!).setOptions(options);
  const migrations = db.options.migrations;
  assert.ok(Array.isArray(migrations));
  const legacy = createDatabase(databaseUrl!).setOptions({ ...options, migrations: migrations.slice(0, 9) });
  let server: ReturnType<typeof createServer> | undefined;
  t.after(async () => {
    try {
      const running = server;
      if (running?.listening) await new Promise<void>((resolve) => running.close(() => resolve()));
      if (legacy.isInitialized) await legacy.destroy();
      if (db.isInitialized) await db.destroy();
      await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    } finally {
      await admin.destroy();
    }
  });

  await admin.query('CREATE SCHEMA ' + schema);
  await legacy.initialize();
  assert.equal((await legacy.runMigrations()).length, 9);
  const ownerId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const outerId = randomUUID();
  const innerId = randomUUID();
  const deepId = randomUUID();
  const sourceId = randomUUID();
  const sourceBytes = Buffer.from('Chi tiết để kiểm tra quyền chỉnh sửa.', 'utf8');
  const password = 'Synthetic editor test password!';
  await legacy.query(`
    INSERT INTO users (id, email, name, password_hash, quota_bytes, used_bytes)
    VALUES ($1, 'owner@example.test', 'Owner', $4, 10000, $5),
           ($2, 'editor@example.test', 'Editor', $4, 10000, 0),
           ($3, 'viewer@example.test', 'Viewer', $4, 10000, 0)
  `, [ownerId, editorId, viewerId, await hashPassword(password), sourceBytes.length]);
  await legacy.query(`
    INSERT INTO folders (id, owner_id, parent_id, name) VALUES
    ($1, $4, NULL, 'Private outer'), ($2, $4, $1, 'Shared inner'), ($3, $4, $2, 'Deep child')
  `, [outerId, innerId, deepId, ownerId]);
  await legacy.query(`
    INSERT INTO files(id, owner_id, folder_id, original_name, mime_type, size_bytes, object_key, upload_state)
    VALUES ($1, $2, $3, 'Nguồn.txt', 'text/plain', $4, $5, 'ready')
  `, [sourceId, ownerId, deepId, sourceBytes.length, 'files/' + sourceId]);
  await legacy.query(`
    INSERT INTO folder_shares (folder_id, recipient_id, granted_at, expires_at)
    VALUES ($1, $2, now(), now() + INTERVAL '1 day'), ($1, $3, now(), now() + INTERVAL '1 day')
  `, [innerId, editorId, viewerId]);
  await legacy.query(`
    INSERT INTO file_shares (file_id, recipient_id, granted_at, expires_at) VALUES ($1, $2, now(), now() + INTERVAL '1 day')
  `, [sourceId, editorId]);
  await legacy.destroy();

  await db.initialize();
  assert.ok((await db.runMigrations()).some((migration) => migration.name === 'AddEditorGrants1765584000000'));
  assert.deepEqual(await db.runMigrations(), []);
  const objects = new Map([['files/' + sourceId, sourceBytes]]);
  let holdPut = false;
  let failRemove = false;
  let putEntered!: (key: string) => void;
  let releasePut!: () => void;
  const putEntry = new Promise<string>((resolve) => { putEntered = resolve; });
  const gate = new Promise<void>((resolve) => { releasePut = resolve; });
  t.after(() => releasePut());
  const storage: ObjectStorage = {
    async put(key, bytes) {
      objects.set(key, Buffer.from(bytes));
      if (holdPut) { putEntered(key); await gate; }
    },
    async read(key) {
      const bytes = objects.get(key);
      assert.ok(bytes);
      return Readable.from([bytes]);
    },
    async remove(key) {
      if (failRemove) throw new Error('Synthetic object cleanup failure');
      objects.delete(key);
    },
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
    if (body && !(body instanceof FormData)) headers.set('Content-Type', 'application/json');
    const response = await fetch(baseUrl + path, { method, headers, body: body instanceof FormData ? body : body && JSON.stringify(body) });
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    return response;
  }

  async function signIn(email: string) {
    const response = await request('/auth/login', undefined, 'POST', { email, password });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('Set-Cookie')?.split(';')[0];
    assert.ok(cookie);
    return cookie;
  }

  async function data(response: Response, status = 200) {
    assert.equal(response.status, status);
    return (await response.json()).data;
  }

  const [owner, editor, viewer] = await Promise.all([
    signIn('owner@example.test'), signIn('editor@example.test'), signIn('viewer@example.test'),
  ]);
  const file = '/files/' + sourceId;
  const inner = '/folders/' + innerId;
  const deeper = '/folders/' + deepId;
  const recipient = 'editor@example.test';
  const grant = (path: string, access?: 'editor' | 'viewer') => request(path + '/shares', owner, 'PUT', { email: recipient, access });
  const upload = (cookie: string, name: string, content: string) => {
    const body = new FormData();
    body.set('file', new Blob([content], { type: 'text/plain' }), name);
    body.set('folderId', deepId);
    return request('/files', cookie, 'POST', body);
  };
  async function charged(id: string) {
    const [user] = await db.query<{ used_bytes: string }[]>('SELECT used_bytes FROM users WHERE id = $1', [id]);
    return Number(user?.used_bytes);
  }

  assert.equal((await data(await request(file, editor))).access, 'viewer');
  assert.equal((await data(await request(file + '/shares', owner))).items[0].access, 'viewer');
  assert.equal((await data(await request(inner + '/contents', editor))).access, 'viewer');
  assert.equal((await request(file, editor, 'PATCH', { description: 'Denied' })).status, 404);
  assert.equal((await data(await grant(inner, 'editor'))).access, 'editor');
  assert.equal((await data(await grant(inner))).access, 'editor');
  assert.equal((await data(await request('/shared-by-me?type=folders', owner))).items
    .find((item: { grant: { recipientId: string } }) => item.grant.recipientId === editorId).grant.access, 'editor');
  const sharedBoundary = await data(await request(inner + '/contents', editor));
  assert.equal(sharedBoundary.access, 'editor');
  assert.equal(sharedBoundary.folder.parentId, null);
  assert.deepEqual(sharedBoundary.breadcrumbs, [{ id: innerId, name: 'Shared inner' }]);
  assert.equal((await data(await request(deeper + '/contents', editor))).access, 'editor');
  assert.equal((await data(await request(file, editor))).access, 'editor');
  assert.equal((await data(await request(file, viewer))).access, 'viewer');

  const edited = await data(await request(file, editor, 'PATCH', { originalName: 'Đổi tên.txt', description: 'Sửa metadata', tags: ['thẻ'] }));
  assert.equal(edited.originalName, 'Đổi tên.txt');
  assert.deepEqual(edited.tags, ['thẻ']);
  assert.equal((await data(await request(deeper, editor, 'PATCH', { description: 'Chỉ sửa mô tả' }))).description, 'Chỉ sửa mô tả');
  for (const [path, method, body] of [
    [file, 'PATCH', { folderId: null }], [file + '/trash', 'POST', undefined],
    [file + '/shares', 'PUT', { email: 'viewer@example.test' }], [deeper, 'PATCH', { name: 'Forbidden' }],
    [deeper, 'PATCH', { parentId: innerId }], ['/folders', 'POST', { name: 'Forbidden', parentId: deepId }],
  ] as const) assert.equal((await request(path, editor, method, body)).status, 404);
  assert.equal((await request(deeper, viewer, 'PATCH', { description: 'Denied' })).status, 404);
  assert.equal((await upload(viewer, 'Denied.txt', 'denied')).status, 404);

  await data(await request(file, owner, 'PATCH', { folderId: null }));
  assert.equal((await data(await request(file, editor))).access, 'viewer');
  assert.equal((await request(file, editor, 'PATCH', { tags: [] })).status, 404);
  assert.equal((await data(await grant(file, 'editor'))).access, 'editor');
  assert.equal((await data(await request(file, editor))).access, 'editor');
  await data(await request(file, editor, 'PATCH', { tags: [] }));
  await data(await request(file, owner, 'PATCH', { folderId: deepId }));

  await db.query(`UPDATE folder_shares SET granted_at = now() - INTERVAL '2 days', expires_at = now() - INTERVAL '1 day'
    WHERE folder_id = $1 AND recipient_id = $2`, [innerId, editorId]);
  assert.equal((await request(deeper + '/contents', editor)).status, 404);
  assert.equal((await data(await grant(inner))).access, 'editor');

  const content = 'Editor upload uses owner quota';
  const uploaded = await data(await upload(editor, 'Tải lên bằng quyền editor.txt', content), 201);
  const usedAfterUpload = sourceBytes.length + Buffer.byteLength(content);
  assert.equal(await charged(ownerId), usedAfterUpload);
  assert.equal(await charged(editorId), 0);
  assert.equal((await data(await request('/files/' + uploaded.id, owner))).access, 'owner');
  assert.equal((await data(await request('/files/' + uploaded.id, editor))).access, 'editor');
  const download = await request('/files/' + uploaded.id + '/download', owner);
  assert.equal(await download.text(), content);
  await db.query('UPDATE users SET quota_bytes = used_bytes WHERE id = $1', [ownerId]);
  assert.equal((await upload(editor, 'Không còn chỗ.txt', 'quota')).status, 409);
  await db.query('UPDATE users SET quota_bytes = 10000 WHERE id = $1', [ownerId]);

  holdPut = true;
  const raceBytes = 'Revoke during PUT';
  const inFlight = upload(editor, 'Thu hồi lúc tải.txt', raceBytes);
  const pendingKey = await Promise.race([putEntry, inFlight.then(() => assert.fail('Upload finalized before the storage barrier'))]);
  try {
    assert.equal(await charged(ownerId), usedAfterUpload + Buffer.byteLength(raceBytes));
    assert.equal((await data(await grant(inner, 'viewer'))).access, 'viewer');
  } finally {
    releasePut();
  }
  assert.equal((await inFlight).status, 404);
  const [pending] = await db.query<{ id: string; upload_state: string }[]>(
    'SELECT id, upload_state FROM files WHERE owner_id = $1 AND object_key = $2', [ownerId, pendingKey]);
  assert.ok(pending);
  assert.equal(pending.upload_state, 'cleanup');
  assert.equal((await request('/files/' + pending.id, owner)).status, 404);
  assert.equal(await charged(ownerId), usedAfterUpload + Buffer.byteLength(raceBytes));
  await db.query("UPDATE files SET updated_at = now() - INTERVAL '1 hour' WHERE id = $1", [pending.id]);
  failRemove = true;
  const worker = createFiles(db, storage, 300000);
  assert.deepEqual(await worker.reconcile(), { removed: 0, failed: 1 });
  assert.equal(await charged(ownerId), usedAfterUpload + Buffer.byteLength(raceBytes));
  assert.equal(objects.has(pendingKey), true);
  assert.deepEqual(await worker.reconcile(), { removed: 0, failed: 0 });
  failRemove = false;
  await db.query("UPDATE files SET updated_at = now() - INTERVAL '1 hour' WHERE id = $1", [pending.id]);
  assert.deepEqual(await worker.reconcile(), { removed: 1, failed: 0 });
  assert.equal(await charged(ownerId), usedAfterUpload);
  assert.equal(objects.has(pendingKey), false);
});
