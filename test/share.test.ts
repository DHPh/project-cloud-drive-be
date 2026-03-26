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
import type { ObjectStorage } from '../src/object-storage';
import { hashPassword } from '../src/session';

const testDatabase = process.env.BACKEND_TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:3000';

test('SHARE-01 limits file reads to active shares and clears grants atomically on trash', {
  skip: !testDatabase,
}, async (t) => {
  const url = testDatabase!;
  const admin = await createDatabase(url).initialize();
  const schema = 'share_test_' + randomBytes(8).toString('hex');
  const schemaOptions = { schema, extra: { options: '-c search_path=' + schema, statement_timeout: 10000 } };
  const legacy = createDatabase(url).setOptions({
    ...schemaOptions, migrations: [Baseline1762214400000, AddFileTrash1763683200000],
  });
  const db = createDatabase(url).setOptions(schemaOptions);
  let server: ReturnType<typeof createServer> | undefined;
  t.after(async () => {
    try {
      const activeServer = server;
      if (activeServer?.listening) {
        await new Promise<void>((resolve) => activeServer.close(() => resolve()));
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
  assert.equal((await legacy.runMigrations()).length, 2);
  const ownerId = randomUUID();
  const recipientId = randomUUID();
  const outsiderId = randomUUID();
  const fileId = randomUUID();
  const anotherFileId = randomUUID();
  const objectKey = 'files/' + fileId;
  const bytes = Buffer.from('Nội dung chia sẻ.\n', 'utf8');
  const password = 'Synthetic share pass!';
  const passwordHash = await hashPassword(password);
  await legacy.query(`
    INSERT INTO users (id, email, name, password_hash, quota_bytes, used_bytes)
    VALUES ($1, 'owner@example.test', 'Test Owner', $4, 200, $5),
           ($2, 'recipient@example.test', 'Test Recipient', $4, 200, 0),
           ($3, 'outsider@example.test', 'Test Outsider', $4, 200, 0)
  `, [ownerId, recipientId, outsiderId, passwordHash, bytes.length + 1]);
  await legacy.query(`
    INSERT INTO files (id, owner_id, original_name, mime_type, size_bytes, object_key, upload_state)
    VALUES ($1, $3, 'Tài liệu.txt', 'text/plain', $4, $5, 'ready'),
           ($2, $3, 'Another fixture.txt', 'text/plain', 1, $6, 'ready')
  `, [fileId, anotherFileId, ownerId, bytes.length, objectKey, 'files/' + anotherFileId]);
  await legacy.destroy();

  await db.initialize();
  assert.deepEqual((await db.runMigrations()).map((migration) => migration.name), [
    'AddFileShares1764201600000',
    'AddFolderSiblingUniqueness1764806400000',
    'AddFolderShares1765152000000',
    'AddFolderTrash1765238400000',
    'AddTrashPurge1765324800000',
    'AddFolderDescription1765411200000',
    'AddAccountAdministration1765497600000',
  ]);
  assert.deepEqual(await db.runMigrations(), []);
  const calendarEnds = await db.query<{ expires_at: Date }[]>(`
    SELECT default_file_share_expiry(instant) AS expires_at
    FROM unnest(ARRAY['2027-01-31T03:00:00Z'::timestamptz, '2028-01-31T03:00:00Z'::timestamptz]) instant
  `);
  assert.deepEqual(calendarEnds.map(({ expires_at }) => expires_at.toISOString()), [
    '2027-02-28T03:00:00.000Z', '2028-02-29T03:00:00.000Z',
  ]);

  let storageReads = 0;
  const storage: ObjectStorage = {
    async read(key) {
      storageReads++;
      assert.equal(key, objectKey);
      return Readable.from([Buffer.from(bytes)]);
    },
    async put() { throw new Error('Sharing should keep the stored object'); },
    async remove() { throw new Error('Sharing should keep the stored object'); },
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

  function send(path: string, method: 'POST' | 'PUT', body: object, cookie?: string) {
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
  const outsider = await signIn('outsider@example.test');
  const file = '/files/' + fileId;
  const shares = file + '/shares';
  const download = file + '/download';
  const inbox = '/shared-with-me';
  const emptyPage = { success: true, data: { items: [] }, pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } };
  async function ownerGrants(query = '') { return json(await request(shares + query, owner), 200); }
  async function received(cookie: string, query = '') { return json(await request(inbox + query, cookie), 200); }
  function revoke(cookie: string) { return request(shares + '/' + recipientId, cookie, { method: 'DELETE' }); }

  assert.deepEqual(await ownerGrants(), emptyPage);
  assert.deepEqual(await received(recipient), emptyPage);
  const { access, ...ownedFile } = (await json(await request(file, owner), 200)).data;
  assert.equal(access, 'owner');
  assert.equal(ownedFile.originalName, 'Tài liệu.txt');
  await json(await request(file), 401);
  await json(await request(file, outsider), 404);
  await json(await request(download, outsider), 404);
  assert.equal(storageReads, 0);
  await json(await request(shares, recipient), 404);
  await json(await send(shares, 'PUT', { email: 'outsider@example.test' }, recipient), 404);
  await json(await revoke(recipient), 404);
  const unknown = await json(await send(shares, 'PUT', { email: 'missing@example.test' }, owner), 404);
  assert.equal(unknown.error.code, 'RECIPIENT_NOT_FOUND');
  await json(await send(shares, 'PUT', { email: 'owner@example.test' }, owner), 400);
  for (const expiresAt of ['date', '2001-01-01T00:00:00Z', '2027-01-01T00:00:00', '0000-01-01T00:00:00Z']) {
    const invalid = await json(await send(shares, 'PUT', { email: 'recipient@example.test', expiresAt }, owner), 400);
    assert.equal(invalid.error.code, 'INVALID_REQUEST');
  }

  const firstGrant = await json(await send(shares, 'PUT', { email: 'RECIPIENT@example.test' }, owner), 200);
  const grant = firstGrant.data;
  assert.equal(grant.recipientId, recipientId);
  assert.equal(grant.recipientEmail, 'recipient@example.test');
  assert.equal(grant.recipientName, 'Test Recipient');
  assert.equal(grant.isActive, true);
  const [defaultExpiry] = await db.query<{ expires_at: Date }[]>(
    'SELECT default_file_share_expiry($1::timestamptz) AS expires_at', [grant.grantedAt]
  );
  assert.equal(grant.expiresAt, defaultExpiry?.expires_at.toISOString());
  assert.deepEqual(
    await json(await send(shares, 'PUT', { email: 'recipient@example.test', expiresAt: null }, owner), 200),
    firstGrant
  );

  assert.deepEqual((await json(await request(file, recipient), 200)).data, { ...ownedFile, access: 'viewer' });
  assert.deepEqual((await received(recipient)).data.items, [{
    ...ownedFile, ownerName: 'Test Owner', sharedAt: grant.grantedAt, expiresAt: grant.expiresAt,
  }]);
  const downloaded = await request(download, recipient);
  assert.equal(downloaded.status, 200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
  await json(await request(file, recipient, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ originalName: 'Denied.txt' }),
  }), 404);

  const [date] = await db.query<{ expires_at: Date }[]>(
    "SELECT date_trunc('milliseconds', statement_timestamp()) + INTERVAL '2 days' AS expires_at"
  );
  assert.ok(date);
  const custom = date.expires_at.toISOString();
  const revised = (await json(await send(shares, 'PUT', { email: 'recipient@example.test', expiresAt: custom }, owner), 200)).data;
  assert.equal(revised.expiresAt, custom);
  assert.equal(revised.grantedAt, grant.grantedAt);
  const outsiderGrant = (await json(await send(shares, 'PUT', { email: 'outsider@example.test' }, owner), 200)).data;
  const anotherGrant = (await json(await send(
    '/files/' + anotherFileId + '/shares', 'PUT', { email: 'recipient@example.test' }, owner
  ), 200)).data;
  const grantsInOrder = [revised, outsiderGrant].sort((left, right) =>
    right.grantedAt.localeCompare(left.grantedAt) || left.recipientId.localeCompare(right.recipientId)
  );
  const sharedInOrder = [{ id: fileId, time: revised.grantedAt }, { id: anotherFileId, time: anotherGrant.grantedAt }]
    .sort((left, right) => right.time.localeCompare(left.time) || left.id.localeCompare(right.id));
  assert.equal((await ownerGrants('?limit=1')).data.items[0].recipientId, grantsInOrder[0].recipientId);
  assert.deepEqual((await ownerGrants('?limit=1&page=2')).pagination, { page: 2, limit: 1, total: 2, totalPages: 2 });
  for (const [index, item] of sharedInOrder.entries()) {
    assert.equal((await received(recipient, '?limit=1&page=' + (index + 1))).data.items[0].id, item.id);
  }

  // Expire at DB time, without waiting on a short wall-clock deadline.
  await db.query(`
    UPDATE file_shares SET granted_at = statement_timestamp() - INTERVAL '1 day', expires_at = statement_timestamp()
    WHERE file_id = $1 AND recipient_id = $2
  `, [fileId, recipientId]);
  assert.equal((await ownerGrants()).data.items.find((item: { recipientId: string }) => item.recipientId === recipientId).isActive, false);
  assert.deepEqual((await received(recipient)).data.items.map((entry: { id: string }) => entry.id), [anotherFileId]);
  await json(await request(file, recipient), 404);
  await json(await request(download, recipient), 404);
  await json(await request(file, outsider), 200);
  const renewed = (await json(await send(shares, 'PUT', { email: 'recipient@example.test' }, owner), 200)).data;
  assert.equal(renewed.isActive, true);
  assert.notEqual(renewed.grantedAt, grant.grantedAt);
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(await json(await revoke(owner), 200), { success: true, data: { revoked: true } });
  }
  await json(await request(file, recipient), 404);
  await json(await request(download, recipient), 404);
  await json(await send(shares, 'PUT', { email: 'recipient@example.test' }, owner), 200);

  // Verify that an error deleting grants rolls back the file's trash operation.
  await db.query(`
    CREATE FUNCTION reject_grant_delete() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Simulated grant deletion failure'; END;
    $$
  `);
  await db.query(`
    CREATE TRIGGER fail_grant_delete BEFORE DELETE ON file_shares FOR EACH ROW
    EXECUTE FUNCTION reject_grant_delete()
  `);
  await json(await request(file + '/trash', owner, { method: 'POST' }), 500);
  await json(await request(file, owner), 200);
  await json(await request(file, recipient), 200);
  assert.equal((await ownerGrants()).pagination.total, 2);
  await db.query('DROP TRIGGER fail_grant_delete ON file_shares');

  const [grantResult, trashResult] = await Promise.all([
    send(shares, 'PUT', { email: 'recipient@example.test' }, owner),
    request(file + '/trash', owner, { method: 'POST' }),
  ]);
  assert.ok([200, 404].includes(grantResult.status));
  await json(trashResult, 200);
  await json(await request(file, owner), 404);
  await json(await request(shares, owner), 404);
  await json(await send(shares, 'PUT', { email: 'recipient@example.test' }, owner), 404);
  assert.deepEqual(await received(outsider), emptyPage);
  await json(await request(file + '/restore', owner, { method: 'POST' }), 200);
  assert.deepEqual(await ownerGrants(), emptyPage);
  assert.deepEqual((await json(await request(file, owner), 200)).data, { ...ownedFile, access: 'owner' });
  for (const formerRecipient of [recipient, outsider]) {
    await json(await request(file, formerRecipient), 404);
    await json(await request(download, formerRecipient), 404);
  }
  const restored = await request(download, owner);
  assert.equal(restored.status, 200);
  assert.deepEqual(Buffer.from(await restored.arrayBuffer()), bytes);
  assert.equal(storageReads, 2);
});
