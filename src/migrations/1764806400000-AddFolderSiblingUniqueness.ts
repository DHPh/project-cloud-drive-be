import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddFolderSiblingUniqueness1764806400000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      CREATE UNIQUE INDEX folders_sibling_name_unique
      ON folders(owner_id, parent_id, name COLLATE "C") NULLS NOT DISTINCT
    `);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP INDEX folders_sibling_name_unique');
  }
}
