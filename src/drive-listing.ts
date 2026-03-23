import type { DataSource } from 'typeorm';
import { fileFields, fileSummary, type FileRow } from './files';
import { fileParentIsActive } from './folder-tree';
import { folderSummary, type FolderRow } from './folders';
import type { DriveSearchQuery, DriveTimelineQuery } from './validation';

type Page = { page: number; limit: number };
type Breadcrumbs = { breadcrumbs: { id: string; name: string }[] };
type SearchRow = ((FolderRow & { kind: 'folder' }) | (FileRow & { kind: 'file' })) & Breadcrumbs;

const ownedActiveFile = `f.owner_id = $1 AND f.upload_state = 'ready' AND f.trashed_at IS NULL AND ${fileParentIsActive('f')}`;

async function readDrivePage<Row>(
  db: DataSource, ownerId: string, { page, limit }: Page, select: string, order: string, filters: unknown[]
) {
  const offset = (BigInt(page - 1) * BigInt(limit)).toString();
  const [result] = await db.query<{ total: string; items: Row[] }[]>(`
    WITH matching AS NOT MATERIALIZED (${select}), page_items AS (
      SELECT * FROM matching ORDER BY ${order} LIMIT $2 OFFSET $3::bigint
    ), paths AS (
      SELECT p.parent_id,
        jsonb_agg(jsonb_build_object('id', f.id, 'name', f.name) ORDER BY a.distance DESC) AS breadcrumbs
      FROM (SELECT DISTINCT parent_id FROM page_items WHERE parent_id IS NOT NULL) p
      CROSS JOIN LATERAL drive_folder_ancestors(p.parent_id, $1) a
      JOIN folders f ON f.id = a.folder_id AND f.owner_id = $1 AND f.trash_root_id IS NULL
      GROUP BY p.parent_id
    ), hits AS (
      SELECT p.*, COALESCE(paths.breadcrumbs, '[]') AS breadcrumbs
      FROM page_items p LEFT JOIN paths ON paths.parent_id = p.parent_id
    )
    SELECT (SELECT count(*) FROM matching) AS total,
      COALESCE((SELECT jsonb_agg(to_jsonb(hits) ORDER BY ${order}) FROM hits), '[]') AS items
  `, [ownerId, limit, offset, ...filters]);
  if (!result) throw new Error('Drive list returned no summary');
  const total = Number(result.total);
  return { items: result.items, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

export async function searchDrive(db: DataSource, ownerId: string, options: DriveSearchQuery) {
  const { q, includeMetadata, type, sort } = options;
  const order = sort === 'name' ? 'lower(name), id, kind' : 'created_at DESC, id, kind';
  const { items, pagination } = await readDrivePage<SearchRow>(db, ownerId, options, `
    SELECT * FROM (
      SELECT id, 'folder' AS kind, name, parent_id, description, created_at, updated_at,
        NULL::text AS original_name, NULL::uuid AS folder_id, NULL::text AS mime_type,
        NULL::bigint AS size_bytes, NULL::text[] AS tags
      FROM folders
      WHERE owner_id = $1 AND trash_root_id IS NULL AND $6 <> 'files'
      UNION ALL
      SELECT f.id, 'file', f.original_name, f.folder_id, f.description, f.created_at, f.updated_at,
        f.original_name, f.folder_id, f.mime_type, f.size_bytes, f.tags
      FROM files f WHERE ${ownedActiveFile} AND $6 <> 'folders'
    ) candidates
    WHERE $4 = '' OR strpos(lower(name), lower($4)) > 0 OR ($5::boolean AND (
      strpos(lower(description), lower($4)) > 0 OR EXISTS (
        SELECT 1 FROM unnest(tags) item_tag WHERE strpos(lower(item_tag), lower($4)) > 0
      )
    ))
  `, order, [q, includeMetadata, type]);
  return {
    data: { items: items.map((row) => ({
      item: row.kind === 'file' ? fileSummary(row) : folderSummary(row), breadcrumbs: row.breadcrumbs,
    })) },
    pagination,
  };
}

const timelineMimeCategory = `CASE
  WHEN lower(mime_type) LIKE 'image/%' THEN 'image'
  WHEN lower(mime_type) LIKE 'video/%' THEN 'video'
  WHEN lower(mime_type) LIKE 'audio/%' THEN 'audio'
  WHEN lower(mime_type) = 'application/pdf' THEN 'pdf'
  WHEN lower(mime_type) LIKE ANY (ARRAY[
    'text/%', 'application/msword', 'application/rtf', 'application/vnd.ms-%',
    'application/vnd.openxmlformats-officedocument.%', 'application/vnd.oasis.opendocument.%'
  ]) THEN 'document'
  ELSE 'other'
END`;

export async function listDriveTimeline(db: DataSource, ownerId: string, options: DriveTimelineQuery) {
  const { from, to, type } = options;
  const { items, pagination } = await readDrivePage<FileRow & Breadcrumbs>(db, ownerId, options, `
    SELECT ${fileFields}, folder_id AS parent_id
    FROM files f WHERE ${ownedActiveFile}
      AND ($4::date IS NULL OR created_at >= ($4::date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'))
      AND ($5::date IS NULL OR created_at < (($5::date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'))
      AND ($6 = 'all' OR (${timelineMimeCategory}) = $6)
  `, 'created_at DESC, id', [from ?? null, to ?? null, type]);
  return { data: { items: items.map((file) => ({ item: fileSummary(file), breadcrumbs: file.breadcrumbs })) }, pagination };
}
