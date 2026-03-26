import { randomBytes } from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';
import { accountEmailConflict, accountLinkNotFound, accountLinkUsed, invalidateSessions, lockAccountAdministration,
  recordAdminAction } from './accounts';
import { ApiError, notFound, sessionRequired } from './errors';
import { hashPassword, publicUser, tokenHash, type User } from './session';
import type { AdminInviteQuery, AdminUserQuery, AdminUserUpdate, BootstrapAdminInput } from './validation';

type Page = { page: number; limit: number };
type UserRow = User & { disabled_at: Date | null; used_bytes: string; quota_bytes: string };
type InviteRow = { id: string; target_email: string; status: 'active' | 'expired' | 'used' | 'revoked';
  created_at: Date | string; expires_at: Date | string };
type AuditRow = { id: string; actor_id: string; actor_email: string; action: string; target_id: string | null;
  target_email: string | null; created_at: string };

const userFields = 'id, email, name, role, disabled_at, used_bytes, quota_bytes';
const inviteStatus = `CASE WHEN used_at IS NOT NULL THEN 'used' WHEN revoked_at IS NOT NULL THEN 'revoked'
  WHEN expires_at <= statement_timestamp() THEN 'expired' ELSE 'active' END`;

function userSummary(user: UserRow) {
  return { ...publicUser(user), disabled: user.disabled_at !== null,
    usedBytes: Number(user.used_bytes), quotaBytes: Number(user.quota_bytes) };
}

function inviteSummary(invite: InviteRow) {
  return { id: invite.id, email: invite.target_email, status: invite.status,
    createdAt: new Date(invite.created_at).toISOString(), expiresAt: new Date(invite.expires_at).toISOString() };
}

function requireAdmin(user: User) {
  if (user.role !== 'admin') throw new ApiError(403, 'FORBIDDEN', 'Administrator access is required.');
}

async function changeAsAdmin<T>(db: DataSource, actorId: string, change: (manager: EntityManager) => Promise<T>) {
  return db.transaction(async (manager) => {
    await lockAccountAdministration(manager);
    const [actor] = await manager.query<User[]>(`
      SELECT id, email, name, role FROM users WHERE id = $1 AND disabled_at IS NULL FOR UPDATE
    `, [actorId]);
    if (!actor) throw sessionRequired();
    requireAdmin(actor);
    return change(manager);
  });
}

async function readPage<Row, Item>(
  db: DataSource, { page, limit }: Page, select: string, order: string, params: unknown[], summary: (row: Row) => Item
) {
  const offset = (BigInt(page - 1) * BigInt(limit)).toString();
  const [result] = await db.query<{ total: string; items: Row[] }[]>(`
    WITH matching AS NOT MATERIALIZED (${select}), page_items AS (
      SELECT * FROM matching ORDER BY ${order} LIMIT $1 OFFSET $2::bigint
    )
    SELECT (SELECT count(*) FROM matching) AS total,
      COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY ${order}) FROM page_items p), '[]') AS items
  `, [limit, offset, ...params]);
  if (!result) throw new Error('Admin list returned no summary');
  const total = Number(result.total);
  return { data: { items: result.items.map(summary) }, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

export async function bootstrapAdmin(db: DataSource, { email, name, password }: BootstrapAdminInput) {
  const passwordHash = await hashPassword(password);
  return db.transaction(async (manager) => {
    await lockAccountAdministration(manager);
    const [existing] = await manager.query<{ id: string }[]>("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
    if (existing) throw new ApiError(409, 'ADMIN_ALREADY_EXISTS', 'An administrator already exists.');
    const [created] = await manager.query<User[]>(`
      INSERT INTO users (id, email, name, password_hash, role) VALUES (gen_random_uuid(), $1, $2, $3, 'admin')
      ON CONFLICT (email) DO NOTHING RETURNING id, email, name, role
    `, [email, name, passwordHash]);
    if (!created) throw accountEmailConflict();
    await recordAdminAction(manager, created.id, 'admin_bootstrapped', created.id, created.email);
    return created;
  });
}

export function createAdminAdministration(db: DataSource) {
  function listInvites(actor: User, query: AdminInviteQuery) {
    requireAdmin(actor);
    return readPage(db, query, `
      SELECT * FROM (
        SELECT id, target_email, created_at, expires_at, ${inviteStatus} AS status
        FROM account_links WHERE kind = 'invite'
      ) invites WHERE $3 = 'all' OR status = $3
    `, 'created_at DESC, id', [query.status], inviteSummary);
  }

  async function createInvite(actorId: string, email: string) {
    const token = randomBytes(32).toString('base64url');
    return changeAsAdmin(db, actorId, async (manager) => {
      const [existing] = await manager.query<{ id: string }[]>('SELECT id FROM users WHERE email = $1', [email]);
      if (existing) throw accountEmailConflict();
      await manager.query(`
        UPDATE account_links SET revoked_at = statement_timestamp()
        WHERE kind = 'invite' AND target_email = $1 AND used_at IS NULL AND revoked_at IS NULL
          AND expires_at > statement_timestamp()
      `, [email]);
      const [invite] = await manager.query<InviteRow[]>(`
        INSERT INTO account_links (kind, token_hash, target_email, expires_at)
        VALUES ('invite', $1, $2, statement_timestamp() + INTERVAL '24 hours')
        RETURNING id, target_email, created_at, expires_at, 'active' AS status
      `, [tokenHash(token), email]);
      if (!invite) throw new Error('Invite insert returned no record');
      await recordAdminAction(manager, actorId, 'invite_created', invite.id, email);
      return { invite: inviteSummary(invite), token };
    });
  }

  async function revokeInvite(actorId: string, inviteId: string) {
    return changeAsAdmin(db, actorId, async (manager) => {
      const [invite] = await manager.query<InviteRow[]>(`
        SELECT id, target_email, created_at, expires_at, ${inviteStatus} AS status
        FROM account_links WHERE id = $1 AND kind = 'invite' FOR UPDATE
      `, [inviteId]);
      if (!invite) throw accountLinkNotFound();
      if (invite.status === 'used') throw accountLinkUsed();
      if (invite.status === 'active') {
        await manager.query('UPDATE account_links SET revoked_at = statement_timestamp() WHERE id = $1', [inviteId]);
        await recordAdminAction(manager, actorId, 'invite_revoked', inviteId, invite.target_email);
      }
      return { revoked: true as const };
    });
  }

  function listUsers(actor: User, query: AdminUserQuery) {
    requireAdmin(actor);
    return readPage(db, query, `
      SELECT ${userFields} FROM users WHERE $3 = '' OR strpos(lower(email), lower($3)) > 0 OR strpos(lower(name), lower($3)) > 0
    `, 'email, id', [query.q], userSummary);
  }

  async function updateUser(actorId: string, userId: string, input: AdminUserUpdate) {
    return changeAsAdmin(db, actorId, async (manager) => {
      const [user] = await manager.query<UserRow[]>(`SELECT ${userFields} FROM users WHERE id = $1 FOR UPDATE`, [userId]);
      if (!user) throw notFound();
      const role = input.role ?? user.role;
      const disabled = input.disabled ?? user.disabled_at !== null;
      const quota = input.quotaBytes !== undefined ? BigInt(input.quotaBytes) : BigInt(user.quota_bytes);
      const roleChanged = role !== user.role;
      const statusChanged = disabled !== (user.disabled_at !== null);
      const quotaChanged = quota !== BigInt(user.quota_bytes);
      if (quota < BigInt(user.used_bytes)) throw new ApiError(409, 'QUOTA_BELOW_USAGE', 'Quota cannot be below current usage.');
      if (!roleChanged && !statusChanged && !quotaChanged) return userSummary(user);
      if (user.role === 'admin' && user.disabled_at === null && (disabled || role !== 'admin')) {
        const [replacement] = await manager.query<{ id: string }[]>(`
          SELECT id FROM users WHERE id <> $1 AND role = 'admin' AND disabled_at IS NULL LIMIT 1
        `, [userId]);
        if (!replacement) throw new ApiError(409, 'LAST_ACTIVE_ADMIN', 'The last active administrator must remain active.');
      }
      const [updated] = await manager.query<UserRow[]>(`WITH changed AS (
        UPDATE users SET role = $2, quota_bytes = $3,
          disabled_at = CASE WHEN $4::boolean THEN COALESCE(disabled_at, statement_timestamp()) ELSE NULL END
        WHERE id = $1 RETURNING ${userFields}
      ) SELECT * FROM changed`, [userId, role, quota.toString(), disabled]);
      if (!updated) throw notFound();
      if (roleChanged || (statusChanged && disabled)) await invalidateSessions(manager, userId);
      if (roleChanged) await recordAdminAction(manager, actorId, 'account_role_changed', userId, user.email);
      if (statusChanged) await recordAdminAction(manager, actorId, disabled ? 'account_disabled' : 'account_enabled', userId, user.email);
      if (quotaChanged) await recordAdminAction(manager, actorId, 'account_quota_changed', userId, user.email);
      return userSummary(updated);
    });
  }

  async function issuePasswordReset(actorId: string, userId: string) {
    const token = randomBytes(32).toString('base64url');
    return changeAsAdmin(db, actorId, async (manager) => {
      const [target] = await manager.query<{ email: string }[]>('SELECT email FROM users WHERE id = $1', [userId]);
      if (!target) throw notFound();
      await manager.query(`
        UPDATE account_links SET revoked_at = statement_timestamp()
        WHERE kind = 'reset' AND target_user_id = $1 AND used_at IS NULL AND revoked_at IS NULL
          AND expires_at > statement_timestamp()
      `, [userId]);
      const [link] = await manager.query<{ expires_at: Date }[]>(`
        INSERT INTO account_links (kind, token_hash, target_user_id, expires_at)
        VALUES ('reset', $1, $2, statement_timestamp() + INTERVAL '30 minutes') RETURNING expires_at
      `, [tokenHash(token), userId]);
      if (!link) throw new Error('Password reset insert returned no record');
      await recordAdminAction(manager, actorId, 'password_reset_issued', userId, target.email);
      return { token, expiresAt: link.expires_at.toISOString() };
    });
  }

  function listAudit(actor: User, page: Page) {
    requireAdmin(actor);
    return readPage(db, page, `
      SELECT a.id, a.actor_id, u.email AS actor_email, a.action, a.target_id, a.target_email, a.created_at
      FROM admin_audit a JOIN users u ON u.id = a.actor_id
    `, 'created_at DESC, id', [], (row: AuditRow) => ({
      id: row.id, actorId: row.actor_id, actorEmail: row.actor_email, action: row.action,
      targetId: row.target_id, targetEmail: row.target_email, createdAt: new Date(row.created_at).toISOString(),
    }));
  }

  return { listInvites, createInvite, revokeInvite, listUsers, updateUser, issuePasswordReset, listAudit };
}
