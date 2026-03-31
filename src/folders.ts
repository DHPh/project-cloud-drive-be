import { randomUUID } from 'node:crypto';
import { QueryFailedError, type DataSource, type EntityManager } from 'typeorm';
import { editableFolderOwner, folderEditorGrant } from './editor-access';
import { ApiError, notFound } from './errors';
import { fileSummary, type FileRow } from './files';
import { lockFolderTree, requireOwnedFolder } from './folder-tree';
import type { FolderCreate, FolderUpdate } from './validation';

export type FolderRow = {
  id: string;
  name: string;
  parent_id: string | null;
  description: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

export function folderSummary(folder: FolderRow) {
  return {
    kind: 'folder' as const,
    id: folder.id,
    name: folder.name,
    parentId: folder.parent_id,
    description: folder.description,
    createdAt: new Date(folder.created_at).toISOString(),
    updatedAt: new Date(folder.updated_at).toISOString(),
  };
}

type ListedRow = (FolderRow & { sort_kind: 0 }) | (FileRow & { sort_kind: 1 });

export const folderFields = 'id, name, parent_id, description, created_at, updated_at';

async function writeFolder(
  db: DataSource, ownerId: string, change: (manager: EntityManager) => Promise<FolderRow | undefined>
) {
  try {
    return await db.transaction('READ COMMITTED', async (manager) => {
      await lockFolderTree(manager, ownerId);
      const folder = await change(manager);
      if (!folder) throw new Error('Folder write did not return a row');
      return folderSummary(folder);
    });
  } catch (error) {
    if (error instanceof QueryFailedError) {
      const { code, constraint } = error.driverError as { code?: string; constraint?: string };
      if (code === '23505' && constraint === 'folders_sibling_name_unique') {
        throw new ApiError(409, 'FOLDER_NAME_CONFLICT', 'A folder with this name already exists in that location.');
      }
    }
    throw error;
  }
}

export function createFolder(db: DataSource, ownerId: string, { name, parentId = null, description = null }: FolderCreate) {
  return writeFolder(db, ownerId, async (manager) => {
    if (parentId !== null) await requireOwnedFolder(manager, ownerId, parentId);

    const [created] = await manager.query<FolderRow[]>(`
      INSERT INTO folders (id, name, parent_id, owner_id, description)
      VALUES ($1, $2, $3, $4, $5) RETURNING ${folderFields}
    `, [randomUUID(), name, parentId, ownerId, description]);
    return created;
  });
}

export async function updateFolder(db: DataSource, actorId: string, folderId: string, input: FolderUpdate) {
  const ownerId = input.name === undefined && input.parentId === undefined
    ? await editableFolderOwner(db, actorId, folderId) : actorId;
  return writeFolder(db, ownerId, async (manager) => {
    if (actorId !== ownerId && await editableFolderOwner(manager, actorId, folderId) !== ownerId) throw notFound();
    const [current] = await manager.query<FolderRow[]>(`
      SELECT ${folderFields} FROM folders WHERE id = $1 AND owner_id = $2 AND trash_root_id IS NULL
        AND EXISTS (SELECT 1 FROM users u WHERE u.id = $2 AND u.disabled_at IS NULL)
    `, [folderId, ownerId]);
    if (!current) throw notFound();

    const name = input.name ?? current.name;
    const parentId = input.parentId === undefined ? current.parent_id : input.parentId;
    const description = input.description === undefined ? current.description : input.description;
    if (name === current.name && parentId === current.parent_id && description === current.description) return current;

    if (parentId !== null && parentId !== current.parent_id) {
      const [target] = await manager.query<{ exists: boolean; cycle: boolean }[]>(`
        WITH RECURSIVE ancestors AS (
          SELECT id, parent_id, ARRAY[id] AS visited, false AS cycle
          FROM folders WHERE id = $1 AND owner_id = $2 AND trash_root_id IS NULL
          UNION ALL
          SELECT f.id, f.parent_id, a.visited || f.id, f.id = ANY(a.visited)
          FROM ancestors a JOIN folders f ON f.id = a.parent_id AND f.owner_id = $2
          WHERE NOT a.cycle
        )
        SELECT count(*) > 0 AS exists, COALESCE(bool_or(id = $3 OR cycle), false) AS cycle
        FROM ancestors
      `, [parentId, ownerId, folderId]);
      if (!target?.exists) throw notFound();
      if (target.cycle) {
        throw new ApiError(409, 'INVALID_FOLDER_MOVE', 'A folder cannot be moved into itself or one of its descendants.');
      }
    }

    const [updated] = await manager.query<FolderRow[]>(`
      WITH changed AS (
        UPDATE folders f SET name = $3, parent_id = $4, description = $5, updated_at = statement_timestamp()
        WHERE id = $1 AND owner_id = $2
          AND EXISTS (SELECT 1 FROM users u WHERE u.id = $2 AND u.disabled_at IS NULL)
          AND ($2 = $6 OR (${folderEditorGrant('f.id', 'f.owner_id', '$6')}
            AND EXISTS (SELECT 1 FROM users actor WHERE actor.id = $6 AND actor.disabled_at IS NULL)))
        RETURNING ${folderFields}
      )
      SELECT * FROM changed
    `, [folderId, ownerId, name, parentId, description, actorId]);
    if (!updated) throw notFound();
    return updated;
  });
}

export async function listFolder(
  db: DataSource, userId: string, folderId: string | null,
  options: { page: number; limit: number; q: string; type: 'all' | 'folders' }
) {
  const { page, limit, q, type } = options;
  const offset = (BigInt(page - 1) * BigInt(limit)).toString();
  const [results] = await db.query<{
    access: 'owner' | 'editor' | 'viewer' | null; ancestors: FolderRow[]; total: string; items: ListedRow[];
  }[]>(`
    WITH current_folder AS (
      SELECT f.id, f.owner_id FROM folders f JOIN users u ON u.id = f.owner_id
      WHERE f.id = $2::uuid AND f.trash_root_id IS NULL AND u.disabled_at IS NULL
    ), ancestors AS (
      SELECT f.id, f.name, f.parent_id, f.created_at, f.updated_at, a.distance,
        CASE WHEN a.distance = 0 THEN f.description END AS description
      FROM current_folder target
      CROSS JOIN LATERAL drive_folder_ancestors(target.id, target.owner_id) a
      JOIN folders f ON f.id = a.folder_id
    ), scope AS (
      SELECT 'owner' AS access, $1::uuid AS owner_id, NULL::integer AS boundary WHERE $2::uuid IS NULL
      UNION ALL
      SELECT 'owner', owner_id, NULL FROM current_folder WHERE owner_id = $1
      UNION ALL
      SELECT CASE WHEN bool_or(s.access = 'editor') THEN 'editor' ELSE 'viewer' END, target.owner_id, max(a.distance)
      FROM current_folder target CROSS JOIN ancestors a
      JOIN folder_shares s ON s.folder_id = a.id
      WHERE target.owner_id <> $1 AND s.recipient_id = $1 AND s.expires_at > statement_timestamp()
      GROUP BY target.owner_id
    ), direct_children AS (
      SELECT id, 0 AS sort_kind, name, parent_id, NULL::text AS original_name, NULL::uuid AS folder_id,
        NULL::text AS mime_type, NULL::bigint AS size_bytes, description, NULL::text[] AS tags,
        created_at, updated_at
      FROM folders
      WHERE owner_id = (SELECT owner_id FROM scope) AND parent_id IS NOT DISTINCT FROM $2::uuid
        AND trash_root_id IS NULL
      UNION ALL
      SELECT id, 1, original_name, NULL, original_name, folder_id, mime_type, size_bytes, description, tags,
        created_at, updated_at
      FROM files
      WHERE owner_id = (SELECT owner_id FROM scope) AND folder_id IS NOT DISTINCT FROM $2::uuid
        AND upload_state = 'ready' AND trashed_at IS NULL AND $6 = 'all'
    ), matching AS (
      SELECT * FROM direct_children WHERE $3 = '' OR strpos(lower(name), lower($3)) > 0
    ), page_items AS (
      SELECT * FROM matching ORDER BY sort_kind, lower(name), id LIMIT $4 OFFSET $5::bigint
    )
    SELECT (SELECT access FROM scope) AS access,
      COALESCE((
        SELECT jsonb_agg(to_jsonb(a) ORDER BY a.distance DESC)
        FROM ancestors a CROSS JOIN scope s
        WHERE s.access = 'owner' OR a.distance <= s.boundary
      ), '[]') AS ancestors, (SELECT count(*) FROM matching) AS total,
      COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY sort_kind, lower(name), id) FROM page_items p), '[]') AS items
  `, [userId, folderId, q, limit, offset, type]);
  if (!results?.access) throw notFound();

  const { access, ancestors } = results;
  const current = ancestors.at(-1);
  const folder = current ? folderSummary(current) : null;
  if (folder && access !== 'owner' && ancestors.length === 1) folder.parentId = null;
  const total = Number(results.total);
  return {
    data: {
      access,
      folder,
      breadcrumbs: ancestors.map(({ id, name }) => ({ id, name })),
      items: results.items.map((row) => row.sort_kind === 0 ? folderSummary(row) : fileSummary(row)),
    },
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}
