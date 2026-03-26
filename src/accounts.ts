import type { DataSource, EntityManager } from 'typeorm';
import { ApiError, sessionRequired } from './errors';
import { hashPassword, publicUser, tokenHash, verifyPassword, type User } from './session';

type StorageRow = User & { used_bytes: string; quota_bytes: string; trashed_bytes: string };
type AccountLinkRow = {
  id: string; target_email: string | null; target_user_id: string | null;
  used_at: Date | null; revoked_at: Date | null; expired: boolean;
};

export const accountLinkNotFound = () => new ApiError(404, 'ACCOUNT_LINK_NOT_FOUND', 'This account link was not found.');
export const accountLinkUsed = () => new ApiError(409, 'ACCOUNT_LINK_USED', 'This account link was already used.');
export const accountEmailConflict = () => new ApiError(409, 'ACCOUNT_EMAIL_CONFLICT', 'An account already exists for this email.');

export function lockAccountAdministration(manager: EntityManager): Promise<unknown> {
  return manager.query("SELECT pg_advisory_xact_lock(hashtextextended('accounts:administration', 0))");
}

export function recordAdminAction(
  manager: EntityManager, actorId: string, action: string, targetId: string | null, targetEmail: string | null
): Promise<unknown> {
  return manager.query(`
    INSERT INTO admin_audit (actor_id, action, target_id, target_email) VALUES ($1, $2, $3, $4)
  `, [actorId, action, targetId, targetEmail]);
}

export function invalidateSessions(manager: EntityManager, userId: string): Promise<unknown> {
  return manager.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
}

async function readAccount(connection: DataSource | EntityManager, userId: string) {
  const [row] = await connection.query<StorageRow[]>(`
    SELECT u.id, u.email, u.name, u.role, u.used_bytes, u.quota_bytes,
      (SELECT COALESCE(sum(f.size_bytes), 0) FROM files f LEFT JOIN folders p ON p.id = f.folder_id
       WHERE f.owner_id = u.id AND (f.trashed_at IS NOT NULL OR p.trash_root_id IS NOT NULL)) AS trashed_bytes
    FROM users u WHERE u.id = $1 AND u.disabled_at IS NULL
  `, [userId]);
  if (!row) throw sessionRequired();
  return {
    user: publicUser(row),
    storage: { usedBytes: Number(row.used_bytes), trashedBytes: Number(row.trashed_bytes), quotaBytes: Number(row.quota_bytes) },
  };
}

async function requireLink(connection: DataSource | EntityManager, hash: string, kind: 'invite' | 'reset', lock = false) {
  const [link] = await connection.query<AccountLinkRow[]>(`
    SELECT id, target_email, target_user_id, used_at, revoked_at, expires_at <= statement_timestamp() AS expired
    FROM account_links WHERE token_hash = $1 AND kind = $2 ${lock ? 'FOR UPDATE' : ''}
  `, [hash, kind]);
  if (!link) throw accountLinkNotFound();
  if (link.used_at) throw accountLinkUsed();
  if (link.revoked_at) throw new ApiError(409, 'ACCOUNT_LINK_REVOKED', 'This account link was revoked.');
  if (link.expired) throw new ApiError(410, 'ACCOUNT_LINK_EXPIRED', 'This account link expired.');
  return link;
}

async function revokeResetLinks(manager: EntityManager, userId: string) {
  await manager.query(`
    UPDATE account_links SET revoked_at = statement_timestamp()
    WHERE target_user_id = $1 AND kind = 'reset' AND used_at IS NULL AND revoked_at IS NULL
      AND expires_at > statement_timestamp()
  `, [userId]);
}

export function createAccounts(db: DataSource) {
  function get(userId: string) { return readAccount(db, userId); }

  async function setName(userId: string, name: string) {
    return db.transaction(async (manager) => {
      await manager.query('UPDATE users SET name = $2 WHERE id = $1 AND disabled_at IS NULL', [userId, name]);
      return readAccount(manager, userId);
    });
  }

  async function changePassword(userId: string, currentPassword: string, password: string) {
    const invalidPassword = () => new ApiError(403, 'CURRENT_PASSWORD_INVALID', 'The current password is incorrect.');
    const [user] = await db.query<{ password_hash: string }[]>(`
      SELECT password_hash FROM users WHERE id = $1 AND disabled_at IS NULL
    `, [userId]);
    if (!user) throw sessionRequired();
    if (!await verifyPassword(currentPassword, user.password_hash)) throw invalidPassword();
    const passwordHash = await hashPassword(password);
    await db.transaction(async (manager) => {
      await lockAccountAdministration(manager);
      const [current] = await manager.query<{ password_hash: string; disabled_at: Date | null }[]>(`
        SELECT password_hash, disabled_at FROM users WHERE id = $1 FOR UPDATE
      `, [userId]);
      if (!current || current.disabled_at) throw sessionRequired();
      if (current.password_hash !== user.password_hash) throw invalidPassword();
      await manager.query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, passwordHash]);
      await invalidateSessions(manager, userId);
      await revokeResetLinks(manager, userId);
    });
  }

  async function acceptInvite(token: string, name: string, password: string) {
    const hash = tokenHash(token);
    await requireLink(db, hash, 'invite');
    const passwordHash = await hashPassword(password);
    return db.transaction(async (manager) => {
      await lockAccountAdministration(manager);
      const link = await requireLink(manager, hash, 'invite', true);
      const [user] = await manager.query<User[]>(`
        INSERT INTO users (id, email, name, password_hash) VALUES (gen_random_uuid(), $1, $2, $3)
        ON CONFLICT (email) DO NOTHING RETURNING id, email, name, role
      `, [link.target_email, name, passwordHash]);
      if (!user) throw accountEmailConflict();
      await manager.query('UPDATE account_links SET used_at = statement_timestamp() WHERE id = $1', [link.id]);
      await recordAdminAction(manager, user.id, 'invite_accepted', user.id, user.email);
      return user;
    });
  }

  async function resetPassword(token: string, password: string) {
    const hash = tokenHash(token);
    await requireLink(db, hash, 'reset');
    const passwordHash = await hashPassword(password);
    await db.transaction(async (manager) => {
      await lockAccountAdministration(manager);
      const link = await requireLink(manager, hash, 'reset', true);
      const userId = link.target_user_id;
      if (!userId) throw accountLinkNotFound();
      const [user] = await manager.query<User[]>(`WITH changed AS (
        UPDATE users SET password_hash = $2 WHERE id = $1 RETURNING id, email, name, role
      ) SELECT * FROM changed`, [userId, passwordHash]);
      if (!user) throw accountLinkNotFound();
      await manager.query('UPDATE account_links SET used_at = statement_timestamp() WHERE id = $1', [link.id]);
      await invalidateSessions(manager, userId);
      await recordAdminAction(manager, userId, 'password_reset_completed', userId, user.email);
    });
  }

  return { get, setName, changePassword, acceptInvite, resetPassword };
}
