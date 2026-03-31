import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPublicBoards1765670400000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      CREATE TABLE boards (
        id uuid PRIMARY KEY,
        public_id uuid NOT NULL UNIQUE,
        owner_id uuid NOT NULL REFERENCES users(id),
        title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
        description text CHECK (char_length(description) <= 2000),
        visibility text NOT NULL DEFAULT 'draft' CHECK (visibility IN ('draft', 'link', 'discoverable')),
        hidden_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT statement_timestamp()
      )
    `);
    await runner.query('CREATE INDEX boards_owner_order ON boards(owner_id, updated_at DESC, id)');
    await runner.query(`
      CREATE INDEX boards_public_order ON boards(updated_at DESC, public_id)
      WHERE visibility = 'discoverable' AND hidden_at IS NULL
    `);
    await runner.query(`
      CREATE TABLE board_items (
        id uuid PRIMARY KEY,
        board_id uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        file_id uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        position integer NOT NULL CHECK (position >= 0),
        published boolean NOT NULL DEFAULT false,
        allow_download boolean NOT NULL DEFAULT false,
        UNIQUE(board_id, file_id),
        UNIQUE(board_id, position) DEFERRABLE INITIALLY DEFERRED
      )
    `);
    await runner.query('CREATE INDEX board_items_file ON board_items(file_id)');
    await runner.query(`
      CREATE FUNCTION unpublish_file_board_items() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        UPDATE board_items SET published = false WHERE file_id = NEW.id AND published;
        RETURN NEW;
      END;
      $$
    `);
    await runner.query(`
      CREATE TRIGGER unpublish_board_items_on_file_trash AFTER UPDATE OF trashed_at ON files
      FOR EACH ROW WHEN (OLD.trashed_at IS NULL AND NEW.trashed_at IS NOT NULL)
      EXECUTE FUNCTION unpublish_file_board_items()
    `);
    await runner.query(`
      CREATE FUNCTION unpublish_folder_board_items() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        UPDATE board_items i SET published = false FROM files f
        WHERE i.file_id = f.id AND f.folder_id = NEW.id AND i.published;
        RETURN NEW;
      END;
      $$
    `);
    await runner.query(`
      CREATE TRIGGER unpublish_board_items_on_folder_trash AFTER UPDATE OF trash_root_id ON folders
      FOR EACH ROW WHEN (OLD.trash_root_id IS NULL AND NEW.trash_root_id IS NOT NULL)
      EXECUTE FUNCTION unpublish_folder_board_items()
    `);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TRIGGER unpublish_board_items_on_folder_trash ON folders');
    await runner.query('DROP TRIGGER unpublish_board_items_on_file_trash ON files');
    await runner.query('DROP FUNCTION unpublish_folder_board_items()');
    await runner.query('DROP FUNCTION unpublish_file_board_items()');
    await runner.query('DROP TABLE board_items, boards');
  }
}
