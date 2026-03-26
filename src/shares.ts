import type { DataSource, EntityManager } from 'typeorm';
import { ApiError, invalidRequest, notFound } from './errors';
import { fileFields, fileSummary, type FileRow } from './files';
import { fileParentIsActive, lockFolderTree } from './folder-tree';
import type { FileShareGrant, OutgoingShareQuery } from './validation';

type Page = { page: number; limit: number };
type GrantRow = {
  recipient_id: string;
  recipient_email: string;
  recipient_name: string;
  granted_at: Date | string;
  expires_at: Date | string;
  is_active: boolean;
};
type SharedFileRow = FileRow & { owner_name: string; granted_at: string; expires_at: string };
type SharedFolderRow = {
  id: string; name: string; owner_name: string; granted_at: string; expires_at: string;
};
type OutgoingShareRow = GrantRow & { kind: 'file' | 'folder'; resource_id: string; resource_name: string };

const shareTargets = {
  file: {
    resource: 'files', grants: 'file_shares', key: 'file_id',
    active: ` AND upload_state = 'ready' AND trashed_at IS NULL AND ${fileParentIsActive()}`,
  },
  folder: { resource: 'folders', grants: 'folder_shares', key: 'folder_id', active: ' AND trash_root_id IS NULL' },
} as const;

const sharedFileFields = fileFields.split(', ').map((field) => 'f.' + field).join(', ');

function grantSummary(grant: GrantRow) {
  return {
    recipientId: grant.recipient_id,
    recipientEmail: grant.recipient_email,
    recipientName: grant.recipient_name,
    grantedAt: new Date(grant.granted_at).toISOString(),
    expiresAt: new Date(grant.expires_at).toISOString(),
    isActive: grant.is_active,
  };
}

export function createShareAdministration(db: DataSource, kind: keyof typeof shareTargets) {
  const { resource, grants, key, active } = shareTargets[kind];

  async function lockOwnedResource(manager: EntityManager, ownerId: string, resourceId: string) {
    await lockFolderTree(manager, ownerId);
    const [owned] = await manager.query<{ id: string }[]>(`
      SELECT id FROM ${resource} WHERE id = $1 AND owner_id = $2${active} FOR UPDATE
    `, [resourceId, ownerId]);
    if (!owned) throw notFound();
  }

  async function grant(ownerId: string, resourceId: string, input: FileShareGrant) {
    return db.transaction('READ COMMITTED', async (manager) => {
      await lockOwnedResource(manager, ownerId, resourceId);
      const [recipient] = await manager.query<{ id: string }[]>(
        'SELECT id FROM users WHERE email = $1', [input.email]
      );
      if (!recipient) {
        throw new ApiError(404, 'RECIPIENT_NOT_FOUND', 'The recipient account could not be found.');
      }
      if (recipient.id === ownerId) throw invalidRequest();

      const [grant] = await manager.query<GrantRow[]>(`
        WITH grant_time AS (
          SELECT date_trunc('milliseconds', statement_timestamp()) AS issued_at
        ), saved AS (
          INSERT INTO ${grants} (${key}, recipient_id, granted_at, expires_at)
          SELECT $1, $2, issued_at, COALESCE($3::timestamptz, default_file_share_expiry(issued_at))
          FROM grant_time
          WHERE $3::timestamptz IS NULL OR $3::timestamptz > statement_timestamp()
          ON CONFLICT (${key}, recipient_id) DO UPDATE SET
            granted_at = CASE WHEN ${grants}.expires_at > statement_timestamp()
              THEN ${grants}.granted_at ELSE EXCLUDED.granted_at END,
            expires_at = CASE WHEN $3::timestamptz IS NULL AND ${grants}.expires_at > statement_timestamp()
              THEN ${grants}.expires_at ELSE EXCLUDED.expires_at END
          RETURNING recipient_id, granted_at, expires_at
        )
        SELECT saved.*, u.email AS recipient_email, u.name AS recipient_name,
          saved.expires_at > statement_timestamp() AS is_active
        FROM saved JOIN users u ON u.id = saved.recipient_id
      `, [resourceId, recipient.id, input.expiresAt ?? null]);
      if (!grant) throw invalidRequest();
      return grantSummary(grant);
    });
  }

  async function revoke(ownerId: string, resourceId: string, recipientId: string) {
    await db.transaction('READ COMMITTED', async (manager) => {
      await lockOwnedResource(manager, ownerId, resourceId);
      await manager.query(
        `DELETE FROM ${grants} WHERE ${key} = $1 AND recipient_id = $2`, [resourceId, recipientId]
      );
    });
  }

  async function listGrants(ownerId: string, resourceId: string, { page, limit }: Page) {
    const offset = (BigInt(page - 1) * BigInt(limit)).toString();
    const [result] = await db.query<{ owns_resource: boolean; total: string; items: GrantRow[] }[]>(`
      WITH owned_resource AS (
        SELECT id FROM ${resource} WHERE id = $1 AND owner_id = $2${active}
      ), matching AS NOT MATERIALIZED (
        SELECT s.recipient_id, u.email AS recipient_email, u.name AS recipient_name, s.granted_at, s.expires_at,
          s.expires_at > statement_timestamp() AS is_active
        FROM owned_resource r JOIN ${grants} s ON s.${key} = r.id JOIN users u ON u.id = s.recipient_id
      ), page_items AS (
        SELECT * FROM matching ORDER BY granted_at DESC, recipient_id LIMIT $3 OFFSET $4::bigint
      )
      SELECT EXISTS (SELECT 1 FROM owned_resource) AS owns_resource, (SELECT count(*) FROM matching) AS total,
        COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY granted_at DESC, recipient_id) FROM page_items p), '[]') AS items
    `, [resourceId, ownerId, limit, offset]);
    if (!result?.owns_resource) throw notFound();
    const total = Number(result.total);
    return {
      data: { items: result.items.map(grantSummary) },
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  return { grant, revoke, listGrants };
}

export async function listSharedFiles(db: DataSource, recipientId: string, { page, limit }: Page) {
  const offset = (BigInt(page - 1) * BigInt(limit)).toString();
  const [result] = await db.query<{ total: string; items: SharedFileRow[] }[]>(`
    WITH matching AS NOT MATERIALIZED (
      SELECT ${sharedFileFields}, u.name AS owner_name, s.granted_at, s.expires_at
      FROM file_shares s JOIN files f ON f.id = s.file_id JOIN users u ON u.id = f.owner_id
      WHERE s.recipient_id = $1 AND s.expires_at > statement_timestamp() AND u.disabled_at IS NULL
        AND f.upload_state = 'ready' AND f.trashed_at IS NULL AND ${fileParentIsActive('f')}
    ), page_items AS (
      SELECT * FROM matching ORDER BY granted_at DESC, id LIMIT $2 OFFSET $3::bigint
    )
    SELECT (SELECT count(*) FROM matching) AS total,
      COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY granted_at DESC, id) FROM page_items p), '[]') AS items
  `, [recipientId, limit, offset]);
  if (!result) throw new Error('Shared files query returned no summary');
  const total = Number(result.total);
  return {
    data: {
      items: result.items.map((file) => ({
        ...fileSummary(file),
        ownerName: file.owner_name,
        sharedAt: new Date(file.granted_at).toISOString(),
        expiresAt: new Date(file.expires_at).toISOString(),
      })),
    },
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function listSharedFolders(db: DataSource, recipientId: string, { page, limit }: Page) {
  const offset = (BigInt(page - 1) * BigInt(limit)).toString();
  const [result] = await db.query<{ total: string; items: SharedFolderRow[] }[]>(`
    WITH matching AS NOT MATERIALIZED (
      SELECT f.id, f.name, u.name AS owner_name, s.granted_at, s.expires_at
      FROM folder_shares s JOIN folders f ON f.id = s.folder_id JOIN users u ON u.id = f.owner_id
      WHERE s.recipient_id = $1 AND s.expires_at > statement_timestamp() AND f.trash_root_id IS NULL AND u.disabled_at IS NULL
    ), page_items AS (
      SELECT * FROM matching ORDER BY granted_at DESC, id LIMIT $2 OFFSET $3::bigint
    )
    SELECT (SELECT count(*) FROM matching) AS total,
      COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY granted_at DESC, id) FROM page_items p), '[]') AS items
  `, [recipientId, limit, offset]);
  if (!result) throw new Error('Shared folders query returned no summary');
  const total = Number(result.total);
  return {
    data: {
      items: result.items.map((folder) => ({
        kind: 'folder' as const,
        id: folder.id,
        name: folder.name,
        ownerName: folder.owner_name,
        sharedAt: new Date(folder.granted_at).toISOString(),
        expiresAt: new Date(folder.expires_at).toISOString(),
      })),
    },
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function listOutgoingShares(db: DataSource, ownerId: string, { page, limit, type, status }: OutgoingShareQuery) {
  const offset = (BigInt(page - 1) * BigInt(limit)).toString();
  const order = 'granted_at DESC, kind, resource_id, recipient_id';
  const [result] = await db.query<{ total: string; items: OutgoingShareRow[] }[]>(`
    WITH owned_grants AS (
      SELECT 'file' AS kind, f.id AS resource_id, f.original_name AS resource_name,
        s.recipient_id, s.granted_at, s.expires_at, s.expires_at > statement_timestamp() AS is_active
      FROM files f JOIN file_shares s ON s.file_id = f.id
      WHERE f.owner_id = $1 AND f.upload_state = 'ready' AND f.trashed_at IS NULL
        AND ${fileParentIsActive('f')} AND $4 <> 'folders'
      UNION ALL
      SELECT 'folder', f.id, f.name, s.recipient_id, s.granted_at, s.expires_at,
        s.expires_at > statement_timestamp()
      FROM folders f JOIN folder_shares s ON s.folder_id = f.id
      WHERE f.owner_id = $1 AND f.trash_root_id IS NULL AND $4 <> 'files'
    ), matching AS NOT MATERIALIZED (
      SELECT g.*, u.email AS recipient_email, u.name AS recipient_name
      FROM owned_grants g JOIN users u ON u.id = g.recipient_id
      WHERE $5 = 'all' OR g.is_active = ($5 = 'active')
    ), page_items AS (
      SELECT * FROM matching ORDER BY ${order} LIMIT $2 OFFSET $3::bigint
    )
    SELECT (SELECT count(*) FROM matching) AS total,
      COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY ${order}) FROM page_items p), '[]') AS items
  `, [ownerId, limit, offset, type, status]);
  if (!result) throw new Error('Outgoing shares query returned no summary');
  const total = Number(result.total);
  return {
    data: {
      items: result.items.map((row) => ({
        kind: row.kind, resourceId: row.resource_id, resourceName: row.resource_name, grant: grantSummary(row),
      })),
    },
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}
