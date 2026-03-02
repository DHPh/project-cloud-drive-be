import type { EntityManager } from 'typeorm';
import { notFound } from './errors';

export async function lockFolderTree(manager: EntityManager, ownerId: string): Promise<void> {
  // Take this lock before reading or writing folder topology, and before any file row lock.
  await manager.query("SELECT pg_advisory_xact_lock(hashtextextended('folder-tree:' || $1::uuid::text, 0))", [ownerId]);
}

export async function requireOwnedFolder(manager: EntityManager, ownerId: string, folderId: string): Promise<void> {
  const [folder] = await manager.query<{ id: string }[]>(
    'SELECT id FROM folders WHERE id = $1 AND owner_id = $2', [folderId, ownerId]
  );
  if (!folder) throw notFound();
}
