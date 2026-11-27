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
import { attachmentHeader } from '../src/multipart';
import type { ObjectStorage } from '../src/object-storage';
import { hashPassword } from '../src/session';

const origin = 'http://127.0.0.1:3000';
const testDatabase = process.env.BACKEND_TEST_DATABASE_URL;

test('production requires a matching HTTPS origin and Secure cookie', () => {
  assert.throws(() => appConfig({ NODE_ENV: 'production', APP_ORIGIN: origin }));
  assert.throws(() => appConfig({
    NODE_ENV: 'production', APP_ORIGIN: 'https://drive.example.test', SESSION_COOKIE_SECURE: 'false',
  }));
  assert.equal(appConfig({ NODE_ENV: 'production', APP_ORIGIN: 'https://drive.example.test' }).secureCookie, true);

  const multi = appConfig({
    NODE_ENV: 'production',
    APP_ORIGIN: 'https://cloud.dhpham.dev, https://project-cloud-drive-fe.vercel.app',
  });
  assert.equal(multi.origin, 'https://cloud.dhpham.dev');
  assert.deepEqual(multi.origins, ['https://cloud.dhpham.dev', 'https://project-cloud-drive-fe.vercel.app']);
  assert.equal(multi.secureCookie, true);

  assert.throws(() => appConfig({
    NODE_ENV: 'production',
    APP_ORIGIN: 'https://cloud.dhpham.dev, http://localhost:3000',
  }));
  assert.throws(() => appConfig({ APP_ORIGIN: 'https://cloud.dhpham.dev,' }));
  assert.throws(() => appConfig({ APP_ORIGIN: 'https://cloud.dhpham.dev/' }));
});

test('proxy trust requires explicit valid IPs or non-global CIDRs', () => {
  assert.deepEqual(appConfig({}).trustedProxyRanges, []);
  assert.deepEqual(appConfig({ TRUSTED_PROXY_RANGES: ' 192.0.2.4, 2001:db8::/64 ' }).trustedProxyRanges, ['192.0.2.4', '2001:db8::/64']);
  for (const value of ['true', '0.0.0.0/0', '::/0', '127.0.0.1/33', '127.0.0.1/8/8']) {
    assert.throws(() => appConfig({ TRUSTED_PROXY_RANGES: value }), /TRUSTED_PROXY_RANGES/);
  }
});

test('attachment disposition keeps an exact name for ASCII and Unicode', () => {
  assert.equal(
    attachmentHeader('Report 1.txt'),
    "attachment; filename=\"Report 1.txt\"; filename*=UTF-8''Report%201.txt"
  );
  assert.equal(
    attachmentHeader("Kế hoạch (đợt 1)'s.txt"),
    "attachment; filename*=UTF-8''K%E1%BA%BF%20ho%E1%BA%A1ch%20%28%C4%91%E1%BB%A3t%201%29%27s.txt"
  );
});

test('DRIVE-01 HTTP contract and storage transitions on PostgreSQL', { skip: !testDatabase }, async (t) => {
  const admin = await createDatabase(testDatabase!).initialize();
  const schema = 'drive_test_' + randomBytes(8).toString('hex');
  await admin.query('CREATE SCHEMA ' + schema);
  t.after(async () => {
    await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
    await admin.destroy();
  });
  const db = createDatabase(testDatabase!);
  db.setOptions({ schema, extra: { options: '-c search_path=' + schema, statement_timeout: 10000 } });
  await db.initialize();
  t.after(async () => { await db.destroy(); });
  assert.equal((await db.runMigrations()).length, 11);
  assert.equal((await db.runMigrations()).length, 0);

  const owner = randomUUID();
  const other = randomUUID();
  const folder = randomUUID();
  const child = randomUUID();
  const privateFolder = randomUUID();
  const password = 'Synthetic env pass!';
  const passwordHash = await hashPassword(password);
  await db.query(
    'INSERT INTO users (id, email, name, password_hash, quota_bytes) VALUES ($1,$2,$3,$4,200),($5,$6,$7,$4,200)',
    [owner, 'owner@example.test', 'Test Owner', passwordHash, other, 'other@example.test', 'Other Owner']
  );
  await db.query(
    'INSERT INTO folders (id, owner_id, parent_id, name) VALUES ($1,$2,NULL,$3),($4,$2,$1,$5),($6,$7,NULL,$8)',
    [folder, owner, 'Documents', child, 'a Subfolder', privateFolder, other, 'Other Private Folder']
  );

  const objects = new Map<string, Buffer>();
  let failWrite = false;
  const failingRemovals = new Set<string>();
  const storage: ObjectStorage = {
    async put(key, bytes) {
      objects.set(key, bytes);
      if (failWrite) throw new Error('Simulated interrupted write');
    },
    async read(key) {
      const bytes = objects.get(key);
      if (!bytes) throw new Error('Missing fixture');
      return Readable.from([bytes]);
    },
    async remove(key) {
      if (failingRemovals.has(key)) throw new Error('Simulated storage outage');
      objects.delete(key);
    },
  };
  const config = appConfig({ APP_ORIGIN: origin, MAX_UPLOAD_BYTES: '32', UPLOAD_RECOVERY_AGE_SECONDS: '60' });
  const server = createServer(createApp(db, storage, config));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a listening TCP port');
  const baseUrl = 'http://127.0.0.1:' + address.port + '/api/v1';

  async function request(path: string, options: RequestInit = {}, cookie?: string): Promise<Response> {
    const headers = new Headers(options.headers);
    if (cookie) headers.set('Cookie', cookie);
    if (options.method && options.method !== 'GET' && !headers.has('Origin')) headers.set('Origin', origin);
    const response = await fetch(baseUrl + path, { ...options, headers });
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    return response;
  }

  async function signIn(email: string): Promise<string> {
    const response = await request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('Set-Cookie');
    assert.ok(cookie);
    assert.ok(cookie.includes('HttpOnly'));
    assert.ok(cookie.includes('SameSite=Lax'));
    const user = (await response.json()).data;
    assert.deepEqual(Object.keys(user).sort(), ['email', 'id', 'name', 'role']);
    assert.equal(user.role, 'user');
    return cookie.split(';')[0]!;
  }

  function multipart(name: string, content: string, folderId = 'root') {
    const body = new FormData();
    body.append('file', new Blob([content], { type: 'text/plain' }), name);
    body.append('folderId', folderId);
    return body;
  }

  function upload(cookie: string, name: string, content: string, folderId = 'root') {
    return request('/files', { method: 'POST', body: multipart(name, content, folderId) }, cookie);
  }

  const anonymous = await request('/auth/me');
  assert.equal(anonymous.status, 401);
  assert.equal((await anonymous.json()).error.code, 'SESSION_REQUIRED');
  const deniedOrigin = await request('/auth/logout', { method: 'POST', headers: { Origin: 'https://other.example.test' } });
  assert.equal(deniedOrigin.status, 403);
  const cookie = await signIn('owner@example.test');
  const otherCookie = await signIn('other@example.test');
  assert.equal((await request('/auth/me', {}, cookie)).status, 200);

  assert.equal((await upload(cookie, 'other.txt', 'hello', privateFolder)).status, 404);
  assert.equal((await request('/folders/' + privateFolder + '/contents', {}, cookie)).status, 404);
  assert.equal((await upload(cookie, 'too-long.txt', 'x'.repeat(33))).status, 413);
  const exactLimit = await upload(cookie, 'exact length.txt', 'x'.repeat(32), folder);
  assert.equal(exactLimit.status, 201);

  const deniedMultipart = multipart('one.txt', 'one');
  deniedMultipart.append('file', new Blob(['two']), 'two.txt');
  assert.equal((await request('/files', { method: 'POST', body: deniedMultipart }, cookie)).status, 400);

  const bytes = 'Dữ liệu';
  const uploaded = await upload(cookie, 'Kế hoạch %.txt', bytes, folder);
  assert.equal(uploaded.status, 201);
  const entry = (await uploaded.json()).data;
  assert.equal(entry.originalName, 'Kế hoạch %.txt');
  assert.equal(entry.size, Buffer.byteLength(bytes));
  assert.equal('objectKey' in entry, false);
  assert.equal((await request('/files/' + entry.id + '/download', {}, otherCookie)).status, 404);

  const nextPage = await request('/folders/' + folder + '/contents?limit=1&page=2', {}, cookie);
  const nextData = await nextPage.json();
  assert.equal(nextData.data.folder.name, 'Documents');
  assert.deepEqual(nextData.data.breadcrumbs, [{ id: folder, name: 'Documents' }]);
  assert.equal(nextData.data.items[0].originalName, 'exact length.txt');
  assert.deepEqual(nextData.pagination, { page: 2, limit: 1, total: 3, totalPages: 3 });
  const literalMatch = await request('/folders/' + folder + '/contents?q=%25', {}, cookie);
  assert.equal((await literalMatch.json()).data.items[0].id, entry.id);
  const sibling = await request('/folders/' + child + '/contents?q=%25', {}, cookie);
  assert.deepEqual((await sibling.json()).data.breadcrumbs, [{ id: folder, name: 'Documents' }, { id: child, name: 'a Subfolder' }]);
  const pastEnd = await request('/folders/' + folder + '/contents?page=99', {}, cookie);
  assert.deepEqual((await pastEnd.json()).data.items, []);

  const update = await request('/files/' + entry.id, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ originalName: 'Đề án.txt', description: 'Sample', tags: ['a'] }),
  }, cookie);
  assert.equal(update.status, 200);
  assert.equal((await update.json()).data.originalName, 'Đề án.txt');
  const cleared = await request('/files/' + entry.id, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description: null, tags: [] }),
  }, cookie);
  assert.equal((await cleared.json()).data.description, null);
  const download = await request('/files/' + entry.id + '/download', {}, cookie);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('Content-Disposition'), attachmentHeader('Đề án.txt'));
  assert.equal(download.headers.get('Content-Type'), 'application/octet-stream');
  assert.equal(await download.text(), bytes);

  await db.query('UPDATE users SET quota_bytes = used_bytes + 20 WHERE id = $1', [owner]);
  const concurrent = await Promise.all([
    upload(cookie, 'concurrent 1.txt', 'x'.repeat(20)),
    upload(cookie, 'concurrent 2.txt', 'x'.repeat(20)),
  ]);
  assert.deepEqual(concurrent.map((response) => response.status).sort(), [201, 409]);
  await db.query('UPDATE users SET quota_bytes = 200 WHERE id = $1', [owner]);

  failWrite = true;
  const storageError = await upload(cookie, 'interrupted.txt', 'suspect bytes');
  assert.equal(storageError.status, 503);
  assert.equal((await storageError.json()).error.code, 'STORAGE_UNAVAILABLE');
  const [interrupted] = await db.query<{ object_key: string; upload_state: string }[]>(
    "SELECT object_key, upload_state FROM files WHERE owner_id = $1 AND original_name = 'interrupted.txt'", [owner]
  );
  assert.equal(interrupted?.upload_state, 'cleanup');
  assert.ok(interrupted && objects.has(interrupted.object_key));
  const files = createFiles(db, storage, config.uploadRecoveryAgeMs);
  assert.deepEqual(await files.reconcile(), { removed: 0, failed: 0 });

  // Fill the worker's first batch with failures and put one healthy cleanup item after it.
  const oldest = Array.from({ length: 24 }, () => randomUUID());
  const newer = randomUUID();
  const newerKey = 'files/' + newer;
  for (const id of [...oldest, newer]) objects.set('files/' + id, Buffer.from('x'));
  const retryKeys = [interrupted.object_key, ...oldest.map((id) => 'files/' + id)];
  for (const key of retryKeys) failingRemovals.add(key);
  await db.transaction(async (manager) => {
    await manager.query('UPDATE users SET used_bytes = used_bytes + $2 WHERE id = $1', [owner, oldest.length + 1]);
    await manager.query(`
      INSERT INTO files (id, owner_id, original_name, mime_type, size_bytes, object_key, upload_state, updated_at)
      SELECT id, $1, 'Cleanup fixture.txt', 'text/plain', 1, 'files/' || id::text, 'cleanup',
        now() - CASE WHEN id = $2 THEN INTERVAL '2 minutes' ELSE INTERVAL '3 minutes' END
      FROM unnest($3::uuid[]) fixtures(id)
    `, [owner, newer, [...oldest, newer]]);
    await manager.query("UPDATE files SET updated_at = now() - interval '3 minutes' WHERE object_key = $1", [interrupted.object_key]);
  });
  const readQuota = () => db.query<{ used_bytes: string }[]>('SELECT used_bytes FROM users WHERE id = $1', [owner]);
  const [charged] = await readQuota();
  assert.ok(charged);
  const bytesBefore = Number(charged.used_bytes);
  assert.deepEqual(await files.reconcile(), { removed: 0, failed: 25 });
  assert.ok(retryKeys.every((key) => objects.has(key)));
  assert.equal(Number((await readQuota())[0]?.used_bytes), bytesBefore);

  const restartedWorker = createFiles(db, storage, config.uploadRecoveryAgeMs);
  assert.deepEqual(await restartedWorker.reconcile(), { removed: 1, failed: 0 });
  assert.equal(objects.has(newerKey), false);
  assert.ok(retryKeys.every((key) => objects.has(key)));
  assert.equal(Number((await readQuota())[0]?.used_bytes), bytesBefore - 1);
  failingRemovals.clear();
  await db.query("UPDATE files SET updated_at = now() - interval '2 minutes' WHERE object_key = ANY($1::text[])", [retryKeys]);
  assert.deepEqual(await files.reconcile(), { removed: 25, failed: 0 });
  assert.deepEqual(await files.reconcile(), { removed: 0, failed: 0 });
  assert.ok(retryKeys.every((key) => !objects.has(key)));
  assert.equal(Number((await readQuota())[0]?.used_bytes), bytesBefore - 25 - Buffer.byteLength('suspect bytes'));
  const [quota] = await db.query<{ matches: boolean }[]>(`
    SELECT used_bytes = (SELECT COALESCE(sum(size_bytes), 0) FROM files WHERE owner_id = $1) AS matches
    FROM users WHERE id = $1
  `, [owner]);
  assert.equal(quota?.matches, true);

  await db.query('UPDATE sessions SET expires_at = now() WHERE user_id = $1', [owner]);
  assert.equal((await request('/auth/me', {}, cookie)).status, 401);
  const loggedOut = await request('/auth/logout', { method: 'POST' }, cookie);
  assert.equal(loggedOut.status, 200);
  assert.ok(loggedOut.headers.get('Set-Cookie')?.includes('Expires='));
});
