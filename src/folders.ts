import { randomUUID } from 'node:crypto';
import { QueryFailedError, type DataSource, type EntityManager } from 'typeorm';
import { ApiError, notFound } from './errors';
import { fileSummary, type FileRow } from './files';
import type { FolderCreate, FolderUpdate } from './validation';

type FolderRow = {
  id: string;
  name: string;
  parent_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

function folderSummary(folder: FolderRow) {
  return {
    kind: 'folder' as const,
    id: folder.id,
    name: folder.name,
    parentId: folder.parent_id,
    createdAt: new Date(folder.created_at).toISOString(),
    updatedAt: new Date(folder.updated_at).toISOString(),
  };
}

type ListedRow = (FolderRow & { sort_kind: 0 }) | (FileRow & { sort_kind: 1 });

const folderFields = 'id, name, parent_id, created_at, updated_at';

async function writeFolder(
  db: DataSource, ownerId: string, change: (manager: EntityManager) => Promise<FolderRow | undefined>
) {
  try {
    return await db.transaction('READ COMMITTED', async (manager) => {
      // Every topology write locks the owner's tree before reading any parent links.
      await manager.query("SELECT pg_advisory_xact_lock(hashtextextended('folder-tree:' || $1::uuid::text, 0))", [ownerId]);
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

export function createFolder(db: DataSource, ownerId: string, { name, parentId = null }: FolderCreate) {
  return writeFolder(db, ownerId, async (manager) => {
    if (parentId !== null) {
      const [parent] = await manager.query<{ id: string }[]>(
        'SELECT id FROM folders WHERE id = $1 AND owner_id = $2', [parentId, ownerId]
      );
      if (!parent) throw notFound();
    }

    const [created] = await manager.query<FolderRow[]>(`
      INSERT INTO folders (id, name, parent_id, owner_id)
      VALUES ($1, $2, $3, $4) RETURNING ${folderFields}
    `, [randomUUID(), name, parentId, ownerId]);
    return created;
  });
}

export function updateFolder(db: DataSource, ownerId: string, folderId: string, input: FolderUpdate) {
  return writeFolder(db, ownerId, async (manager) => {
    const [current] = await manager.query<FolderRow[]>(
      `SELECT ${folderFields} FROM folders WHERE id = $1 AND owner_id = $2`, [folderId, ownerId]
    );
    if (!current) throw notFound();

    const name = input.name ?? current.name;
    const parentId = input.parentId === undefined ? current.parent_id : input.parentId;
    if (name === current.name && parentId === current.parent_id) return current;

    if (parentId !== null && parentId !== current.parent_id) {
      const [target] = await manager.query<{ exists: boolean; cycle: boolean }[]>(`
        WITH RECURSIVE ancestors AS (
          SELECT id, parent_id, ARRAY[id] AS visited, false AS cycle
          FROM folders WHERE id = $1 AND owner_id = $2
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
        UPDATE folders SET name = $3, parent_id = $4, updated_at = statement_timestamp()
        WHERE id = $1 AND owner_id = $2 RETURNING ${folderFields}
      )
      SELECT * FROM changed
    `, [folderId, ownerId, name, parentId]);
    return updated;
  });
}

export async function listFolder(
  db: DataSource, ownerId: string, folderId: string | null,
  options: { page: number; limit: number; q: string; type: 'all' | 'folders' }
) {
  let ancestors: FolderRow[] = [];
  if (folderId !== null) {
    ancestors = await db.query<FolderRow[]>(`
      WITH RECURSIVE ancestors AS (
        SELECT id, name, parent_id, created_at, updated_at, ARRAY[id] AS visited
        FROM folders WHERE id = $1 AND owner_id = $2
        UNION ALL
        SELECT f.id, f.name, f.parent_id, f.created_at, f.updated_at, a.visited || f.id
        FROM ancestors a JOIN folders f ON f.id = a.parent_id AND f.owner_id = $2
        WHERE NOT f.id = ANY(a.visited)
      )
      SELECT id, name, parent_id, created_at, updated_at
      FROM ancestors ORDER BY cardinality(visited) DESC
    `, [folderId, ownerId]);
    if (!ancestors.length) throw notFound();
  }

  const { page, limit, q, type } = options;
  const offset = (BigInt(page - 1) * BigInt(limit)).toString();
  const [results] = await db.query<{ total: string; items: ListedRow[] }[]>(`
    WITH direct_children AS (
      SELECT id, 0 AS sort_kind, name, parent_id, NULL::text AS original_name, NULL::uuid AS folder_id,
        NULL::text AS mime_type, NULL::bigint AS size_bytes, NULL::text AS description, NULL::text[] AS tags,
        created_at, updated_at
      FROM folders WHERE owner_id = $1 AND parent_id IS NOT DISTINCT FROM $2::uuid
      UNION ALL
      SELECT id, 1, original_name, NULL, original_name, folder_id, mime_type, size_bytes, description, tags,
        created_at, updated_at
      FROM files WHERE owner_id = $1 AND folder_id IS NOT DISTINCT FROM $2::uuid
        AND upload_state = 'ready' AND trashed_at IS NULL AND $6 = 'all'
    ), matching AS (
      SELECT * FROM direct_children WHERE $3 = '' OR strpos(lower(name), lower($3)) > 0
    ), page_items AS (
      SELECT * FROM matching ORDER BY sort_kind, lower(name), id LIMIT $4 OFFSET $5::bigint
    )
    SELECT (SELECT count(*) FROM matching) AS total,
      COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY sort_kind, lower(name), id) FROM page_items p), '[]') AS items
  `, [ownerId, folderId, q, limit, offset, type]);
  if (!results) throw new Error('Folder contents query returned no summary');

  const current = ancestors.at(-1);
  const total = Number(results.total);
  return {
    data: {
      folder: current ? folderSummary(current) : null,
      breadcrumbs: ancestors.map(({ id, name }) => ({ id, name })),
      items: results.items.map((row) => row.sort_kind === 0 ? folderSummary(row) : fileSummary(row)),
    },
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}
