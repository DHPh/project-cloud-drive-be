import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { createApp } from '../src/app';
import { appConfig } from '../src/config';
import { createDatabase } from '../src/database';
import type { ObjectStorage } from '../src/object-storage';
import { hashPassword } from '../src/session';

const databaseUrl = process.env.BACKEND_TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:3000';

test('SHARE-03 lists only current direct grants on owned resources and honors grant lifecycle', {
  skip: !databaseUrl,
}, async (t) => {
  const admin = await createDatabase(databaseUrl!).initialize();
  const schema = 'outgoing_shares_test_' + randomBytes(8).toString('hex');
  const db = createDatabase(databaseUrl!).setOptions({ schema, extra: { options: '-c search_path=' + schema } });
  let server: ReturnType<typeof createServer> | undefined;
  t.after(async () => {
    try {
      const running = server;
      if (running?.listening) await new Promise<void>((resolve) => running.close(() => resolve()));
      if (db.isInitialized) await db.destroy();
      await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    } finally {
      await admin.destroy();
    }
  });

  await admin.query('CREATE SCHEMA ' + schema);
  await db.initialize();
  await db.runMigrations();
  const ownerId = randomUUID();
  const recipientId = randomUUID();
  const otherId = randomUUID();
  const folderId = randomUUID();
  const fileId = randomUUID();
  const inheritedFileId = randomUUID();
  const inboundFileId = randomUUID();
  const password = 'Synthetic outgoing shares password!';
  await db.query(`
    INSERT INTO users (id, email, name, password_hash, quota_bytes, used_bytes)
    VALUES ($1, 'owner@example.test', 'Owner', $4, 10000, 2),
           ($2, 'recipient@example.test', 'Recipient', $4, 10000, 0),
           ($3, 'other@example.test', 'Other', $4, 10000, 1)
  `, [ownerId, recipientId, otherId, await hashPassword(password)]);
  await db.query('INSERT INTO folders (id, owner_id, name) VALUES ($1, $2, $3)', [folderId, ownerId, 'Thư mục dùng chung']);
  for (const [id, owner, parent, name] of [
    [fileId, ownerId, folderId, 'Cấp quyền trực tiếp.txt'],
    [inheritedFileId, ownerId, folderId, 'Chỉ quyền kế thừa.txt'],
    [inboundFileId, otherId, null, 'Tệp người khác chia sẻ.txt'],
  ] as const) {
    await db.query(`
      INSERT INTO files (id, owner_id, folder_id, original_name, mime_type, size_bytes, object_key, upload_state)
      VALUES ($1, $2, $3, $4, 'text/plain', 1, $5, 'ready')
    `, [id, owner, parent, name, 'files/' + id]);
  }
  const storage: ObjectStorage = {
    async read() { assert.fail('Outgoing grants do not read storage'); },
    async put() { assert.fail('This fixture does not upload'); },
    async remove() { assert.fail('Grant and reversible Trash operations preserve storage'); },
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

  async function signIn(email: string) {
    const response = await request('/auth/login', undefined, 'POST', { email, password });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('Set-Cookie')?.split(';')[0];
    assert.ok(cookie);
    return cookie;
  }

  const [owner, recipient, other] = await Promise.all([
    signIn('owner@example.test'), signIn('recipient@example.test'), signIn('other@example.test'),
  ]);
  const file = '/files/' + fileId;
  const folder = '/folders/' + folderId;
  const grant = (path: string, cookie: string, email: string) => request(path + '/shares', cookie, 'PUT', { email });
  const revoke = (path: string, recipientKey: string) => request(path + '/shares/' + recipientKey, owner, 'DELETE');
  async function outgoing(query = '', cookie = owner) {
    const response = await request('/shared-by-me' + query, cookie);
    assert.equal(response.status, 200);
    return response.json() as Promise<{
      data: { items: { kind: string; resourceId: string; resourceName: string;
        grant: { recipientId: string; recipientEmail: string; recipientName: string; grantedAt: string; expiresAt: string; isActive: boolean } }[] },
      pagination: { page: number; limit: number; total: number; totalPages: number },
    }>;
  }

  assert.equal((await request('/shared-by-me')).status, 401);
  for (const query of ['type=file', 'status=unlisted', 'limit=101', 'page=0', 'ownerId=' + otherId]) {
    assert.equal((await request('/shared-by-me?' + query, owner)).status, 400);
  }
  assert.equal((await grant(file, owner, 'recipient@example.test')).status, 200);
  assert.equal((await grant(folder, owner, 'recipient@example.test')).status, 200);
  assert.equal((await grant(folder, owner, 'other@example.test')).status, 200);
  assert.equal((await grant('/files/' + inboundFileId, other, 'owner@example.test')).status, 200);
  assert.equal((await request('/files/' + inheritedFileId, recipient)).status, 200);
  assert.equal((await request('/files/' + inboundFileId, owner)).status, 200);
  assert.equal((await outgoing('', recipient)).pagination.total, 0);
  assert.equal((await outgoing('', other)).data.items[0]?.resourceId, inboundFileId);

  const hour = 3600_000;
  const grantedAt = new Date(Date.now() - 24 * hour);
  const expiredAt = new Date(grantedAt.getTime() + hour);
  await db.query('UPDATE file_shares SET granted_at = $2 WHERE file_id = $1', [fileId, grantedAt]);
  await db.query(`
    UPDATE folder_shares SET granted_at = $2, expires_at = CASE WHEN recipient_id = $3 THEN $4 ELSE expires_at END
    WHERE folder_id = $1
  `, [folderId, grantedAt, otherId, expiredAt]);
  const all = await outgoing();
  assert.deepEqual(all.data.items.map((row) => [row.kind, row.resourceId, row.grant.recipientId]), [
    ['file', fileId, recipientId], ...[recipientId, otherId].sort().map((id) => ['folder', folderId, id]),
  ]);
  for (let index = 0; index < 3; index++) {
    const page = await outgoing('?limit=1&page=' + (index + 1));
    assert.deepEqual(page.data.items, [all.data.items[index]]);
    assert.deepEqual(page.pagination, { page: index + 1, limit: 1, total: 3, totalPages: 3 });
  }
  const expired = await outgoing('?type=folders&status=expired');
  assert.deepEqual(expired.data.items, [{
    kind: 'folder', resourceId: folderId, resourceName: 'Thư mục dùng chung',
    grant: { recipientId: otherId, recipientEmail: 'other@example.test', recipientName: 'Other',
      grantedAt: grantedAt.toISOString(), expiresAt: expiredAt.toISOString(), isActive: false },
  }]);
  assert.equal((await outgoing('?type=files&status=active')).pagination.total, 1);
  assert.equal((await outgoing('?type=files&status=expired')).pagination.total, 0);
  assert.equal((await outgoing('?status=active')).pagination.total, 2);

  assert.equal((await grant(folder, owner, 'other@example.test')).status, 200);
  assert.equal((await outgoing('?status=expired')).pagination.total, 0);
  assert.equal((await outgoing('?status=active')).pagination.total, 3);
  assert.equal((await request(folder + '/contents', other)).status, 200);
  assert.equal((await request(file, owner, 'PATCH', { originalName: 'Đã cập nhật.txt' })).status, 200);
  assert.equal((await outgoing('?type=files')).data.items[0]?.resourceName, 'Đã cập nhật.txt');
  assert.equal((await revoke(file, recipientId)).status, 200);
  assert.equal((await request(file, recipient)).status, 200);
  assert.equal((await revoke(folder, recipientId)).status, 200);
  assert.equal((await request(file, recipient)).status, 404);
  assert.equal((await outgoing()).pagination.total, 1);
  assert.equal((await request(folder + '/trash', owner, 'POST')).status, 200);
  assert.equal((await request(folder + '/contents', other)).status, 404);
  assert.equal((await outgoing()).pagination.total, 0);
});
