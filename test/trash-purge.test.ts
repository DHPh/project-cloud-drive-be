import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import test, { type TestContext } from 'node:test';
import { createApp } from '../src/app';
import { appConfig } from '../src/config';
import { createDatabase } from '../src/database';
import { withFileObjectLock } from '../src/files';
import { AddTrashPurge1765324800000 } from '../src/migrations/1765324800000-AddTrashPurge';
import type { ObjectStorage } from '../src/object-storage';
import { hashPassword } from '../src/session';
import { createTrashPurge } from '../src/trash-purge';

const databaseUrl = process.env.BACKEND_TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:3000';
const day = 86_400_000;
const password = 'Synthetic permanent Trash test!';
const fileKey = (id: string) => 'fixtures/' + id;

type TrashKind = 'file' | 'folder';
type TrashItem = { id: string; kind: TrashKind; trashEventId: string; deleteAfter: string | null; purgeStatus: string };
type TrashSummary = { remainingBytes: number; recoverableCount: number; purgingCount: number; retryingCount: number };

async function createFixture(t: TestContext) {
  const admin = await createDatabase(databaseUrl!).initialize();
  const schema = 'trash_purge_test_' + randomBytes(8).toString('hex');
  const options = { schema, extra: { options: '-c search_path=' + schema, statement_timeout: 10000 } };
  const db = createDatabase(databaseUrl!).setOptions(options);
  const migrations = db.options.migrations;
  assert.ok(Array.isArray(migrations));
  const legacy = createDatabase(databaseUrl!).setOptions({ ...options, migrations: migrations.slice(0, 6) });
  let server: ReturnType<typeof createServer> | undefined;
  t.after(async () => {
    try {
      if (server?.listening) {
        const running = server;
        await new Promise<void>((resolve) => running.close(() => resolve()));
      }
      if (legacy.isInitialized) await legacy.destroy();
      if (db.isInitialized) await db.destroy();
      await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    } finally {
      await admin.destroy();
    }
  });
  await admin.query('CREATE SCHEMA ' + schema);
  await legacy.initialize();
  assert.equal((await legacy.runMigrations()).length, 6);
  const ownerId = randomUUID();
  const otherId = randomUUID();
  await legacy.query(`
    INSERT INTO users (id, email, name, password_hash, quota_bytes)
    VALUES ($1, 'owner@example.test', 'Owner', $3, 1000000),
           ($2, 'other@example.test', 'Other', $3, 1000000)
  `, [ownerId, otherId, await hashPassword(password)]);

  const objects = new Map<string, Buffer>();
  const removeAttempts = new Map<string, number>();
  const failing = new Set<string>();
  const storage: ObjectStorage = {
    async put(key, bytes) { objects.set(key, Buffer.from(bytes)); },
    async read(key) {
      const bytes = objects.get(key);
      assert.ok(bytes, 'Fixture object exists');
      return Readable.from([bytes]);
    },
    async remove(key) {
      removeAttempts.set(key, (removeAttempts.get(key) ?? 0) + 1);
      if (failing.has(key)) throw new Error('Synthetic storage failure');
      objects.delete(key);
    },
  };

  async function folder(name: string, parentId: string | null = null) {
    const id = randomUUID();
    const connection = db.isInitialized ? db : legacy;
    await connection.query('INSERT INTO folders (id, owner_id, parent_id, name) VALUES ($1, $2, $3, $4)', [id, ownerId, parentId, name]);
    return id;
  }

  async function file(name: string, size: number, folderId: string | null = null, userId = ownerId, trashedAt: Date | null = null) {
    const id = randomUUID();
    const connection = db.isInitialized ? db : legacy;
    await connection.transaction(async (manager) => {
      await manager.query(`
        INSERT INTO files (id, owner_id, folder_id, original_name, mime_type, size_bytes, object_key, upload_state, trashed_at)
        VALUES ($1, $2, $3, $4, 'text/plain', $5, $6, 'ready', $7)
      `, [id, userId, folderId, name, size, fileKey(id), trashedAt]);
      await manager.query('UPDATE users SET used_bytes = used_bytes + $2 WHERE id = $1', [userId, size]);
    });
    objects.set(fileKey(id), Buffer.alloc(size, 'x'));
    return id;
  }

  async function quota(userId = ownerId) {
    const [user] = await db.query<{ used_bytes: string }[]>('SELECT used_bytes FROM users WHERE id = $1', [userId]);
    assert.ok(user);
    return Number(user.used_bytes);
  }

  async function start() {
    await legacy.destroy();
    await db.initialize();
    assert.deepEqual((await db.runMigrations()).map((migration) => migration.name), [
      'AddTrashPurge1765324800000', 'AddFolderDescription1765411200000',
      'AddAccountAdministration1765497600000',
      'AddEditorGrants1765584000000',
      'AddPublicBoards1765670400000',
    ]);
    assert.deepEqual(await db.runMigrations(), []);
    server = createServer(createApp(db, storage, appConfig({ APP_ORIGIN: origin })));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const baseUrl = 'http://127.0.0.1:' + address.port + '/api/v1';

    async function request(path: string, method = 'GET', cookie?: string, body?: object, requestOrigin = origin) {
      const headers = new Headers({ Origin: requestOrigin });
      if (cookie) headers.set('Cookie', cookie);
      if (body) headers.set('Content-Type', 'application/json');
      const response = await fetch(baseUrl + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
      assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
      return response;
    }

    async function signIn(email: string) {
      const response = await request('/auth/login', 'POST', undefined, { email, password });
      assert.equal(response.status, 200);
      const cookie = response.headers.get('Set-Cookie')?.split(';')[0];
      assert.ok(cookie);
      return cookie;
    }
    const owner = await signIn('owner@example.test');
    const other = await signIn('other@example.test');
    const get = (path: string, cookie = owner) => request(path, 'GET', cookie);
    const post = (path: string, body?: object, cookie = owner, requestOrigin = origin) => request(path, 'POST', cookie, body, requestOrigin);
    const action = (kind: TrashKind, id: string, verb: 'trash' | 'restore', trashEventId?: string) =>
      post('/' + kind + 's/' + id + '/' + verb, trashEventId ? { trashEventId } : undefined);
    async function trashList(cookie = owner, options = 'includeFolders=true&limit=100') {
      const response = await get('/trash?' + options, cookie);
      assert.equal(response.status, 200);
      return (await response.json()).data as { items: TrashItem[]; summary: TrashSummary };
    }
    async function entry(id: string) {
      const item = (await trashList()).items.find((candidate) => candidate.id === id);
      assert.ok(item, 'Expected one Trash entry for ' + id);
      return item;
    }
    const purge = (item: TrashItem, cookie = owner) =>
      post('/trash/' + item.kind + '/' + item.id + '/purge', { trashEventId: item.trashEventId }, cookie);
    return { action, request, get, post, trashList, entry, purge, owner, other };
  }

  return { db, ownerId, otherId, folder, file, quota, objects, removeAttempts, failing, storage, start };
}

async function expectAccepted(response: Response, acceptedCount: number) {
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { success: true, data: { acceptedCount } });
}

async function expectConflict(response: Response, code: string) {
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, code);
}

test('TRASH-03 purges only a single tree event, resumes partial deletion and releases quota once', {
  skip: !databaseUrl,
}, async (t) => {
  const fixture = await createFixture(t);
  const { db, objects, failing, removeAttempts, quota } = fixture;
  const parent = await fixture.folder('Dự án');
  const nested = await fixture.folder('Tài liệu', parent);
  const independentFolder = await fixture.folder('Thư mục xóa riêng', nested);
  const first = await fixture.file('A.txt', 11, parent);
  const second = await fixture.file('B.txt', 23, nested);
  const independent = await fixture.file('C.txt', 37, nested);
  const childContent = await fixture.file('D.txt', 41, independentFolder);
  const api = await fixture.start();
  const worker = createTrashPurge(db, fixture.storage);
  await worker.activateRetention();

  assert.equal((await api.action('file', independent, 'trash')).status, 200);
  assert.equal((await api.action('folder', independentFolder, 'trash')).status, 200);
  assert.equal((await api.action('folder', parent, 'trash')).status, 200);
  const entry = await api.entry(parent);
  const items = await api.trashList();
  assert.deepEqual(new Set(items.items.map((item) => item.id)), new Set([parent, independent, independentFolder]));
  assert.deepEqual(items.summary, { remainingBytes: 112, recoverableCount: 3, purgingCount: 0, retryingCount: 0 });
  assert.equal((await api.purge(entry, api.other)).status, 404);
  assert.equal((await api.post('/trash/folder/' + parent + '/purge', { trashEventId: entry.trashEventId }, api.owner, 'http://127.0.0.1:9999')).status, 403);
  await expectAccepted(await api.purge(entry), 1);
  await assert.rejects(db.transaction((manager) => new AddTrashPurge1765324800000().down(manager.queryRunner!)),
    /Complete queued Trash purges/);
  await expectConflict(await api.action('folder', parent, 'restore', entry.trashEventId), 'DELETE_IN_PROGRESS');
  assert.equal(await quota(), 112);
  assert.equal((await api.entry(parent)).purgeStatus, 'purging');

  failing.add(fileKey(second));
  await worker.processQueue(new Date(Date.now() + 60_000));
  assert.equal(objects.has(fileKey(first)), false);
  assert.equal(objects.has(fileKey(second)), true);
  assert.equal(await quota(), 101);
  assert.equal((await api.entry(parent)).purgeStatus, 'retrying');
  assert.deepEqual((await api.trashList()).summary, {
    remainingBytes: 101, recoverableCount: 2, purgingCount: 0, retryingCount: 1,
  });

  failing.delete(fileKey(second));
  await db.query(`
    CREATE FUNCTION reject_purge_ack() RETURNS trigger LANGUAGE plpgsql AS $body$
    BEGIN
      IF OLD.id = '${second}' THEN RAISE EXCEPTION 'Synthetic quota transaction interruption'; END IF;
      RETURN OLD;
    END
    $body$
  `);
  await db.query('CREATE TRIGGER reject_purge_ack BEFORE DELETE ON files FOR EACH ROW EXECUTE FUNCTION reject_purge_ack()');
  await worker.processQueue(new Date(Date.now() + day));
  assert.equal(objects.has(fileKey(second)), false);
  assert.equal(await quota(), 101, 'A storage success alone does not release quota');
  await db.query('DROP TRIGGER reject_purge_ack ON files');
  await db.query('DROP FUNCTION reject_purge_ack()');

  const restarted = createTrashPurge(db, fixture.storage);
  const retryTime = new Date(Date.now() + 2 * day);
  await Promise.all([worker.processQueue(retryTime), restarted.processQueue(retryTime)]);
  await restarted.processQueue(retryTime);
  assert.equal(await quota(), 78);
  assert.equal(removeAttempts.get(fileKey(first)), 1);
  assert.equal(removeAttempts.get(fileKey(second)), 3);
  assert.equal(objects.has(fileKey(independent)), true);
  assert.equal(objects.has(fileKey(childContent)), true);
  assert.deepEqual(await db.query('SELECT id FROM folders WHERE id = ANY($1::uuid[])', [[parent, nested]]), []);
  assert.deepEqual((await api.trashList()).summary, {
    remainingBytes: 78, recoverableCount: 2, purgingCount: 0, retryingCount: 0,
  });
  await expectAccepted(await api.purge(entry), 1);
  const restoreFile = await api.action('file', independent, 'restore', (await api.entry(independent)).trashEventId);
  const restoreFolder = await api.action('folder', independentFolder, 'restore', (await api.entry(independentFolder)).trashEventId);
  assert.equal(restoreFile.status, 200);
  assert.equal(restoreFolder.status, 200);
  assert.equal((await restoreFile.json()).data.folderId, null);
  assert.equal((await restoreFolder.json()).data.parentId, null);
  const download = await api.get('/files/' + childContent + '/download');
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), Buffer.alloc(41, 'x'));
});

test('TRASH-03 honors activation grace, current event identity and idempotent Empty Trash scope', {
  skip: !databaseUrl,
}, async (t) => {
  const fixture = await createFixture(t);
  const activation = new Date(Date.now() - 60_000);
  const beforeRelease = new Date(activation.getTime() - 45 * day);
  const legacyFile = await fixture.file('Tệp trước khi bật tự dọn.txt', 17, null, fixture.ownerId, beforeRelease);
  const ownerFile = await fixture.file('Phạm vi xác nhận.txt', 23);
  const emptyFolder = await fixture.folder('Thư mục trong lần dọn');
  const laterFile = await fixture.file('Mục đến sau.txt', 31);
  const racedFile = await fixture.file('Xóa đồng thời.txt', 7);
  const otherFile = await fixture.file('Tài khoản khác.txt', 41, null, fixture.otherId, beforeRelease);
  const api = await fixture.start();
  const worker = createTrashPurge(fixture.db, fixture.storage);
  assert.equal((await api.entry(legacyFile)).deleteAfter, null);
  await worker.activateRetention(activation);
  await worker.activateRetention(new Date(activation.getTime() + day));
  const graceEnd = new Date(activation.getTime() + 30 * day);
  assert.equal((await api.entry(legacyFile)).deleteAfter, graceEnd.toISOString());
  assert.equal((await api.action('file', ownerFile, 'trash')).status, 200);
  const originalEvent = await api.entry(ownerFile);
  assert.ok(Date.parse(originalEvent.deleteAfter!) > graceEnd.getTime());
  await worker.reserveExpired(new Date(graceEnd.getTime() - 1));
  assert.equal((await api.entry(legacyFile)).purgeStatus, 'available');
  await worker.reserveExpired(graceEnd);
  assert.equal((await api.entry(legacyFile)).purgeStatus, 'purging');
  assert.equal((await api.entry(ownerFile)).purgeStatus, 'available');
  await worker.processQueue(graceEnd);
  assert.equal(fixture.objects.has(fileKey(legacyFile)), false);
  assert.equal(fixture.objects.has(fileKey(otherFile)), false, 'automatic retention applied to the other owner\'s separate due event');
  assert.equal(await fixture.quota(fixture.otherId), 0);

  assert.equal((await api.action('file', ownerFile, 'restore', originalEvent.trashEventId)).status, 200);
  assert.equal((await api.action('file', ownerFile, 'trash')).status, 200);
  const currentEvent = await api.entry(ownerFile);
  assert.notEqual(currentEvent.trashEventId, originalEvent.trashEventId);
  await expectConflict(await api.purge(originalEvent), 'STALE_TRASH_EVENT');
  await expectConflict(await api.action('file', ownerFile, 'restore', originalEvent.trashEventId), 'STALE_TRASH_EVENT');
  assert.equal((await api.action('folder', emptyFolder, 'trash')).status, 200);
  const batch = { requestId: randomUUID() };
  await expectAccepted(await api.post('/trash/empty', batch), 2);
  assert.equal((await api.action('file', laterFile, 'trash')).status, 200);
  await expectAccepted(await api.post('/trash/empty', batch), 2);
  assert.equal((await api.entry(laterFile)).purgeStatus, 'available');
  await worker.processQueue(new Date(Date.now() + 60_000));
  assert.equal(await fixture.quota(), 38);
  assert.equal(fixture.objects.has(fileKey(ownerFile)), false);
  assert.equal(fixture.objects.has(fileKey(laterFile)), true);
  assert.equal((await api.trashList()).items.some((item) => item.id === emptyFolder), false);
  await expectAccepted(await api.post('/trash/empty', batch), 2);

  assert.equal((await api.action('file', racedFile, 'trash')).status, 200);
  const racedEvent = await api.entry(racedFile);
  const [restore, purge] = await Promise.all([
    api.action('file', racedFile, 'restore', racedEvent.trashEventId),
    api.purge(racedEvent),
  ]);
  if (restore.status === 200) {
    await expectConflict(purge, 'STALE_TRASH_EVENT');
    assert.equal((await api.get('/files/' + racedFile)).status, 200);
  } else {
    await expectConflict(restore, 'DELETE_IN_PROGRESS');
    await expectAccepted(purge, 1);
  }
});

test('TRASH-03 waits for an in-flight upload and resumes a failed folder finalization', {
  skip: !databaseUrl,
}, async (t) => {
  const fixture = await createFixture(t);
  const folderId = await fixture.folder('Upload đang diễn ra');
  const unrelated = await fixture.folder('Mục xử lý độc lập');
  const fileId = await fixture.file('Đang lưu.txt', 13, folderId);
  const api = await fixture.start();
  const worker = createTrashPurge(fixture.db, fixture.storage);
  await fixture.db.query("UPDATE files SET upload_state = 'pending' WHERE id = $1", [fileId]);
  const firstPassTime = new Date(Date.now() + 60_000);

  await withFileObjectLock(fixture.db, fileId, true, async (runner) => {
    assert.equal((await api.action('folder', folderId, 'trash')).status, 200);
    assert.equal((await api.action('folder', unrelated, 'trash')).status, 200);
    await expectAccepted(await api.purge(await api.entry(folderId)), 1);
    await expectAccepted(await api.purge(await api.entry(unrelated)), 1);
    await worker.processQueue(firstPassTime);
    assert.equal(fixture.objects.has(fileKey(fileId)), true);
    assert.equal(await fixture.quota(), 13);
    assert.equal((await api.entry(folderId)).purgeStatus, 'purging');
    assert.equal((await api.trashList()).items.some((item) => item.id === unrelated), false);
    await runner.query("UPDATE files SET upload_state = 'ready' WHERE id = $1", [fileId]);
  });

  await fixture.db.query(`
    CREATE FUNCTION reject_trash_folder_finalization() RETURNS trigger LANGUAGE plpgsql AS $body$
    BEGIN
      IF OLD.id = '${folderId}' THEN RAISE EXCEPTION 'Synthetic folder finalization failure'; END IF;
      RETURN OLD;
    END
    $body$
  `);
  await fixture.db.query('CREATE TRIGGER reject_trash_folder_finalization BEFORE DELETE ON folders FOR EACH ROW EXECUTE FUNCTION reject_trash_folder_finalization()');
  await worker.processQueue(firstPassTime);
  assert.equal(fixture.objects.has(fileKey(fileId)), false);
  assert.equal(await fixture.quota(), 0);
  assert.equal((await api.entry(folderId)).purgeStatus, 'retrying');
  await fixture.db.query('DROP TRIGGER reject_trash_folder_finalization ON folders');
  await fixture.db.query('DROP FUNCTION reject_trash_folder_finalization()');
  await createTrashPurge(fixture.db, fixture.storage).processQueue(new Date(firstPassTime.getTime() + day));
  assert.equal((await api.trashList()).items.length, 0);
  assert.equal(await fixture.quota(), 0);
  assert.equal(fixture.removeAttempts.get(fileKey(fileId)), 1);
});
