import type { MigrationInterface, QueryRunner } from 'typeorm';

export class Baseline1762214400000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(
      'CREATE TABLE users (' +
      'id uuid PRIMARY KEY, email text NOT NULL UNIQUE, name text NOT NULL, ' +
      'password_hash text NOT NULL, ' +
      'quota_bytes bigint NOT NULL CHECK (quota_bytes >= 0), ' +
      'used_bytes bigint NOT NULL DEFAULT 0 CHECK (used_bytes >= 0 AND used_bytes <= quota_bytes)' +
      ')'
    );
    await runner.query(
      'CREATE TABLE sessions (' +
      'token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, ' +
      'expires_at timestamptz NOT NULL' +
      ')'
    );
    await runner.query('CREATE INDEX sessions_expiry ON sessions(expires_at)');
    await runner.query(
      'CREATE TABLE folders (' +
      'id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id), parent_id uuid, ' +
      'name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255), ' +
      'created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), ' +
      'UNIQUE (id, owner_id), CHECK (parent_id IS DISTINCT FROM id), ' +
      'FOREIGN KEY (parent_id, owner_id) REFERENCES folders(id, owner_id)' +
      ')'
    );
    await runner.query('CREATE INDEX folders_children ON folders(owner_id, parent_id, lower(name), id)');
    await runner.query(
      'CREATE TABLE files (' +
      'id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id), folder_id uuid, ' +
      'original_name text NOT NULL CHECK (char_length(original_name) BETWEEN 1 AND 255), ' +
      'mime_type text NOT NULL, size_bytes bigint NOT NULL CHECK (size_bytes >= 0), ' +
      'description text CHECK (char_length(description) <= 2000), ' +
      "tags text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 20), " +
      'object_key text NOT NULL UNIQUE, ' +
      "upload_state text NOT NULL CHECK (upload_state IN ('pending', 'ready', 'cleanup')), " +
      'created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), ' +
      'FOREIGN KEY (folder_id, owner_id) REFERENCES folders(id, owner_id)' +
      ')'
    );
    await runner.query(
      "CREATE INDEX files_children ON files(owner_id, folder_id, lower(original_name), id) WHERE upload_state = 'ready'"
    );
    await runner.query(
      "CREATE INDEX files_recovery ON files(updated_at) WHERE upload_state <> 'ready'"
    );
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE files');
    await runner.query('DROP TABLE folders');
    await runner.query('DROP TABLE sessions');
    await runner.query('DROP TABLE users');
  }
}
