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

test('DRIVE-04 searches and filters an owned active Drive before paging or exposing paths', {
  skip: !databaseUrl,
}, async (t) => {
  const admin = await createDatabase(databaseUrl!).initialize();
  const schema = 'drive_listing_test_' + randomBytes(8).toString('hex');
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
  const viewerId = randomUUID();
  const rootFolderId = randomUUID();
  const childFolderId = randomUUID();
  const hiddenFolderId = randomUUID();
  const hiddenChildId = randomUUID();
  const documentId = randomUUID();
  const imageId = randomUUID();
  const audioId = randomUUID();
  const pdfId = randomUUID();
  const videoId = randomUUID();
  const otherId = randomUUID();
  const hiddenFileId = randomUUID();
  const independentId = randomUUID();
  const pendingId = randomUUID();
  const viewerFileId = randomUUID();
  const password = 'Synthetic listing password!';
  await db.query(`
    INSERT INTO users (id, email, name, password_hash, quota_bytes, used_bytes)
    VALUES ($1, 'owner@example.test', 'Owner', $3, 10000, 9), ($2, 'viewer@example.test', 'Viewer', $3, 10000, 1)
  `, [ownerId, viewerId, await hashPassword(password)]);
  await db.query(`
    INSERT INTO folders (id, owner_id, parent_id, name, description)
    VALUES ($1, $5, NULL, 'Dự án', NULL), ($2, $5, $1, 'Nhánh phụ', 'Chứa dấu phần trăm %'),
           ($3, $5, NULL, 'Ẩn cùng cây', NULL), ($4, $5, $3, 'Ẩn trong nhánh', NULL)
  `, [rootFolderId, childFolderId, hiddenFolderId, hiddenChildId, ownerId]);
  const dayStart = '2026-10-10T17:00:00.000Z';
  for (const [id, owner, folder, name, mime, createdAt, description, tags, status = 'ready'] of [
    [documentId, ownerId, childFolderId, 'KẾ HOẠCH.txt', 'text/plain', dayStart, 'Ghi chú bản thử', ['ĐỢT SPRINT']],
    [imageId, ownerId, null, 'Alpha.jpg', 'image/jpeg', dayStart, null, []],
    [audioId, ownerId, null, 'Beta.ogg', 'audio/ogg', '2026-10-11T12:00:00.000Z', null, []],
    [pdfId, ownerId, null, 'PDF mẫu.pdf', 'application/pdf', '2026-10-11T16:59:59.999Z', null, []],
    [videoId, ownerId, null, 'Video.mp4', 'video/mp4', '2026-10-10T16:59:59.999Z', null, []],
    [otherId, ownerId, null, 'Gói.zip', 'application/zip', '2026-10-11T17:00:00.000Z', null, []],
    [hiddenFileId, ownerId, hiddenChildId, 'Ẩn từ cây.txt', 'text/plain', dayStart, null, []],
    [independentId, ownerId, null, 'Ẩn riêng.txt', 'text/plain', dayStart, null, []],
    [pendingId, ownerId, null, 'Ẩn chờ uploads.txt', 'text/plain', dayStart, null, [], 'pending'],
    [viewerFileId, viewerId, null, 'Tệp tài khoản nhận.txt', 'text/plain', dayStart, null, []],
  ] as const) {
    await db.query(`
      INSERT INTO files (id, owner_id, folder_id, original_name, mime_type, size_bytes, object_key, upload_state,
        created_at, updated_at, description, tags)
      VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8, $8, $9, $10)
    `, [id, owner, folder, name, mime, 'files/' + id, status, createdAt, description, tags]);
  }

  const storage: ObjectStorage = {
    async read() { assert.fail('Drive list must read metadata only'); },
    async put() { assert.fail('This fixture will not write objects'); },
    async remove() { assert.fail('Trash and metadata in this fixture will preserve objects'); },
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

  const [owner, viewer] = await Promise.all([signIn('owner@example.test'), signIn('viewer@example.test')]);
  async function listing(path: string, cookie = owner) {
    const response = await request('/drive/' + path, cookie);
    assert.equal(response.status, 200);
    return response.json() as Promise<{
      data: { items: { item: { id: string; createdAt: string }, breadcrumbs: { id: string; name: string }[] }[] },
      pagination: { page: number; limit: number; total: number; totalPages: number },
    }>;
  }
  const searchFor = (q: string, options = '') => listing('search?q=' + encodeURIComponent(q) + options);
  const ids = (result: Awaited<ReturnType<typeof listing>>) => result.data.items.map(({ item }) => item.id);
  const expectedPath = [{ id: rootFolderId, name: 'Dự án' }, { id: childFolderId, name: 'Nhánh phụ' }];

  assert.equal((await request('/drive/search')).status, 401);
  assert.equal((await request('/drive/timeline')).status, 401);
  for (const query of ['q=%00', 'q=' + encodeURIComponent('🙂'.repeat(256)), 'sort=unknown', 'type=file', 'includeMetadata=yes', 'page=0']) {
    assert.equal((await request('/drive/search?' + query, owner)).status, 400);
  }
  assert.equal((await request('/drive/search?q=' + encodeURIComponent('🙂'.repeat(255)), owner)).status, 200);
  for (const query of ['from=2026-02-29', 'from=2026-1-01', 'from=0000-01-01', 'from=2026-10-12&to=2026-10-11', 'type=zip', 'limit=101']) {
    assert.equal((await request('/drive/timeline?' + query, owner)).status, 400);
  }

  assert.equal((await request('/folders/' + hiddenFolderId + '/trash', owner, 'POST')).status, 200);
  assert.equal((await request('/files/' + independentId + '/trash', owner, 'POST')).status, 200);
  assert.equal((await request('/folders/' + rootFolderId + '/shares', owner, 'PUT', { email: 'viewer@example.test' })).status, 200);
  assert.equal((await request('/files/' + documentId, viewer)).status, 200);
  assert.deepEqual(ids(await listing('search', viewer)), [viewerFileId]);
  assert.deepEqual(ids(await listing('timeline', viewer)), [viewerFileId]);
  assert.deepEqual(ids(await searchFor('Ẩn')), []);
  assert.deepEqual(ids(await searchFor('Tệp tài khoản nhận')), []);

  const result = await searchFor(' kế hoạch ', '&type=files');
  assert.deepEqual(ids(result), [documentId]);
  assert.deepEqual(result.data.items[0]?.breadcrumbs, expectedPath);
  assert.deepEqual(ids(await searchFor('kế hoạch', '&type=folders')), []);
  assert.deepEqual(ids(await searchFor('GHI CHÚ')), []);
  assert.deepEqual(ids(await searchFor('GHI CHÚ', '&includeMetadata=true')), [documentId]);
  assert.deepEqual(ids(await searchFor('đợt sprint', '&includeMetadata=true')), [documentId]);
  assert.deepEqual(ids(await searchFor('%')), []);
  const folderResult = await searchFor('%', '&includeMetadata=true&type=folders');
  assert.deepEqual(ids(folderResult), [childFolderId]);
  assert.deepEqual(folderResult.data.items[0]?.breadcrumbs, expectedPath.slice(0, 1));
  const byName = await listing('search?type=files&sort=name&limit=1');
  assert.deepEqual(ids(byName), [imageId]);
  assert.deepEqual(byName.pagination, { page: 1, limit: 1, total: 6, totalPages: 6 });
  const byNew = await listing('search?type=files&sort=newest&limit=1');
  assert.deepEqual(ids(byNew), [otherId]);
  assert.deepEqual(byNew.data.items[0]?.breadcrumbs, []);

  const selectedDay = 'timeline?from=2026-10-11&to=2026-10-11';
  const expectedDayIds = [pdfId, audioId, ...[documentId, imageId].sort()];
  const day = await listing(selectedDay);
  assert.deepEqual(ids(day), expectedDayIds);
  assert.deepEqual(day.data.items.find(({ item }) => item.id === documentId)?.breadcrumbs, expectedPath);
  assert.deepEqual(ids(await listing(selectedDay + '&page=2&limit=2')), expectedDayIds.slice(2));
  assert.deepEqual(ids(await listing(selectedDay + '&page=4&limit=2')), []);
  for (const [type, id] of [['image', imageId], ['video', videoId], ['audio', audioId], ['pdf', pdfId], ['document', documentId], ['other', otherId]]) {
    assert.deepEqual(ids(await listing('timeline?type=' + type)), [id]);
  }
  assert.deepEqual(ids(await listing('timeline?to=2026-10-10')), [videoId]);
  assert.deepEqual(ids(await listing('timeline?from=2026-10-12')), [otherId]);

  assert.equal((await request('/files/' + documentId, owner, 'PATCH', {
    originalName: 'Tên khác.txt', description: 'đổi mô tả', folderId: null,
  })).status, 200);
  const moved = await listing(selectedDay + '&type=document');
  assert.deepEqual(ids(moved), [documentId]);
  assert.equal(moved.data.items[0]?.item.createdAt, dayStart);
  assert.deepEqual(moved.data.items[0]?.breadcrumbs, []);
});
