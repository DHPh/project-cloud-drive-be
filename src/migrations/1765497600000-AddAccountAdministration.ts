import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAccountAdministration1765497600000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      ALTER TABLE users
        ADD COLUMN role text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
        ADD COLUMN disabled_at timestamptz,
        ALTER COLUMN quota_bytes SET DEFAULT 1073741824
    `);
    await runner.query(`
      CREATE TABLE account_links (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        token_hash text NOT NULL UNIQUE,
        kind text NOT NULL CHECK (kind IN ('invite', 'reset')),
        target_email text,
        target_user_id uuid REFERENCES users(id),
        created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
        expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
        used_at timestamptz,
        revoked_at timestamptz,
        CHECK ((kind = 'invite' AND target_email IS NOT NULL AND target_user_id IS NULL) OR
          (kind = 'reset' AND target_email IS NULL AND target_user_id IS NOT NULL)),
        CHECK (used_at IS NULL OR revoked_at IS NULL)
      )
    `);
    await runner.query(`
      CREATE TABLE admin_audit (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        actor_id uuid NOT NULL REFERENCES users(id),
        action text NOT NULL,
        target_id uuid,
        target_email text,
        created_at timestamptz NOT NULL DEFAULT statement_timestamp()
      )
    `);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('LOCK TABLE users IN ACCESS EXCLUSIVE MODE');
    const [account] = await runner.query('SELECT 1 FROM users WHERE disabled_at IS NOT NULL LIMIT 1') as unknown[];
    if (account) throw new Error('Use a compatible snapshot to downgrade when disabled accounts exist.');
    await runner.query('DROP TABLE admin_audit, account_links');
    await runner.query('ALTER TABLE users DROP COLUMN role, DROP COLUMN disabled_at, ALTER COLUMN quota_bytes DROP DEFAULT');
  }
}
