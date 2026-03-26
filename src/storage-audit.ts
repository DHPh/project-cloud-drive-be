import { createHash, randomUUID } from 'node:crypto';
import type { DataSource, QueryRunner } from 'typeorm';
import type { InventoryObject, ObjectInventory } from './object-storage';

const managedPrefix = 'files/';
const databasePageSize = 500;
const inventoryPageSize = 1000;
const sampleLimit = 20;

type FileRow = {
  object_key: string;
  upload_state: 'pending' | 'ready' | 'cleanup';
  queued_for_purge: boolean;
};

type AccountRow = { id: string; recorded_bytes: string; expected_bytes: string };
type AuditCursor = 'storage_audit_files' | 'storage_audit_accounts';

function compareKeys(first: string, second: string): number {
  return Buffer.compare(Buffer.from(first), Buffer.from(second));
}

function reference(kind: 'object' | 'account', value: string): string {
  return createHash('sha256').update(kind + ':' + value).digest('hex').slice(0, 24);
}

function addSample<T>(samples: T[], sample: T): void {
  if (samples.length < sampleLimit) samples.push(sample);
}

async function* readCursor<T>(runner: QueryRunner, cursor: AuditCursor): AsyncGenerator<T> {
  for (;;) {
    const rows = await runner.query(`FETCH FORWARD ${databasePageSize} FROM ${cursor}`) as T[];
    yield* rows;
    if (rows.length < databasePageSize) return;
  }
}

export async function auditStorage(db: DataSource, inventory: ObjectInventory, orphanGraceMs: number) {
  const auditId = randomUUID();
  const counts = {
    fileRows: 0,
    accounts: 0,
    objectPages: 0,
    objectsListed: 0,
    readyObjects: 0,
    pendingObjects: 0,
    cleanupObjects: 0,
    purgeQueuedObjects: 0,
    recentUnreferencedObjects: 0,
  };
  const findings = {
    missingReadyObjects: 0,
    suspectedOrphanObjects: 0,
    undatedUnreferencedObjects: 0,
    fileRowsOutsideManagedPrefix: 0,
    quotaMismatches: 0,
  };
  const samples = {
    missingReadyObjects: [] as string[],
    suspectedOrphanObjects: [] as string[],
    undatedUnreferencedObjects: [] as string[],
    fileRowsOutsideManagedPrefix: [] as string[],
    quotaMismatches: [] as { accountRef: string; recordedBytes: string; expectedBytes: string }[],
  };

  const runner = db.createQueryRunner();

  async function* metadata(): AsyncGenerator<FileRow> {
    for await (const file of readCursor<FileRow>(runner, 'storage_audit_files')) {
      counts.fileRows++;
      if (file.object_key.startsWith(managedPrefix)) {
        yield file;
      } else {
        findings.fileRowsOutsideManagedPrefix++;
        addSample(samples.fileRowsOutsideManagedPrefix, reference('object', file.object_key));
      }
    }
  }

  async function* storedObjects(): AsyncGenerator<InventoryObject> {
    let lastKey: string | undefined;
    for await (const page of inventory.listObjectPages(managedPrefix, inventoryPageSize)) {
      counts.objectPages++;
      if (page.length > inventoryPageSize) throw new Error('Object inventory exceeds its page size');
      for (const object of page) {
        if (!object.key.startsWith(managedPrefix) || (lastKey !== undefined && compareKeys(lastKey, object.key) >= 0)) {
          throw new Error('Object inventory is out of order or outside its prefix');
        }
        lastKey = object.key;
        counts.objectsListed++;
        yield object;
      }
    }
  }

  function recordMissing(file: FileRow): void {
    if (file.upload_state === 'ready' && !file.queued_for_purge) {
      findings.missingReadyObjects++;
      addSample(samples.missingReadyObjects, reference('object', file.object_key));
    }
  }

  function recordUnreferenced(object: InventoryObject, cutoff: number): void {
    const modified = object.lastModified?.getTime();
    if (modified === undefined || !Number.isFinite(modified)) {
      findings.undatedUnreferencedObjects++;
      addSample(samples.undatedUnreferencedObjects, reference('object', object.key));
    } else if (modified < cutoff) {
      findings.suspectedOrphanObjects++;
      addSample(samples.suspectedOrphanObjects, reference('object', object.key));
    } else {
      counts.recentUnreferencedObjects++;
    }
  }

  try {
    await runner.connect();
    await runner.startTransaction('REPEATABLE READ');
    await runner.query('SET TRANSACTION READ ONLY');
    const [snapshot] = await runner.query('SELECT transaction_timestamp() AS started_at') as { started_at: Date }[];
    if (!snapshot) throw new Error('Storage audit could not establish its snapshot time');
    const cutoff = snapshot.started_at.getTime() - orphanGraceMs;

    await runner.query(`
      DECLARE storage_audit_files NO SCROLL CURSOR FOR
      SELECT f.object_key, f.upload_state,
        EXISTS (SELECT 1 FROM trash_purge_files p WHERE p.file_id = f.id) AS queued_for_purge
      FROM files f ORDER BY f.object_key COLLATE "C"
    `);

    const files = metadata();
    const objects = storedObjects();
    try {
      let file = await files.next();
      let object = await objects.next();
      while (!file.done && !object.done) {
        const order = compareKeys(file.value.object_key, object.value.key);
        if (order < 0) {
          recordMissing(file.value);
          file = await files.next();
        } else if (order > 0) {
          recordUnreferenced(object.value, cutoff);
          object = await objects.next();
        } else {
          if (file.value.queued_for_purge) counts.purgeQueuedObjects++;
          else if (file.value.upload_state === 'ready') counts.readyObjects++;
          else if (file.value.upload_state === 'pending') counts.pendingObjects++;
          else counts.cleanupObjects++;
          file = await files.next();
          object = await objects.next();
        }
      }
      while (!file.done) {
        recordMissing(file.value);
        file = await files.next();
      }
      while (!object.done) {
        recordUnreferenced(object.value, cutoff);
        object = await objects.next();
      }
    } finally {
      await files.return(undefined);
      await objects.return(undefined);
    }

    await runner.query(`
      DECLARE storage_audit_accounts NO SCROLL CURSOR FOR
      WITH expected AS (SELECT owner_id, SUM(size_bytes) AS bytes FROM files GROUP BY owner_id)
      SELECT u.id, u.used_bytes::text AS recorded_bytes, COALESCE(e.bytes, 0)::text AS expected_bytes
      FROM users u LEFT JOIN expected e ON e.owner_id = u.id ORDER BY u.id
    `);
    let recordedBytes = 0n;
    let expectedBytes = 0n;
    for await (const account of readCursor<AccountRow>(runner, 'storage_audit_accounts')) {
      counts.accounts++;
      recordedBytes += BigInt(account.recorded_bytes);
      expectedBytes += BigInt(account.expected_bytes);
      if (account.recorded_bytes !== account.expected_bytes) {
        findings.quotaMismatches++;
        addSample(samples.quotaMismatches, {
          accountRef: reference('account', account.id),
          recordedBytes: account.recorded_bytes,
          expectedBytes: account.expected_bytes,
        });
      }
    }

    await runner.commitTransaction();
    return {
      schemaVersion: 1,
      auditId,
      startedAt: snapshot.started_at.toISOString(),
      completedAt: new Date().toISOString(),
      managedPrefix,
      orphanGraceMs,
      counts,
      quota: { recordedBytes: recordedBytes.toString(), expectedBytes: expectedBytes.toString() },
      findings,
      samples,
    };
  } catch (error) {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    throw error;
  } finally {
    await runner.release();
  }
}
