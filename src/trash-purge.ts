import type { DataSource, EntityManager } from 'typeorm';
import { notFound, reportFailure, staleTrashEvent } from './errors';
import { withFileObjectLock } from './files';
import { lockFolderTree } from './folder-tree';
import type { ObjectStorage } from './object-storage';

type TrashKind = 'file' | 'folder';
type PurgeJob = { trash_event_id: string; owner_id: string; item_kind: TrashKind; item_id: string };
type ExpiryCandidate = Pick<PurgeJob, 'owner_id' | 'trash_event_id'> & { trashed_at: string };

export const trashRetentionInterval = "INTERVAL '720 hours'";
const expiryBatchSize = 25;
const objectBatchSize = 8;
const retryDelay = "INTERVAL '1 second' * LEAST(3600, 5 * power(2, LEAST(attempts, 10)))";

async function enqueueEvents(
  manager: EntityManager, ownerId: string, eventId: string | null, now?: Date
): Promise<number> {
  const [result] = await manager.query<{ count: number }[]>(`
    WITH explicit_events AS (
      SELECT 'file' AS item_kind, id AS item_id, trash_event_id FROM files
      WHERE owner_id = $1 AND trashed_at IS NOT NULL AND ($2::uuid IS NULL OR trash_event_id = $2)
      UNION ALL
      SELECT 'folder', id, trash_event_id FROM folders
      WHERE owner_id = $1 AND trashed_at IS NOT NULL AND ($2::uuid IS NULL OR trash_event_id = $2)
    ), reserved AS (
      INSERT INTO trash_purge_jobs(trash_event_id, owner_id, item_kind, item_id, queued_at, next_attempt_at)
      SELECT trash_event_id, $1, item_kind, item_id, COALESCE($3::timestamptz, statement_timestamp()),
        COALESCE($3::timestamptz, statement_timestamp())
      FROM explicit_events ON CONFLICT (trash_event_id) DO NOTHING
      RETURNING trash_event_id, item_kind, item_id, queued_at
    ), reserved_folders AS (
      SELECT f.id, f.trash_root_id, r.trash_event_id, r.queued_at
      FROM folders f JOIN reserved r ON r.item_kind = 'folder' AND r.item_id = f.trash_root_id
      WHERE f.owner_id = $1
    ), queued_files AS (
      INSERT INTO trash_purge_files(file_id, trash_event_id, next_attempt_at)
      SELECT item_id, trash_event_id, queued_at FROM reserved WHERE item_kind = 'file'
      UNION ALL
      SELECT f.id, p.trash_event_id, p.queued_at
      FROM files f JOIN reserved_folders p ON p.id = f.folder_id
      WHERE f.owner_id = $1 AND f.trashed_at IS NULL
    ), detached_folders AS (
      UPDATE folders f SET parent_id = NULL FROM reserved_folders p
      WHERE f.owner_id = $1 AND f.parent_id = p.id AND f.trash_root_id <> p.trash_root_id
    ), detached_files AS (
      UPDATE files f SET folder_id = NULL FROM reserved_folders p
      WHERE f.owner_id = $1 AND f.folder_id = p.id AND f.trashed_at IS NOT NULL
    )
    SELECT count(*)::int AS count FROM reserved
  `, [ownerId, eventId, now ?? null]);
  if (!result) throw new Error('Trash reservation returned no count');
  return result.count;
}

export async function purgeTrashItem(db: DataSource, ownerId: string, kind: TrashKind, id: string, eventId: string) {
  return db.transaction('READ COMMITTED', async (manager) => {
    await lockFolderTree(manager, ownerId);
    const [accepted] = await manager.query<{ exists: boolean }[]>(`
      SELECT EXISTS (
        SELECT 1 FROM trash_purge_jobs WHERE trash_event_id = $1 AND owner_id = $2 AND item_kind = $3 AND item_id = $4
      ) AS exists
    `, [eventId, ownerId, kind, id]);
    if (accepted?.exists) return { acceptedCount: 1 };

    const table = kind === 'file' ? 'files' : 'folders';
    const [item] = await manager.query<{ trash_event_id: string | null; trashed_at: Date | null }[]>(`
      SELECT trash_event_id, trashed_at FROM ${table} WHERE owner_id = $1 AND id = $2
    `, [ownerId, id]);
    if (!item) throw notFound();
    if (!item.trashed_at || item.trash_event_id !== eventId) throw staleTrashEvent();
    return { acceptedCount: await enqueueEvents(manager, ownerId, eventId) };
  });
}

export async function emptyTrash(db: DataSource, ownerId: string, requestId: string) {
  return db.transaction('READ COMMITTED', async (manager) => {
    await lockFolderTree(manager, ownerId);
    const [receipt] = await manager.query<{ accepted_count: number }[]>(`
      SELECT accepted_count FROM trash_empty_requests WHERE owner_id = $1 AND request_id = $2
    `, [ownerId, requestId]);
    if (receipt) return { acceptedCount: receipt.accepted_count };

    const acceptedCount = await enqueueEvents(manager, ownerId, null);
    await manager.query(`
      INSERT INTO trash_empty_requests(owner_id, request_id, accepted_count) VALUES ($1, $2, $3)
    `, [ownerId, requestId, acceptedCount]);
    return { acceptedCount };
  });
}

export function createTrashPurge(db: DataSource, storage: ObjectStorage) {
  let expiryCursor: ExpiryCandidate | undefined;

  async function activateRetention(now?: Date): Promise<void> {
    await db.query(`
      INSERT INTO trash_retention_policy(singleton, activated_at)
      VALUES (true, COALESCE($1::timestamptz, statement_timestamp())) ON CONFLICT (singleton) DO NOTHING
    `, [now ?? null]);
  }

  async function reserveExpired(now?: Date, signal?: AbortSignal): Promise<number> {
    const candidates = await db.query<ExpiryCandidate[]>(`
      WITH cutoff AS (
        SELECT COALESCE($1::timestamptz, statement_timestamp()) - ${trashRetentionInterval} AS value
      ), expired AS (
        SELECT owner_id, trash_event_id, trashed_at FROM files WHERE trashed_at <= (SELECT value FROM cutoff)
        UNION ALL
        SELECT owner_id, trash_event_id, trashed_at FROM folders WHERE trashed_at <= (SELECT value FROM cutoff)
      )
      SELECT e.owner_id, e.trash_event_id, e.trashed_at::text FROM expired e
      WHERE EXISTS (SELECT 1 FROM trash_retention_policy WHERE activated_at <= (SELECT value FROM cutoff))
        AND NOT EXISTS (SELECT 1 FROM trash_purge_jobs j WHERE j.trash_event_id = e.trash_event_id)
        AND ($2::timestamptz IS NULL OR (e.trashed_at, e.trash_event_id) > ($2::timestamptz, $3::uuid))
      ORDER BY e.trashed_at, e.trash_event_id LIMIT $4
    `, [now ?? null, expiryCursor?.trashed_at ?? null, expiryCursor?.trash_event_id ?? null, expiryBatchSize]);

    let queued = 0;
    for (const candidate of candidates) {
      if (signal?.aborted) break;
      try {
        queued += await db.transaction('READ COMMITTED', async (manager) => {
          await lockFolderTree(manager, candidate.owner_id);
          // The same item ID may have been restored and trashed again after the scan.
          return enqueueEvents(manager, candidate.owner_id, candidate.trash_event_id, now);
        });
      } catch (error) {
        reportFailure('Unable to queue an expired Trash entry; it remains eligible', error);
      }
      expiryCursor = candidate;
    }
    if (!signal?.aborted && candidates.length < expiryBatchSize) expiryCursor = undefined;
    return queued;
  }

  async function removeObject(fileId: string, now?: Date): Promise<'removed' | 'failed' | undefined> {
    return withFileObjectLock(db, fileId, false, async (runner) => {
      const [file] = await runner.query(`
        SELECT f.object_key FROM trash_purge_files p JOIN files f ON f.id = p.file_id
        WHERE p.file_id = $1 AND p.next_attempt_at <= COALESCE($2::timestamptz, statement_timestamp())
      `, [fileId, now ?? null]) as { object_key: string }[];
      if (!file) return;

      try {
        await storage.remove(file.object_key);
        await runner.query(`
          WITH removed AS (
            DELETE FROM files f USING trash_purge_files p WHERE f.id = $1 AND p.file_id = f.id
            RETURNING f.owner_id, f.size_bytes
          )
          UPDATE users u SET used_bytes = u.used_bytes - removed.size_bytes
          FROM removed WHERE u.id = removed.owner_id
        `, [fileId]);
        return 'removed';
      } catch (error) {
        reportFailure('Unable to finalize a Trash object; it remains queued', error);
        await runner.query(`
          UPDATE trash_purge_files SET attempts = attempts + 1,
            next_attempt_at = COALESCE($2::timestamptz, statement_timestamp()) + ${retryDelay}
          WHERE file_id = $1
        `, [fileId, now ?? null]);
        return 'failed';
      }
    });
  }

  async function finalizeJob(job: PurgeJob, now?: Date): Promise<boolean> {
    return db.transaction('READ COMMITTED', async (manager) => {
      await lockFolderTree(manager, job.owner_id);
      const [ready] = await manager.query<{ trash_event_id: string }[]>(`
        SELECT j.trash_event_id FROM trash_purge_jobs j WHERE j.trash_event_id = $1 AND j.completed_at IS NULL
          AND j.next_attempt_at <= COALESCE($2::timestamptz, statement_timestamp())
          AND NOT EXISTS (SELECT 1 FROM trash_purge_files p WHERE p.trash_event_id = j.trash_event_id)
      `, [job.trash_event_id, now ?? null]);
      if (!ready) return false;

      if (job.item_kind === 'folder') {
        await manager.query('DELETE FROM folders WHERE owner_id = $1 AND trash_root_id = $2', [job.owner_id, job.item_id]);
      }
      await manager.query(`
        UPDATE trash_purge_jobs SET completed_at = COALESCE($2::timestamptz, statement_timestamp())
        WHERE trash_event_id = $1
      `, [job.trash_event_id, now ?? null]);
      return true;
    });
  }

  async function processQueue(now?: Date, signal?: AbortSignal) {
    const files = await db.query<{ file_id: string }[]>(`
      SELECT file_id FROM trash_purge_files WHERE next_attempt_at <= COALESCE($1::timestamptz, statement_timestamp())
      ORDER BY next_attempt_at, file_id LIMIT $2
    `, [now ?? null, objectBatchSize]);
    let removed = 0;
    let failed = 0;
    for (const file of files) {
      if (signal?.aborted) break;
      const result = await removeObject(file.file_id, now);
      if (result === 'removed') removed++;
      if (result === 'failed') failed++;
    }

    const jobs = await db.query<PurgeJob[]>(`
      SELECT trash_event_id, owner_id, item_kind, item_id FROM trash_purge_jobs j WHERE completed_at IS NULL
        AND next_attempt_at <= COALESCE($1::timestamptz, statement_timestamp())
        AND NOT EXISTS (SELECT 1 FROM trash_purge_files p WHERE p.trash_event_id = j.trash_event_id)
      ORDER BY next_attempt_at, queued_at, trash_event_id LIMIT $2
    `, [now ?? null, expiryBatchSize]);
    let completed = 0;
    for (const job of jobs) {
      if (signal?.aborted) break;
      try {
        if (await finalizeJob(job, now)) completed++;
      } catch (error) {
        failed++;
        reportFailure('Unable to finalize a Trash entry; it remains queued', error);
        await db.query(`
          UPDATE trash_purge_jobs SET attempts = attempts + 1,
            next_attempt_at = COALESCE($2::timestamptz, statement_timestamp()) + ${retryDelay}
          WHERE trash_event_id = $1 AND completed_at IS NULL
            AND next_attempt_at <= COALESCE($2::timestamptz, statement_timestamp())
        `, [job.trash_event_id, now ?? null]);
      }
    }
    return { removed, failed, completed };
  }

  return { activateRetention, reserveExpired, processQueue };
}
