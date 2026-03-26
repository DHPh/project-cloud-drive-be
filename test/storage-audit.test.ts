import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { createDatabase } from '../src/database';
import type { InventoryObject, ObjectInventory } from '../src/object-storage';
import { auditStorage } from '../src/storage-audit';

const testDatabase = process.env.BACKEND_TEST_DATABASE_URL;
const orphanGraceMs = 300_000;
const oldObjectDate = new Date('2000-01-01T00:00:00Z');
const recentObjectDate = new Date('9999-01-01T00:00:00Z');

async function isolatedDatabase(t: TestContext) {
  const url = testDatabase!;
  const schema = 'storage_audit_test_' + randomBytes(8).toString('hex');
  const admin = await createDatabase(url).initialize();
  const db = createDatabase(url).setOptions({ schema, extra: { options: '-c search_path=' + schema, statement_timeout: 10000 } });
  t.after(async () => {
    try {
      if (db.isInitialized) await db.destroy();
      await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    } finally {
      await admin.destroy();
    }
  });
  await admin.query('CREATE SCHEMA ' + schema);
  await db.initialize();
  await db.runMigrations();
  return db;
}

function fakeInventory(...pages: InventoryObject[][]): ObjectInventory {
  return {
    async *listObjectPages(prefix, pageSize) {
      assert.equal(prefix, 'files/');
      assert.equal(pageSize, 1000);
      yield* pages;
    },
  };
}

test('OPS-01 audits ownership records, transitional objects and charged quota without changing either store', {
  skip: !testDatabase,
}, async (t) => {
  const db = await isolatedDatabase(t);
  const ownerId = randomUUID();
  const otherOwnerId = randomUUID();
  const purgeEvent = randomUUID();
  await db.query(`
    INSERT INTO users (id, email, name, password_hash, quota_bytes, used_bytes)
    VALUES ($1, 'private-audit@example.test', 'Private fixture owner', 'mock password', 1000, 62),
           ($2, 'second@example.test', 'Other fixture owner', 'mock password', 9007199254740999, 9007199254740993)
  `, [ownerId, otherOwnerId]);

  const files = [
    { key: 'files/01-ready', state: 'ready', bytes: 4, mode: 'active' },
    { key: 'files/02-missing-trashed', state: 'ready', bytes: 5, mode: 'trashed' },
    { key: 'files/03-pending', state: 'pending', bytes: 3, mode: 'active' },
    { key: 'files/04-pending-absent', state: 'pending', bytes: 2, mode: 'active' },
    { key: 'files/05-cleanup', state: 'cleanup', bytes: 7, mode: 'active' },
    { key: 'files/06-cleanup-absent', state: 'cleanup', bytes: 1, mode: 'active' },
    { key: 'files/07-purge', state: 'ready', bytes: 11, mode: 'purge' },
    { key: 'files/08-purge-absent', state: 'ready', bytes: 13, mode: 'purge' },
    { key: 'outside/private-legacy', state: 'ready', bytes: 17, mode: 'active' },
  ];
  await db.query(`
    INSERT INTO trash_purge_jobs (trash_event_id, owner_id, item_kind, item_id)
    VALUES ($1, $2, 'folder', $3)
  `, [purgeEvent, ownerId, randomUUID()]);
  for (const file of files) {
    const fileId = randomUUID();
    await db.query(`
      INSERT INTO files (id, owner_id, original_name, mime_type, size_bytes, object_key, upload_state, trashed_at, trash_event_id)
      VALUES ($1, $2, 'Private fixture name', 'text/plain', $3, $4, $5,
        CASE WHEN $6::uuid IS NULL THEN NULL ELSE statement_timestamp() END, $6)
    `, [fileId, ownerId, file.bytes, file.key, file.state, file.mode === 'trashed' ? randomUUID() : null]);
    if (file.mode === 'purge') {
      await db.query('INSERT INTO trash_purge_files (file_id, trash_event_id) VALUES ($1, $2)', [fileId, purgeEvent]);
    }
  }
  await db.query(`
    INSERT INTO files (id, owner_id, original_name, mime_type, size_bytes, object_key, upload_state)
    VALUES ($1, $2, 'Large pending fixture', 'text/plain', 9007199254740993, 'files/09-large-pending', 'pending')
  `, [randomUUID(), otherOwnerId]);

  const originalFiles = await db.query('SELECT * FROM files ORDER BY id');
  const originalAccounts = await db.query('SELECT id, used_bytes FROM users ORDER BY id');
  const originalQueue = await db.query('SELECT * FROM trash_purge_files ORDER BY file_id');
  const inventory = fakeInventory(
    ['files/01-ready', 'files/03-pending', 'files/05-cleanup', 'files/07-purge'].map(key => ({ key, lastModified: oldObjectDate })),
    [
      { key: 'files/unlinked-01-old', lastModified: oldObjectDate },
      { key: 'files/unlinked-02-recent', lastModified: recentObjectDate },
      { key: 'files/unlinked-03-undated' },
    ],
  );
  const result = await auditStorage(db, inventory, orphanGraceMs);
  assert.equal(result.managedPrefix, 'files/');
  assert.deepEqual(result.counts, {
    fileRows: 10,
    accounts: 2,
    objectPages: 2,
    objectsListed: 7,
    readyObjects: 1,
    pendingObjects: 1,
    cleanupObjects: 1,
    purgeQueuedObjects: 1,
    recentUnreferencedObjects: 1,
  });
  assert.deepEqual(result.findings, {
    missingReadyObjects: 1,
    suspectedOrphanObjects: 1,
    undatedUnreferencedObjects: 1,
    fileRowsOutsideManagedPrefix: 1,
    quotaMismatches: 1,
  });
  assert.deepEqual(result.quota, { recordedBytes: '9007199254741055', expectedBytes: '9007199254741056' });
  assert.equal(result.samples.quotaMismatches[0]?.recordedBytes, '62');
  assert.equal(result.samples.quotaMismatches[0]?.expectedBytes, '63');
  assert.match(result.samples.missingReadyObjects[0]!, /^[0-9a-f]{24}$/);
  const report = JSON.stringify(result);
  for (const sample of [ownerId, otherOwnerId, ...files.map(file => file.key), 'private-audit@example.test', 'Private fixture name']) {
    assert.ok(!report.includes(sample));
  }
  assert.deepEqual(await db.query('SELECT * FROM files ORDER BY id'), originalFiles);
  assert.deepEqual(await db.query('SELECT id, used_bytes FROM users ORDER BY id'), originalAccounts);
  assert.deepEqual(await db.query('SELECT * FROM trash_purge_files ORDER BY file_id'), originalQueue);
});

test('OPS-01 completes across database and inventory pages while keeping diagnostic samples bounded', {
  skip: !testDatabase,
}, async (t) => {
  const db = await isolatedDatabase(t);
  const ownerId = randomUUID();
  await db.query(`
    INSERT INTO users (id, email, name, password_hash, quota_bytes, used_bytes)
    VALUES ($1, 'audit-pages@example.test', 'Audit fixture', 'mock password', 1000, 501)
  `, [ownerId]);
  await db.query(`
    INSERT INTO files (id, owner_id, original_name, mime_type, size_bytes, object_key, upload_state)
    SELECT gen_random_uuid(), $1, 'Fixture file', 'text/plain', 1,
      'files/z-row-' || LPAD(n::text, 4, '0'), 'ready'
    FROM generate_series(1, 501) n
  `, [ownerId]);
  const firstPage = Array.from({ length: 1000 }, (_, index) => ({
    key: 'files/a-object-' + String(index).padStart(4, '0'), lastModified: oldObjectDate,
  }));
  const inventory = fakeInventory(firstPage, [{ key: 'files/a-object-1000', lastModified: oldObjectDate }]);
  const result = await auditStorage(db, inventory, orphanGraceMs);
  assert.equal(result.counts.fileRows, 501);
  assert.equal(result.counts.objectsListed, 1001);
  assert.equal(result.counts.objectPages, 2);
  assert.equal(result.findings.missingReadyObjects, 501);
  assert.equal(result.findings.suspectedOrphanObjects, 1001);
  assert.equal(result.findings.quotaMismatches, 0);
  assert.equal(result.samples.missingReadyObjects.length, 20);
  assert.equal(result.samples.suspectedOrphanObjects.length, 20);
});

test('OPS-01 rejects failed and invalid inventory runs and releases the database snapshot', {
  skip: !testDatabase,
}, async (t) => {
  const db = await isolatedDatabase(t);
  const interrupted: ObjectInventory = {
    async *listObjectPages() {
      yield [{ key: 'files/partial-inventory', lastModified: oldObjectDate }];
      throw new Error('Synthetic storage outage');
    },
  };
  await assert.rejects(auditStorage(db, interrupted, orphanGraceMs), /Synthetic storage outage/);
  const duplicate = { key: 'files/repeated', lastModified: oldObjectDate };
  await assert.rejects(auditStorage(db, fakeInventory([duplicate], [duplicate]), orphanGraceMs), /out of order/);
  const result = await auditStorage(db, fakeInventory([]), orphanGraceMs);
  assert.equal(result.counts.objectPages, 1);
  assert.deepEqual(Object.values(result.findings), [0, 0, 0, 0, 0]);
});
