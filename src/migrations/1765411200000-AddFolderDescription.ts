import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddFolderDescription1765411200000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      ALTER TABLE folders ADD COLUMN description text
        CONSTRAINT folders_description_length CHECK (char_length(description) <= 2000)
    `);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE folders DROP COLUMN description');
  }
}
