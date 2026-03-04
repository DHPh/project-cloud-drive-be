import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddFolderTrash1765238400000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      ALTER TABLE folders
        ADD COLUMN trash_root_id uuid,
        ADD COLUMN trashed_at timestamptz,
        ADD CONSTRAINT folders_trash_same_owner
          FOREIGN KEY (trash_root_id, owner_id) REFERENCES folders(id, owner_id),
        ADD CONSTRAINT folders_trash_root_timestamp
          CHECK ((trashed_at IS NOT NULL) = (trash_root_id IS NOT NULL AND trash_root_id = id))
    `);
    await runner.query('DROP INDEX folders_sibling_name_unique');
    await runner.query(`
      CREATE UNIQUE INDEX folders_sibling_name_unique
      ON folders(owner_id, parent_id, name COLLATE "C") NULLS NOT DISTINCT
      WHERE trash_root_id IS NULL
    `);
    await runner.query(`
      CREATE INDEX folders_trash ON folders(owner_id, trashed_at DESC, id) WHERE trashed_at IS NOT NULL
    `);
    await runner.query(`
      CREATE INDEX folders_trash_batch ON folders(owner_id, trash_root_id) WHERE trash_root_id IS NOT NULL
    `);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('LOCK TABLE folders IN ACCESS EXCLUSIVE MODE');
    const [trash] = await runner.query(`
      SELECT EXISTS (SELECT 1 FROM folders WHERE trash_root_id IS NOT NULL) AS exists
    `) as { exists: boolean }[];
    if (trash?.exists) throw new Error('Restore folder trash before reverting this migration.');
    await runner.query('DROP INDEX folders_trash_batch');
    await runner.query('DROP INDEX folders_trash');
    await runner.query('DROP INDEX folders_sibling_name_unique');
    await runner.query(`
      CREATE UNIQUE INDEX folders_sibling_name_unique
      ON folders(owner_id, parent_id, name COLLATE "C") NULLS NOT DISTINCT
    `);
    await runner.query('ALTER TABLE folders DROP COLUMN trash_root_id, DROP COLUMN trashed_at');
  }
}
