import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddFileTrash1763683200000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      ALTER TABLE files
      ADD COLUMN trashed_at timestamptz,
      ADD CONSTRAINT files_trash_requires_ready CHECK (trashed_at IS NULL OR upload_state = 'ready')
    `);
    await runner.query(`
      CREATE INDEX files_trash ON files(owner_id, trashed_at DESC, id)
      WHERE upload_state = 'ready' AND trashed_at IS NOT NULL
    `);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP INDEX files_trash');
    await runner.query('ALTER TABLE files DROP COLUMN trashed_at');
  }
}
