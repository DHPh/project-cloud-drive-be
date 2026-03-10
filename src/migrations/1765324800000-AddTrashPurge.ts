import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTrashPurge1765324800000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    for (const table of ['files', 'folders']) {
      await runner.query(`ALTER TABLE ${table} ADD COLUMN trash_event_id uuid`);
      await runner.query(`UPDATE ${table} SET trash_event_id = gen_random_uuid() WHERE trashed_at IS NOT NULL`);
      await runner.query(`ALTER TABLE ${table} ADD CHECK (trashed_at IS NULL OR trash_event_id IS NOT NULL)`);
      await runner.query(`
        CREATE INDEX ${table}_trash_expiry ON ${table}(trashed_at, id) WHERE trashed_at IS NOT NULL
      `);
    }
    await runner.query(`
      CREATE TABLE trash_retention_policy (
        singleton boolean PRIMARY KEY CHECK (singleton),
        activated_at timestamptz NOT NULL
      )
    `);
    await runner.query(`
      CREATE TABLE trash_purge_jobs (
        trash_event_id uuid PRIMARY KEY,
        owner_id uuid NOT NULL REFERENCES users(id),
        item_kind text NOT NULL CHECK (item_kind IN ('file', 'folder')),
        item_id uuid NOT NULL,
        queued_at timestamptz NOT NULL DEFAULT statement_timestamp(),
        attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at timestamptz NOT NULL DEFAULT statement_timestamp(),
        completed_at timestamptz
      )
    `);
    await runner.query(`
      CREATE INDEX trash_purge_jobs_pending ON trash_purge_jobs(next_attempt_at, queued_at, trash_event_id)
      WHERE completed_at IS NULL
    `);
    await runner.query(`
      CREATE TABLE trash_purge_files (
        file_id uuid PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
        trash_event_id uuid NOT NULL REFERENCES trash_purge_jobs(trash_event_id),
        attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at timestamptz NOT NULL DEFAULT statement_timestamp()
      )
    `);
    await runner.query('CREATE INDEX trash_purge_files_by_job ON trash_purge_files(trash_event_id)');
    await runner.query('CREATE INDEX trash_purge_files_due ON trash_purge_files(next_attempt_at, file_id)');
    await runner.query(`
      CREATE TABLE trash_empty_requests (
        owner_id uuid NOT NULL REFERENCES users(id),
        request_id uuid NOT NULL,
        accepted_count integer NOT NULL CHECK (accepted_count >= 0),
        PRIMARY KEY (owner_id, request_id)
      )
    `);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('LOCK TABLE trash_purge_jobs IN ACCESS EXCLUSIVE MODE');
    const [queued] = await runner.query(`
      SELECT EXISTS (SELECT 1 FROM trash_purge_jobs WHERE completed_at IS NULL) AS exists
    `) as { exists: boolean }[];
    if (queued?.exists) throw new Error('Complete queued Trash purges before reverting this migration.');
    await runner.query('DROP TABLE trash_empty_requests, trash_purge_files, trash_purge_jobs, trash_retention_policy');
    for (const table of ['files', 'folders']) {
      await runner.query(`DROP INDEX ${table}_trash_expiry`);
      await runner.query(`ALTER TABLE ${table} DROP COLUMN trash_event_id`);
    }
  }
}
