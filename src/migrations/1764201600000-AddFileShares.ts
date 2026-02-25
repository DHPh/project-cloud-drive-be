import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddFileShares1764201600000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      CREATE FUNCTION default_file_share_expiry(granted_at timestamptz)
      RETURNS timestamptz LANGUAGE sql STABLE STRICT AS $$
        SELECT ((granted_at AT TIME ZONE 'Asia/Ho_Chi_Minh') + INTERVAL '1 month')
          AT TIME ZONE 'Asia/Ho_Chi_Minh'
      $$
    `);
    await runner.query(`
      CREATE TABLE file_shares (
        file_id uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        recipient_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        granted_at timestamptz NOT NULL,
        expires_at timestamptz NOT NULL CHECK (expires_at > granted_at),
        PRIMARY KEY(file_id, recipient_id)
      )
    `);
    await runner.query('CREATE INDEX file_shares_owner_listing ON file_shares(file_id, granted_at DESC, recipient_id)');
    await runner.query('CREATE INDEX file_shares_recipient_listing ON file_shares(recipient_id, granted_at DESC, file_id)');
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE file_shares');
    await runner.query('DROP FUNCTION default_file_share_expiry(timestamptz)');
  }
}
