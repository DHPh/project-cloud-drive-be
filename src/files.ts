import { randomUUID } from 'node:crypto';
import type { DataSource, QueryRunner } from 'typeorm';
import { ApiError, notFound, reportFailure, storageUnavailable } from './errors';
import { fileParentIsActive, lockFolderTree, requireOwnedFolder } from './folder-tree';
import type { Upload } from './multipart';
import type { ObjectStorage } from './object-storage';
import type { FileUpdate } from './validation';

export type FileRow = {
  id: string;
  original_name: string;
  folder_id: string | null;
  mime_type: string;
  size_bytes: string | number;
  description: string | null;
  tags: string[];
  created_at: Date | string;
  updated_at: Date | string;
};

export function fileSummary(file: FileRow) {
  return {
    kind: 'file' as const,
    id: file.id,
    originalName: file.original_name,
    folderId: file.folder_id,
    mimeType: file.mime_type,
    size: Number(file.size_bytes),
    description: file.description,
    tags: file.tags,
    createdAt: new Date(file.created_at).toISOString(),
    updatedAt: new Date(file.updated_at).toISOString(),
  };
}

export const fileFields = 'id, original_name, folder_id, mime_type, size_bytes, description, tags, created_at, updated_at';

const fileReadAccess = `
  id = $1 AND upload_state = 'ready' AND trashed_at IS NULL AND ${fileParentIsActive()} AND (
    owner_id = $2 OR EXISTS (
      SELECT 1 FROM file_shares
      WHERE file_id = files.id AND recipient_id = $2 AND expires_at > statement_timestamp()
    ) OR EXISTS (
      SELECT 1 FROM drive_folder_ancestors(files.folder_id, files.owner_id) a
      JOIN folder_shares s ON s.folder_id = a.folder_id
      WHERE s.recipient_id = $2 AND s.expires_at > statement_timestamp()
    )
  )
`;

async function withUploadLock<T>(
  db: DataSource, id: string, wait: boolean, work: (runner: QueryRunner) => Promise<T>
): Promise<T | undefined> {
  const runner = db.createQueryRunner();
  let locked = false;
  try {
    await runner.connect();
    if (wait) {
      await runner.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [id]);
      locked = true;
    } else {
      const [result] = await runner.query(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [id]
      ) as { locked: boolean }[];
      locked = result?.locked === true;
    }
    if (locked) return await work(runner);
  } finally {
    try {
      if (locked) await runner.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [id]);
    } finally {
      await runner.release();
    }
  }
}

export function createFiles(db: DataSource, storage: ObjectStorage, recoveryAgeMs: number) {
  async function upload(ownerId: string, input: Upload, fixtureId?: string) {
    const id = fixtureId ?? randomUUID();
    const objectKey = 'files/' + id;
    const summary = await withUploadLock(db, id, true, async (runner) => {
      if (fixtureId) {
        const [existing] = await runner.query(
          'SELECT ' + fileFields + ', upload_state FROM files WHERE id = $1 AND owner_id = $2',
          [id, ownerId]
        ) as (FileRow & { upload_state: string })[];
        if (existing?.upload_state === 'ready') return fileSummary(existing);
        if (existing) throw new Error('Run storage reconciliation before retrying this fixture upload');
      }

      await runner.startTransaction();
      try {
        await lockFolderTree(runner.manager, ownerId);
        if (input.folderId !== null) await requireOwnedFolder(runner.manager, ownerId, input.folderId);

        const reserved = await runner.query(`
          WITH reservation AS (
            UPDATE users
            SET used_bytes = used_bytes + $2::bigint
            WHERE id = $1 AND quota_bytes - used_bytes >= $2::bigint
            RETURNING id
          )
          SELECT id FROM reservation
        `, [ownerId, input.bytes.length]) as { id: string }[];
        if (!reserved.length) {
          throw new ApiError(409, 'STORAGE_QUOTA_EXCEEDED', 'This upload exceeds your storage quota.');
        }

        await runner.query(`
          INSERT INTO files (id, owner_id, folder_id, original_name, mime_type, size_bytes, object_key, upload_state)
          VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
        `, [id, ownerId, input.folderId, input.originalName, input.mimeType, input.bytes.length, objectKey]);
        await runner.commitTransaction();
      } catch (error) {
        await runner.rollbackTransaction();
        throw error;
      }

      try {
        await storage.put(objectKey, input.bytes, input.mimeType);
      } catch (error) {
        // A failed response can arrive after storage wrote the bytes. Recover after the grace period.
        reportFailure('File upload failed in object storage', error);
        try {
          await runner.query(
            "UPDATE files SET upload_state = 'cleanup', updated_at = now() WHERE id = $1 AND upload_state = 'pending'",
            [id]
          );
        } catch (cleanupError) {
          reportFailure('Unable to record storage cleanup; the pending upload can still be recovered', cleanupError);
        }
        throw storageUnavailable();
      }

      // A DB error after writing the object leaves the reservation available to reconciliation.
      const [ready] = await runner.query(`
        WITH finalized AS (
          UPDATE files SET upload_state = 'ready', updated_at = now()
          WHERE id = $1 AND upload_state = 'pending'
          RETURNING ${fileFields}
        )
        SELECT * FROM finalized
      `, [id]) as FileRow[];
      if (!ready) throw new Error('Pending upload was not finalized');
      return fileSummary(ready);
    });
    if (!summary) throw new Error('Could not acquire upload lock');
    return summary;
  }

  async function update(ownerId: string, fileId: string, input: FileUpdate) {
    return db.transaction('READ COMMITTED', async (manager) => {
      await lockFolderTree(manager, ownerId);
      if (input.folderId) await requireOwnedFolder(manager, ownerId, input.folderId);
      const [file] = await manager.query<FileRow[]>(`
        WITH changed AS (
          UPDATE files SET
            original_name = COALESCE($3::text, original_name),
            description = CASE WHEN $4::boolean THEN $5::text ELSE description END,
            tags = COALESCE($6::text[], tags),
            folder_id = CASE WHEN $7::boolean THEN $8::uuid ELSE folder_id END,
            updated_at = statement_timestamp()
          WHERE id = $1 AND owner_id = $2 AND upload_state = 'ready' AND trashed_at IS NULL
            AND ${fileParentIsActive()}
          RETURNING ${fileFields}
        )
        SELECT * FROM changed
      `, [
        fileId, ownerId, input.originalName ?? null, 'description' in input, input.description ?? null,
        input.tags ?? null, input.folderId !== undefined, input.folderId ?? null,
      ]);
      if (!file) throw notFound();
      return fileSummary(file);
    });
  }

  async function get(userId: string, fileId: string) {
    const [file] = await db.query<FileRow[]>(
      `SELECT ${fileFields} FROM files WHERE ${fileReadAccess}`, [fileId, userId]
    );
    if (!file) throw notFound();
    return fileSummary(file);
  }

  async function download(userId: string, fileId: string) {
    const [file] = await db.query<{ object_key: string; original_name: string; size_bytes: string }[]>(`
      SELECT object_key, original_name, size_bytes FROM files WHERE ${fileReadAccess}
    `, [fileId, userId]);
    if (!file) throw notFound();

    try {
      const stream = await storage.read(file.object_key);
      return { stream, name: file.original_name, size: file.size_bytes };
    } catch (error) {
      reportFailure('File download failed in object storage', error);
      throw storageUnavailable();
    }
  }

  async function reconcile(signal?: AbortSignal): Promise<{ removed: number; failed: number }> {
    const cutoff = new Date(Date.now() - recoveryAgeMs);
    const candidates = await db.query<{ id: string }[]>(`
      SELECT id FROM files WHERE upload_state <> 'ready' AND updated_at < $1
      ORDER BY updated_at, id LIMIT 25
    `, [cutoff]);

    let removed = 0;
    let failed = 0;
    for (const { id } of candidates) {
      if (signal?.aborted) break;
      try {
        const cleaned = await withUploadLock(db, id, false, async (runner) => {
          const [file] = await runner.query(
            "SELECT object_key FROM files WHERE id = $1 AND upload_state <> 'ready' AND updated_at < $2",
            [id, cutoff]
          ) as { object_key: string }[];
          if (!file) return false;

          // DeleteObject is idempotent. Keep the DB row and reservation if storage cannot confirm cleanup.
          await storage.remove(file.object_key);
          await runner.query(`
            WITH removed AS (
              DELETE FROM files WHERE id = $1 AND upload_state <> 'ready'
              RETURNING owner_id, size_bytes
            )
            UPDATE users SET used_bytes = used_bytes - removed.size_bytes
            FROM removed WHERE users.id = removed.owner_id
          `, [id]);
          return true;
        });
        if (cleaned) removed++;
      } catch (error) {
        failed++;
        reportFailure('Unable to reconcile a file upload; it remains eligible for retry', error);
      }
    }
    return { removed, failed };
  }

  return { upload, update, get, download, reconcile };
}
