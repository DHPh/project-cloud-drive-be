import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import test from 'node:test';
import { bootstrapAdmin } from '../src/admin';
import { createApp } from '../src/app';
import { appConfig } from '../src/config';
import { createDatabase } from '../src/database';
import { AddAccountAdministration1765497600000 } from '../src/migrations/1765497600000-AddAccountAdministration';
import type { ObjectStorage } from '../src/object-storage';
import { hashPassword, tokenHash } from '../src/session';

const databaseUrl = process.env.BACKEND_TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:3000';

test('ACCOUNT-01 and ADMIN-01 preserve existing accounts and enforce one-time links, sessions, quota and owner visibility', {
  skip: !databaseUrl,
}, async (t) => {
  const adminDb = await createDatabase(databaseUrl!).initialize();
  const schema = 'accounts_test_' + randomBytes(8).toString('hex');
  const options = { schema, extra: { options: '-c search_path=' + schema, statement_timeout: 10000 } };
  const db = createDatabase(databaseUrl!).setOptions(options);
  const migrations = db.options.migrations;
  assert.ok(Array.isArray(migrations));
  const legacy = createDatabase(databaseUrl!).setOptions({ ...options, migrations: migrations.slice(0, 8) });
  let server: ReturnType<typeof createServer> | undefined;
  t.after(async () => {
    try {
      const running = server;
      if (running?.listening) await new Promise<void>((resolve) => running.close(() => resolve()));
      if (legacy.isInitialized) await legacy.destroy();
      if (db.isInitialized) await db.destroy();
      await adminDb.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    } finally {
      await adminDb.destroy();
    }
  });

  await adminDb.query('CREATE SCHEMA ' + schema);
  await legacy.initialize();
  assert.equal((await legacy.runMigrations()).length, 8);
  const ownerId = randomUUID();
  const folderId = randomUUID();
  const activeFileId = randomUUID();
  const trashedFileId = randomUUID();
  const ownerEmail = 'owner@example.test';
  const memberEmail = 'member@example.test';
  const adminEmail = 'operator@example.test';
  const password = 'First synthetic password!';
  const changedPassword = 'Changed synthetic password!';
  const resetPassword = 'Reset synthetic password!';
  const bytes = Buffer.from('Synthetic file for account suspension.');
  const activeKey = 'files/' + activeFileId;
  const historicalToken = randomBytes(32).toString('base64url');
  const owner = `cloud_drive_session=${historicalToken}`;
  const usedBytes = bytes.byteLength + 5;
  await legacy.query(`INSERT INTO users (id, email, name, password_hash, used_bytes, quota_bytes)
    VALUES ($1, $2, 'Old owner', $3, $4, 1000)`, [ownerId, ownerEmail, await hashPassword(password), usedBytes]);
  await legacy.query(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + INTERVAL '1 day')`,
    [tokenHash(historicalToken), ownerId]);
  await legacy.query(`INSERT INTO folders (id, owner_id, name) VALUES ($1, $2, 'Fixture folder')`, [folderId, ownerId]);
  await legacy.query(`
    INSERT INTO files (id, owner_id, folder_id, original_name, mime_type, size_bytes, object_key, upload_state,
      trashed_at, trash_event_id)
    VALUES ($1, $3, $4, 'Active fixture.txt', 'text/plain', $5, $6, 'ready', NULL, NULL),
           ($2, $3, NULL, 'Trashed fixture.txt', 'text/plain', 5, $7, 'ready', now(), gen_random_uuid())
  `, [activeFileId, trashedFileId, ownerId, folderId, bytes.byteLength, activeKey, 'files/' + trashedFileId]);
  await legacy.destroy();

  await db.initialize();
  assert.ok((await db.runMigrations()).some((migration) => migration.name === 'AddAccountAdministration1765497600000'));
  assert.deepEqual(await db.runMigrations(), []);
  const operator = await bootstrapAdmin(db, { email: adminEmail, name: 'Operator', password });
  assert.equal(operator.role, 'admin');
  await assert.rejects(bootstrapAdmin(db, { email: 'second@example.test', name: 'Second', password }), { code: 'ADMIN_ALREADY_EXISTS' });

  const storage: ObjectStorage = {
    async read(key) { assert.equal(key, activeKey); return Readable.from([bytes]); },
    async put() { assert.fail('Account changes must preserve upload data'); },
    async remove() { assert.fail('Account changes must preserve upload data'); },
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

  async function signIn(email: string, secret = password) {
    const response = await request('/auth/login', undefined, 'POST', { email, password: secret });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('Set-Cookie')?.split(';')[0];
    assert.ok(cookie);
    return cookie;
  }

  async function data(response: Response, status = 200) {
    assert.equal(response.status, status);
    return (await response.json()).data;
  }

  async function errorCode(response: Response, status: number, code: string) {
    assert.equal(response.status, status);
    assert.equal((await response.json()).error.code, code);
  }

  const admin = await signIn(adminEmail);
  assert.deepEqual(await data(await request('/account', owner)), {
    user: { id: ownerId, email: ownerEmail, name: 'Old owner', role: 'user' },
    storage: { usedBytes, trashedBytes: 5, quotaBytes: 1000 },
  });
  assert.equal((await data(await request('/auth/me', admin))).role, 'admin');
  await errorCode(await request('/admin/users', owner), 403, 'FORBIDDEN');
  await errorCode(await request('/admin/invites', owner, 'POST', { email: memberEmail }), 403, 'FORBIDDEN');
  await errorCode(await request('/admin/audit'), 401, 'SESSION_REQUIRED');
  await errorCode(await request('/admin/users/' + operator.id, admin, 'PATCH', { disabled: true }), 409, 'LAST_ACTIVE_ADMIN');
  await errorCode(await request('/admin/users/' + operator.id, admin, 'PATCH', { role: 'user' }), 409, 'LAST_ACTIVE_ADMIN');
  await errorCode(await request('/admin/users/' + ownerId, admin, 'PATCH', { quotaBytes: usedBytes - 1 }), 409, 'QUOTA_BELOW_USAGE');
  assert.equal((await data(await request('/admin/users/' + ownerId, admin, 'PATCH', { quotaBytes: usedBytes }))).quotaBytes, usedBytes);

  const issueInvite = async (email: string) => data(await request('/admin/invites', admin, 'POST', { email }), 201);
  const invite = await issueInvite(memberEmail.toUpperCase());
  const replacement = await issueInvite(memberEmail);
  const accept = (token: string, secret = password) => request('/auth/accept-invite', undefined, 'POST', {
    token, password: secret, name: 'Người được mời',
  });
  assert.equal(replacement.invite.email, memberEmail);
  assert.equal(Date.parse(replacement.invite.expiresAt) - Date.parse(replacement.invite.createdAt), 24 * 3600_000);
  await errorCode(await accept(invite.token), 409, 'ACCOUNT_LINK_REVOKED');
  await errorCode(await accept(replacement.token, 'short'), 400, 'INVALID_REQUEST');
  await errorCode(await accept(randomBytes(32).toString('base64url')), 404, 'ACCOUNT_LINK_NOT_FOUND');
  const results = await Promise.all([accept(replacement.token), accept(replacement.token)]);
  assert.deepEqual(results.map((response) => response.status).sort(), [201, 409]);
  const accepted = results.find((response) => response.status === 201);
  assert.ok(accepted);
  assert.equal(accepted.headers.has('Set-Cookie'), false);
  const member = await data(accepted, 201);
  assert.equal(member.role, 'user');
  assert.equal(member.email, memberEmail);
  await errorCode(await accept(replacement.token), 409, 'ACCOUNT_LINK_USED');
  await errorCode(await request('/admin/invites', admin, 'POST', { email: memberEmail }), 409, 'ACCOUNT_EMAIL_CONFLICT');
  const expired = await issueInvite('expired@example.test');
  await db.query(`UPDATE account_links SET created_at = now() - INTERVAL '2 days', expires_at = now() - INTERVAL '1 day' WHERE id = $1`,
    [expired.invite.id]);
  await errorCode(await accept(expired.token), 410, 'ACCOUNT_LINK_EXPIRED');
  const unused = await issueInvite('unused@example.test');
  for (let repeat = 0; repeat < 2; repeat++) {
    assert.deepEqual(await data(await request('/admin/invites/' + unused.invite.id, admin, 'DELETE')), { revoked: true });
  }
  await errorCode(await accept(unused.token), 409, 'ACCOUNT_LINK_REVOKED');
  const statusList = await data(await request('/admin/invites?status=used&limit=1', admin));
  assert.deepEqual(statusList.items.map((item: { email: string }) => item.email), [memberEmail]);
  assert.equal(JSON.stringify(statusList).includes(replacement.token), false);

  const [memberSession, otherSession] = await Promise.all([signIn(memberEmail), signIn(memberEmail)]);
  const profile = await data(await request('/account', memberSession, 'PATCH', { name: '  Tên mới 🙂  ' }));
  assert.equal(profile.user.name, 'Tên mới 🙂');
  assert.deepEqual(profile.storage, { usedBytes: 0, trashedBytes: 0, quotaBytes: 1073741824 });
  const userList = await data(await request('/admin/users?q=' + encodeURIComponent('TÊN MỚI'), admin));
  assert.deepEqual(userList.items.map((item: { id: string }) => item.id), [member.id]);
  await errorCode(await request('/account/password', memberSession, 'POST', {
    currentPassword: 'wrong password', password: changedPassword,
  }), 403, 'CURRENT_PASSWORD_INVALID');
  const changed = await request('/account/password', memberSession, 'POST', { currentPassword: password, password: changedPassword });
  assert.match(changed.headers.get('Set-Cookie') ?? '', /cloud_drive_session=;/);
  assert.deepEqual(await data(changed), { passwordChanged: true });
  for (const cookie of [memberSession, otherSession]) await errorCode(await request('/auth/me', cookie), 401, 'SESSION_REQUIRED');
  const changedSession = await signIn(memberEmail, changedPassword);
  const resetPath = '/admin/users/' + member.id + '/reset-password';
  const oldReset = await data(await request(resetPath, admin, 'POST'), 201);
  const currentReset = await data(await request(resetPath, admin, 'POST'), 201);
  const reset = (token: string) => request('/auth/reset-password', undefined, 'POST', { token, password: resetPassword });
  await errorCode(await reset(oldReset.token), 409, 'ACCOUNT_LINK_REVOKED');
  assert.deepEqual(await data(await reset(currentReset.token)), { passwordChanged: true });
  await errorCode(await reset(currentReset.token), 409, 'ACCOUNT_LINK_USED');
  await errorCode(await request('/auth/me', changedSession), 401, 'SESSION_REQUIRED');
  const viewer = await signIn(memberEmail, resetPassword);

  const file = '/files/' + activeFileId;
  const folder = '/folders/' + folderId;
  assert.equal((await request(file, admin)).status, 404);
  for (const path of [file, folder]) assert.equal((await request(path + '/shares', owner, 'PUT', { email: memberEmail })).status, 200);
  const sharedPaths = [file, file + '/download', file + '/preview', folder + '/contents', folder + '/download'];
  for (const path of sharedPaths) assert.equal((await request(path, viewer)).status, 200);
  const ownerPath = '/admin/users/' + ownerId;
  assert.equal((await data(await request(ownerPath, admin, 'PATCH', { disabled: true }))).disabled, true);
  assert.equal((await data(await request(ownerPath, admin, 'PATCH', { disabled: true }))).disabled, true);
  await errorCode(await request('/auth/me', owner), 401, 'SESSION_REQUIRED');
  await errorCode(await request('/auth/login', undefined, 'POST', { email: ownerEmail, password }), 401, 'INVALID_CREDENTIALS');
  for (const path of sharedPaths) assert.equal((await request(path, viewer)).status, 404);
  for (const path of ['/shared-with-me', '/shared-folders']) assert.deepEqual((await data(await request(path, viewer))).items, []);
  await assert.rejects(db.transaction((manager) => new AddAccountAdministration1765497600000().down(manager.queryRunner!)),
    /compatible snapshot/);
  assert.equal((await data(await request(ownerPath, admin, 'PATCH', { disabled: false }))).disabled, false);
  await errorCode(await request('/auth/me', owner), 401, 'SESSION_REQUIRED');
  const returnedOwner = await signIn(ownerEmail);
  assert.equal((await request(file, viewer)).status, 200);
  assert.equal((await data(await request('/account', returnedOwner))).storage.usedBytes, usedBytes);
  const audit = await data(await request('/admin/audit?limit=100', admin));
  const actions = audit.items.map((entry: { action: string }) => entry.action);
  assert.equal(actions.filter((action: string) => action === 'account_disabled').length, 1);
  assert.ok(actions.includes('invite_created') && actions.includes('password_reset_completed') && actions.includes('account_quota_changed'));
  assert.equal(JSON.stringify(audit).includes(currentReset.token), false);

  const memberPath = '/admin/users/' + member.id;
  assert.equal((await data(await request(memberPath, admin, 'PATCH', { role: 'admin' }))).role, 'admin');
  await errorCode(await request('/auth/me', viewer), 401, 'SESSION_REQUIRED');
  const secondAdmin = await signIn(memberEmail, resetPassword);
  const simultaneous = await Promise.all([
    request('/admin/users/' + operator.id, admin, 'PATCH', { disabled: true }),
    request(memberPath, secondAdmin, 'PATCH', { disabled: true }),
  ]);
  assert.deepEqual(simultaneous.map((response) => response.status).sort(), [200, 409]);
  const surviving = await db.query<{ id: string }[]>("SELECT id FROM users WHERE role = 'admin' AND disabled_at IS NULL");
  assert.equal(surviving.length, 1);
});
