import type { DataSource } from 'typeorm';
import { notFound } from './errors';
import { fileSummary, type FileRow } from './files';

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

export async function listFolder(
  db: DataSource, ownerId: string, folderId: string | null,
  options: { page: number; limit: number; q: string }
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

  const { page, limit, q } = options;
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
        AND upload_state = 'ready' AND trashed_at IS NULL
    ), matching AS (
      SELECT * FROM direct_children WHERE $3 = '' OR strpos(lower(name), lower($3)) > 0
    ), page_items AS (
      SELECT * FROM matching ORDER BY sort_kind, lower(name), id LIMIT $4 OFFSET $5::bigint
    )
    SELECT (SELECT count(*) FROM matching) AS total,
      COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY sort_kind, lower(name), id) FROM page_items p), '[]') AS items
  `, [ownerId, folderId, q, limit, offset]);
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
