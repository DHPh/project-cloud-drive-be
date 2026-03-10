import type { DataSource, EntityManager } from 'typeorm';
import { notFound, staleTrashEvent, trashDeleteInProgress } from './errors';
import { fileFields, fileSummary, type FileRow } from './files';
import { fileParentIsActive, lockFolderTree } from './folder-tree';
import { folderFields, folderSummary, type FolderRow } from './folders';
import { trashRetentionInterval } from './trash-purge';

type TrashTimestamp = { trashed_at: Date | null; trash_event_id: string | null };
type FileTrashState = Pick<FileRow, 'id' | 'folder_id' | 'original_name'> & TrashTimestamp;
type FolderTrashState = Pick<FolderRow, 'id' | 'parent_id' | 'name'> & TrashTimestamp;

const restoreSuffix = ' - khôi phục';
const restoreTargets = {
  file: { table: 'files', name: 'original_name', parent: 'folder_id', active: "trashed_at IS NULL AND upload_state <> 'cleanup'" },
  folder: { table: 'folders', name: 'name', parent: 'parent_id', active: 'trash_root_id IS NULL' },
} as const;

async function privateRestoreParent(manager: EntityManager, ownerId: string, parentId: string | null) {
  if (!parentId) return null;
  const [parent] = await manager.query<{ id: string }[]>(`
    SELECT f.id FROM folders f
    WHERE f.owner_id = $1 AND f.id = $2 AND f.trash_root_id IS NULL AND NOT EXISTS (
      SELECT 1 FROM drive_folder_ancestors(f.id, f.owner_id) a
      JOIN folder_shares s ON s.folder_id = a.folder_id
      WHERE s.expires_at > statement_timestamp()
    )
  `, [ownerId, parentId]);
  return parent?.id ?? null;
}

function clipName(value: string, limit: number, kind: keyof typeof restoreTargets): string {
  if (kind === 'folder') return [...value].slice(0, limit).join('');
  // File name validation counts UTF-16 units. Keep whole Unicode characters at the boundary.
  return value.slice(0, limit).replace(/[\uD800-\uDBFF]$/, '');
}

async function restoreName(
  manager: EntityManager, ownerId: string, parentId: string | null, name: string, kind: keyof typeof restoreTargets
) {
  const target = restoreTargets[kind];
  const rows = await manager.query<{ name: string }[]>(`
    SELECT ${target.name} AS name FROM ${target.table}
    WHERE owner_id = $1 AND ${target.parent} IS NOT DISTINCT FROM $2::uuid AND ${target.active}
      AND (${target.name} = $3 OR strpos(${target.name}, $4) > 0)
  `, [ownerId, parentId, name, restoreSuffix]);
  const existing = new Set(rows.map((row) => row.name));
  if (!existing.has(name)) return name;

  const dot = name.lastIndexOf('.');
  const hasExtension = kind === 'file' && dot > 0 && dot < name.length - 1;
  const stem = hasExtension ? name.slice(0, dot) : name;
  const extension = hasExtension ? name.slice(dot) : '';
  const firstCharacterLength = [...stem][0]?.length ?? 1;

  for (let number = 1; ; number++) {
    const suffix = number === 1 ? restoreSuffix : `${restoreSuffix} ${number}`;
    const available = 255 - suffix.length;
    const boundedExtension = clipName(extension, available - firstCharacterLength, kind);
    const candidate = clipName(stem, available - boundedExtension.length, kind) + suffix + boundedExtension;
    if (!existing.has(candidate)) return candidate;
  }
}

function fileState(file: FileTrashState) {
  return {
    id: file.id, folderId: file.folder_id, originalName: file.original_name,
    trashedAt: file.trashed_at?.toISOString() ?? null,
  };
}

async function guardRestore(manager: EntityManager, item: TrashTimestamp, expectedEvent?: string) {
  if (expectedEvent && expectedEvent !== item.trash_event_id) throw staleTrashEvent();
  if (!item.trashed_at) return;
  const [job] = await manager.query<{ exists: boolean }[]>(`
    SELECT EXISTS (SELECT 1 FROM trash_purge_jobs WHERE trash_event_id = $1) AS exists
  `, [item.trash_event_id]);
  if (job?.exists) throw trashDeleteInProgress();
}

export function setFileTrashed(db: DataSource, ownerId: string, fileId: string, trashed: boolean, expectedEvent?: string) {
  return db.transaction('READ COMMITTED', async (manager) => {
    await lockFolderTree(manager, ownerId);
    const [file] = await manager.query<(FileTrashState & { parent_active: boolean })[]>(`
      SELECT id, folder_id, original_name, trashed_at, trash_event_id, ${fileParentIsActive()} AS parent_active
      FROM files WHERE id = $1 AND owner_id = $2 AND upload_state = 'ready'
      FOR UPDATE
    `, [fileId, ownerId]);
    if (!file || (!file.parent_active && file.trashed_at === null)) throw notFound();
    if (!trashed) await guardRestore(manager, file, expectedEvent);
    if ((file.trashed_at !== null) === trashed) return fileState(file);

    const folderId = trashed ? file.folder_id : await privateRestoreParent(manager, ownerId, file.folder_id);
    const name = trashed ? file.original_name : await restoreName(manager, ownerId, folderId, file.original_name, 'file');
    const [updated] = await manager.query<FileTrashState[]>(`
      WITH changed AS (
        UPDATE files SET
          trashed_at = CASE WHEN $3::boolean THEN statement_timestamp() ELSE NULL END,
          trash_event_id = CASE WHEN $3::boolean THEN gen_random_uuid() ELSE trash_event_id END,
          folder_id = $4,
          original_name = $5,
          updated_at = CASE WHEN folder_id IS DISTINCT FROM $4 OR original_name <> $5
            THEN statement_timestamp() ELSE updated_at END
        WHERE id = $1 AND owner_id = $2
        RETURNING id, folder_id, original_name, trashed_at, trash_event_id
      )
      SELECT * FROM changed
    `, [fileId, ownerId, trashed, folderId, name]);
    if (!updated) throw new Error('Locked file could not be updated');
    if (trashed) await manager.query('DELETE FROM file_shares WHERE file_id = $1', [fileId]);
    return fileState(updated);
  });
}

async function moveFolderToTrash(manager: EntityManager, ownerId: string, folderId: string) {
  const [updated] = await manager.query<FolderTrashState[]>(`
    WITH RECURSIVE subtree AS (
      SELECT id FROM folders WHERE id = $1 AND owner_id = $2 AND trash_root_id IS NULL
      UNION
      SELECT f.id FROM folders f JOIN subtree s ON s.id = f.parent_id
      WHERE f.owner_id = $2 AND f.trash_root_id IS NULL
    ), moved AS (
      UPDATE folders f SET
        trash_root_id = $1,
        trashed_at = CASE WHEN f.id = $1 THEN statement_timestamp() ELSE NULL END,
        trash_event_id = CASE WHEN f.id = $1 THEN gen_random_uuid() ELSE f.trash_event_id END
      FROM subtree s WHERE f.id = s.id
      RETURNING f.id, f.parent_id, f.name, f.trashed_at, f.trash_event_id
    ), revoked_folder_grants AS (
      DELETE FROM folder_shares s USING moved m WHERE s.folder_id = m.id
    ), revoked_file_grants AS (
      DELETE FROM file_shares s USING files f, moved m
      WHERE s.file_id = f.id AND f.folder_id = m.id AND f.owner_id = $2 AND f.trashed_at IS NULL
    )
    SELECT id, parent_id, name, trashed_at, trash_event_id FROM moved WHERE id = $1
  `, [folderId, ownerId]);
  return updated;
}

async function restoreFolder(manager: EntityManager, ownerId: string, folder: FolderTrashState) {
  const parentId = await privateRestoreParent(manager, ownerId, folder.parent_id);
  const name = await restoreName(manager, ownerId, parentId, folder.name, 'folder');
  const [updated] = await manager.query<FolderTrashState[]>(`
    WITH restored AS (
      UPDATE folders SET
        trash_root_id = NULL,
        trashed_at = NULL,
        parent_id = CASE WHEN id = $1 THEN $3::uuid ELSE parent_id END,
        name = CASE WHEN id = $1 THEN $4::text ELSE name END,
        updated_at = CASE WHEN id = $1 AND (parent_id IS DISTINCT FROM $3 OR name <> $4)
          THEN statement_timestamp() ELSE updated_at END
      WHERE owner_id = $2 AND trash_root_id = $1
      RETURNING id, parent_id, name, trashed_at, trash_event_id
    )
    SELECT * FROM restored WHERE id = $1
  `, [folder.id, ownerId, parentId, name]);
  return updated;
}

function folderState(folder: FolderTrashState) {
  return {
    id: folder.id, parentId: folder.parent_id, name: folder.name,
    trashedAt: folder.trashed_at?.toISOString() ?? null,
  };
}

export function setFolderTrashed(db: DataSource, ownerId: string, folderId: string, trashed: boolean, expectedEvent?: string) {
  return db.transaction('READ COMMITTED', async (manager) => {
    await lockFolderTree(manager, ownerId);
    const [folder] = await manager.query<(FolderTrashState & { trash_root_id: string | null })[]>(`
      SELECT id, parent_id, name, trashed_at, trash_root_id, trash_event_id FROM folders WHERE owner_id = $1 AND id = $2
    `, [ownerId, folderId]);
    if (!folder || (folder.trash_root_id && folder.trash_root_id !== folder.id)) throw notFound();
    if (!trashed) await guardRestore(manager, folder, expectedEvent);
    if ((folder.trash_root_id !== null) === trashed) return folderState(folder);

    const updated = trashed ? await moveFolderToTrash(manager, ownerId, folderId) : await restoreFolder(manager, ownerId, folder);
    if (!updated) throw new Error('Locked folder could not be updated');
    return folderState(updated);
  });
}

type TrashListRow = {
  trashed_at: string;
  trash_event_id: string;
  delete_after: string | null;
  purge_status: 'available' | 'purging' | 'retrying';
} & ({ kind: 'file'; data: FileRow } | { kind: 'folder'; data: FolderRow });

type TrashListResult = {
  total: string; remaining_bytes: string; recoverable: string; purging: string; retrying: string; items: TrashListRow[];
};

export async function listTrash(
  db: DataSource, ownerId: string, { page, limit, includeFolders }: { page: number; limit: number; includeFolders: boolean }
) {
  const offset = (BigInt(page - 1) * BigInt(limit)).toString();
  const [result] = await db.query<TrashListResult[]>(`
    WITH events AS (
      SELECT id, trashed_at, trash_event_id, 'file' AS kind, to_jsonb(f) AS data FROM (
        SELECT ${fileFields}, trashed_at, trash_event_id FROM files
        WHERE owner_id = $1 AND upload_state = 'ready' AND trashed_at IS NOT NULL
      ) f
      UNION ALL
      SELECT id, trashed_at, trash_event_id, 'folder', to_jsonb(f) FROM (
        SELECT ${folderFields}, trashed_at, trash_event_id FROM folders
        WHERE owner_id = $1 AND trashed_at IS NOT NULL
      ) f
    ), marked AS (
      SELECT e.*, CASE WHEN j.trash_event_id IS NULL THEN 'available'
        WHEN j.attempts > 0 OR EXISTS (SELECT 1 FROM trash_purge_files p WHERE p.trash_event_id = e.trash_event_id AND p.attempts > 0)
          THEN 'retrying' ELSE 'purging' END AS purge_status,
        (SELECT greatest(e.trashed_at, activated_at) + ${trashRetentionInterval} FROM trash_retention_policy) AS delete_after
      FROM events e LEFT JOIN trash_purge_jobs j ON j.trash_event_id = e.trash_event_id
    ), matching AS (
      SELECT * FROM marked WHERE $4::boolean OR kind = 'file'
    ), page_items AS (
      SELECT * FROM matching ORDER BY trashed_at DESC, id, kind LIMIT $2 OFFSET $3::bigint
    )
    SELECT (SELECT count(*) FROM matching) AS total,
      (SELECT count(*) FROM marked WHERE purge_status = 'available') AS recoverable,
      (SELECT count(*) FROM marked WHERE purge_status = 'purging') AS purging,
      (SELECT count(*) FROM marked WHERE purge_status = 'retrying') AS retrying,
      (SELECT COALESCE(sum(f.size_bytes), 0) FROM files f LEFT JOIN folders p ON p.id = f.folder_id
        WHERE f.owner_id = $1 AND (f.trashed_at IS NOT NULL OR p.trash_root_id IS NOT NULL)) AS remaining_bytes,
      COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY trashed_at DESC, id, kind) FROM page_items p), '[]') AS items
  `, [ownerId, limit, offset, includeFolders]);
  if (!result) throw new Error('Trash query returned no summary');

  const total = Number(result.total);
  return {
    data: {
      items: result.items.map((item) => ({
        ...(item.kind === 'file' ? fileSummary(item.data) : folderSummary(item.data)),
        trashedAt: new Date(item.trashed_at).toISOString(),
        trashEventId: item.trash_event_id,
        deleteAfter: item.delete_after ? new Date(item.delete_after).toISOString() : null,
        purgeStatus: item.purge_status,
      })),
      summary: {
        remainingBytes: Number(result.remaining_bytes), recoverableCount: Number(result.recoverable),
        purgingCount: Number(result.purging), retryingCount: Number(result.retrying),
      },
    },
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}
