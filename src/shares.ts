import type { DataSource, EntityManager } from 'typeorm';
import { ApiError, invalidRequest, notFound } from './errors';
import { fileFields, fileSummary, type FileRow } from './files';
import type { FileShareGrant } from './validation';

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

async function lockOwnedFile(manager: EntityManager, ownerId: string, fileId: string) {
  // Trash and share mutations lock the same file row before modifying grants.
  const [file] = await manager.query<{ id: string }[]>(`
    SELECT id FROM files
    WHERE id = $1 AND owner_id = $2 AND upload_state = 'ready' AND trashed_at IS NULL
    FOR UPDATE
  `, [fileId, ownerId]);
  if (!file) throw notFound();
}

export function createShares(db: DataSource) {
  async function grant(ownerId: string, fileId: string, input: FileShareGrant) {
    return db.transaction(async (manager) => {
      await lockOwnedFile(manager, ownerId, fileId);
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
          INSERT INTO file_shares (file_id, recipient_id, granted_at, expires_at)
          SELECT $1, $2, issued_at, COALESCE($3::timestamptz, default_file_share_expiry(issued_at))
          FROM grant_time
          WHERE $3::timestamptz IS NULL OR $3::timestamptz > statement_timestamp()
          ON CONFLICT (file_id, recipient_id) DO UPDATE SET
            granted_at = CASE WHEN file_shares.expires_at > statement_timestamp()
              THEN file_shares.granted_at ELSE EXCLUDED.granted_at END,
            expires_at = CASE WHEN $3::timestamptz IS NULL AND file_shares.expires_at > statement_timestamp()
              THEN file_shares.expires_at ELSE EXCLUDED.expires_at END
          RETURNING recipient_id, granted_at, expires_at
        )
        SELECT saved.*, u.email AS recipient_email, u.name AS recipient_name,
          saved.expires_at > statement_timestamp() AS is_active
        FROM saved JOIN users u ON u.id = saved.recipient_id
      `, [fileId, recipient.id, input.expiresAt ?? null]);
      if (!grant) throw invalidRequest();
      return grantSummary(grant);
    });
  }

  async function revoke(ownerId: string, fileId: string, recipientId: string) {
    await db.transaction(async (manager) => {
      await lockOwnedFile(manager, ownerId, fileId);
      await manager.query(
        'DELETE FROM file_shares WHERE file_id = $1 AND recipient_id = $2', [fileId, recipientId]
      );
    });
  }

  async function listGrants(ownerId: string, fileId: string, { page, limit }: Page) {
    const offset = (BigInt(page - 1) * BigInt(limit)).toString();
    const [result] = await db.query<{ owns_file: boolean; total: string; items: GrantRow[] }[]>(`
      WITH owned_file AS (
        SELECT id FROM files WHERE id = $1 AND owner_id = $2 AND upload_state = 'ready' AND trashed_at IS NULL
      ), matching AS NOT MATERIALIZED (
        SELECT s.recipient_id, u.email AS recipient_email, u.name AS recipient_name, s.granted_at, s.expires_at,
          s.expires_at > statement_timestamp() AS is_active
        FROM owned_file f JOIN file_shares s ON s.file_id = f.id JOIN users u ON u.id = s.recipient_id
      ), page_items AS (
        SELECT * FROM matching ORDER BY granted_at DESC, recipient_id LIMIT $3 OFFSET $4::bigint
      )
      SELECT EXISTS (SELECT 1 FROM owned_file) AS owns_file, (SELECT count(*) FROM matching) AS total,
        COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY granted_at DESC, recipient_id) FROM page_items p), '[]') AS items
    `, [fileId, ownerId, limit, offset]);
    if (!result?.owns_file) throw notFound();
    const total = Number(result.total);
    return {
      data: { items: result.items.map(grantSummary) },
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async function listReceived(recipientId: string, { page, limit }: Page) {
    const offset = (BigInt(page - 1) * BigInt(limit)).toString();
    const [result] = await db.query<{ total: string; items: SharedFileRow[] }[]>(`
      WITH matching AS NOT MATERIALIZED (
        SELECT ${sharedFileFields}, u.name AS owner_name, s.granted_at, s.expires_at
        FROM file_shares s JOIN files f ON f.id = s.file_id JOIN users u ON u.id = f.owner_id
        WHERE s.recipient_id = $1 AND s.expires_at > statement_timestamp()
          AND f.upload_state = 'ready' AND f.trashed_at IS NULL
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

  return { grant, revoke, listGrants, listReceived };
}
