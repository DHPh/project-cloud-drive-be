import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddFolderShares1765152000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      CREATE TABLE folder_shares (
        folder_id uuid NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
        recipient_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        granted_at timestamptz NOT NULL,
        expires_at timestamptz NOT NULL CHECK (expires_at > granted_at),
        PRIMARY KEY(folder_id, recipient_id)
      )
    `);
    await runner.query(
      'CREATE INDEX folder_shares_owner_listing ON folder_shares(folder_id, granted_at DESC, recipient_id)'
    );
    await runner.query(
      'CREATE INDEX folder_shares_recipient_listing ON folder_shares(recipient_id, granted_at DESC, folder_id)'
    );
    await runner.query(`
      CREATE FUNCTION drive_folder_ancestors(start_id uuid, tree_owner_id uuid)
      RETURNS TABLE(folder_id uuid, distance integer)
      LANGUAGE sql STABLE STRICT AS $$
        WITH RECURSIVE lineage AS (
          SELECT f.id, f.parent_id, 0 AS depth, ARRAY[f.id] AS visited
          FROM folders f WHERE f.id = start_id AND f.owner_id = tree_owner_id
          UNION ALL
          SELECT f.id, f.parent_id, a.depth + 1, a.visited || f.id
          FROM lineage a JOIN folders f ON f.id = a.parent_id AND f.owner_id = tree_owner_id
          WHERE NOT f.id = ANY(a.visited)
        )
        SELECT id, depth FROM lineage
      $$
    `);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP FUNCTION drive_folder_ancestors(uuid, uuid)');
    await runner.query('DROP TABLE folder_shares');
  }
}
