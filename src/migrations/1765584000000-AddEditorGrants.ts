import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEditorGrants1765584000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query("ALTER TABLE file_shares ADD COLUMN access text NOT NULL DEFAULT 'viewer' CHECK (access IN ('viewer', 'editor'))");
    await runner.query("ALTER TABLE folder_shares ADD COLUMN access text NOT NULL DEFAULT 'viewer' CHECK (access IN ('viewer', 'editor'))");
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE folder_shares DROP COLUMN access');
    await runner.query('ALTER TABLE file_shares DROP COLUMN access');
  }
}
