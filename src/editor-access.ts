import type { DataSource, EntityManager } from 'typeorm';
import { notFound } from './errors';
import { fileParentIsActive } from './folder-tree';

type Database = DataSource | EntityManager;
type Parameter = '$2' | '$3' | '$6' | '$9';

export function folderEditorGrant(id: 'f.id' | 'f.folder_id' | 'files.folder_id', owner: 'f.owner_id' | 'files.owner_id', actor: Parameter): string {
  return `EXISTS (
    SELECT 1 FROM drive_folder_ancestors(${id}, ${owner}) a
    JOIN folder_shares s ON s.folder_id = a.folder_id
    WHERE s.recipient_id = ${actor} AND s.access = 'editor' AND s.expires_at > statement_timestamp()
  )`;
}

export function fileEditorGrant(file: 'f' | 'files', actor: Parameter): string {
  return `(EXISTS (
    SELECT 1 FROM file_shares s WHERE s.file_id = ${file}.id
      AND s.recipient_id = ${actor} AND s.access = 'editor' AND s.expires_at > statement_timestamp()
  ) OR ${folderEditorGrant(file === 'f' ? 'f.folder_id' : 'files.folder_id', file === 'f' ? 'f.owner_id' : 'files.owner_id', actor)})`;
}

export async function findEditableFolderOwner(db: Database, actorId: string, folderId: string) {
  const [folder] = await db.query<{ owner_id: string }[]>(`
    SELECT f.owner_id FROM folders f JOIN users u ON u.id = f.owner_id
    WHERE f.id = $1 AND u.disabled_at IS NULL AND f.trash_root_id IS NULL
      AND EXISTS (SELECT 1 FROM users actor WHERE actor.id = $2 AND actor.disabled_at IS NULL)
      AND (f.owner_id = $2 OR ${folderEditorGrant('f.id', 'f.owner_id', '$2')})
  `, [folderId, actorId]);
  return folder?.owner_id;
}

export async function editableFolderOwner(db: Database, actorId: string, folderId: string) {
  const ownerId = await findEditableFolderOwner(db, actorId, folderId);
  if (!ownerId) throw notFound();
  return ownerId;
}

export async function editableFileOwner(db: Database, actorId: string, fileId: string) {
  const [file] = await db.query<{ owner_id: string }[]>(`
    SELECT f.owner_id FROM files f JOIN users u ON u.id = f.owner_id
    WHERE f.id = $1 AND u.disabled_at IS NULL AND f.upload_state = 'ready' AND f.trashed_at IS NULL
      AND EXISTS (SELECT 1 FROM users actor WHERE actor.id = $2 AND actor.disabled_at IS NULL)
      AND ${fileParentIsActive('f')} AND (f.owner_id = $2 OR ${fileEditorGrant('f', '$2')})
  `, [fileId, actorId]);
  if (!file) throw notFound();
  return file.owner_id;
}
