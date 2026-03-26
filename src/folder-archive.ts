import { once } from 'node:events';
import { Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import archiver from 'archiver';
import type { DataSource } from 'typeorm';
import { ApiError, notFound } from './errors';
import type { createFiles } from './files';

type Files = Pick<ReturnType<typeof createFiles>, 'download'>;
type Directory = { id: string; parent_id: string | null; name: string };
type ArchiveFile = { id: string; folder_id: string; original_name: string; size_bytes: string };
type ArchiveRow = {
  name: string;
  file_count: string;
  folder_count: string;
  total_bytes: string;
  folders: Directory[];
  files: ArchiveFile[];
};

const maxFiles = 500;
const maxFolders = 500;
const maxBytes = 100 * 1024 * 1024;

function safeSegment(name: string): string {
  const encode = (text: string) => [...text].map((character) => '%' + character.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase()).join('');
  const escaped = name.replace(/[<>:"/\\|?*%\x00-\x1F\x7F]/g, encode).replace(/[. ]+$/g, encode);
  return /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(escaped) ? '_' + escaped : escaped;
}

function uniquePath(parent: string, name: string, claimed: Set<string>, preserveExtension = false): string {
  const segment = safeSegment(name);
  const extensionAt = preserveExtension ? segment.lastIndexOf('.') : -1;
  const base = extensionAt > 0 ? segment.slice(0, extensionAt) : segment;
  const extension = extensionAt > 0 ? segment.slice(extensionAt) : '';
  const join = (entry: string) => parent ? parent + '/' + entry : entry;
  let path = join(segment);
  for (let i = 2; claimed.has(path.toLowerCase()); i++) path = join(base + ' (' + i + ')' + extension);
  if (Buffer.byteLength(path) > 65_500) throw new ApiError(413, 'ARCHIVE_TOO_LARGE', 'Choose a smaller folder to download as ZIP.');
  claimed.add(path.toLowerCase());
  return path;
}

export async function prepareFolderArchive(db: DataSource, userId: string, folderId: string) {
  const [row] = await db.query<ArchiveRow[]>(`
    WITH RECURSIVE target AS (
      SELECT f.id, f.name, f.owner_id, f.parent_id
      FROM folders f JOIN users u ON u.id = f.owner_id
      WHERE f.id = $1 AND f.trash_root_id IS NULL AND u.disabled_at IS NULL AND (
        f.owner_id = $2 OR EXISTS (
          SELECT 1 FROM drive_folder_ancestors(f.id, f.owner_id) a
          JOIN folder_shares s ON s.folder_id = a.folder_id
          WHERE s.recipient_id = $2 AND s.expires_at > statement_timestamp()
        )
      )
    ), tree AS (
      SELECT id, parent_id, owner_id, name, 0 AS depth FROM target
      UNION ALL
      SELECT child.id, child.parent_id, child.owner_id, child.name, tree.depth + 1
      FROM tree JOIN folders child ON child.parent_id = tree.id AND child.owner_id = tree.owner_id
      WHERE child.trash_root_id IS NULL
    ), ready AS (
      SELECT f.id, f.folder_id, f.original_name, f.size_bytes
      FROM files f JOIN tree t ON t.id = f.folder_id AND t.owner_id = f.owner_id
      WHERE f.upload_state = 'ready' AND f.trashed_at IS NULL
    )
    SELECT target.name,
      (SELECT count(*) FROM ready) AS file_count,
      (SELECT count(*) FROM tree) AS folder_count,
      (SELECT COALESCE(sum(size_bytes), 0) FROM ready) AS total_bytes,
      (SELECT jsonb_agg(to_jsonb(dir) ORDER BY dir.depth, dir.name, dir.id)
        FROM (SELECT id, parent_id, name, depth FROM tree ORDER BY depth, name, id LIMIT $3) dir) AS folders,
      COALESCE((SELECT jsonb_agg(to_jsonb(file) ORDER BY file.original_name, file.id)
        FROM (SELECT id, folder_id, original_name, size_bytes FROM ready ORDER BY original_name, id LIMIT $4) file), '[]') AS files
    FROM target
  `, [folderId, userId, maxFolders, maxFiles]);
  if (!row) throw notFound();
  if (Number(row.file_count) > maxFiles || Number(row.folder_count) > maxFolders || Number(row.total_bytes) > maxBytes) {
    throw new ApiError(413, 'ARCHIVE_TOO_LARGE', 'Choose a smaller folder to download as ZIP.');
  }

  const claimed = new Set<string>();
  const directories = new Map<string, string>();
  for (const entry of row.folders) {
    const parent = entry.id === folderId ? '' : directories.get(entry.parent_id ?? '');
    if (parent === undefined) throw new Error('Folder is missing from archive manifest');
    directories.set(entry.id, uniquePath(parent, entry.name, claimed));
  }
  const files = row.files.map((entry) => {
    const parent = directories.get(entry.folder_id);
    if (parent === undefined) throw new Error('File parent is missing from archive manifest');
    return { id: entry.id, path: uniquePath(parent, entry.original_name, claimed, true), size: Number(entry.size_bytes) };
  });
  return { name: safeSegment(row.name) + '.zip', directories: [...directories.values()], files };
}

export async function writeFolderArchive(
  manifest: Awaited<ReturnType<typeof prepareFolderArchive>>, files: Files, userId: string, output: Writable
) {
  const zip = archiver('zip', { store: true });
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort();
  const onClose = () => { if (!output.writableFinished) cancel(); };
  output.once('close', onClose);
  const signal = cancellation.signal;
  const writing = pipeline(zip, output, { signal });
  const addEntries = async () => {
    for (const directory of manifest.directories) {
      const finished = once(zip, 'entry', { signal });
      zip.append(Buffer.alloc(0), { name: directory + '/' });
      await finished;
    }
    for (const file of manifest.files) {
      signal.throwIfAborted();
      const { stream } = await files.download(userId, file.id);
      const entry = Readable.from((async function* () {
        let bytes = 0;
        for await (const chunk of stream) {
          bytes += (chunk as Buffer).length;
          if (bytes > file.size) throw new Error('Archive object exceeds manifest size');
          yield chunk;
        }
        if (bytes !== file.size) throw new Error('Archive object is shorter than manifest');
      })(), { objectMode: false });
      const finished = once(zip, 'entry', { signal });
      const stopEntry = () => { entry.destroy(); stream.destroy(); };
      signal.addEventListener('abort', stopEntry, { once: true });
      try {
        zip.append(entry, { name: file.path });
        await finished;
      } finally {
        signal.removeEventListener('abort', stopEntry);
        stopEntry();
      }
    }
    await zip.finalize();
  };
  try {
    await Promise.all([writing, addEntries()]);
  } catch (error: unknown) {
    cancel();
    zip.destroy();
    throw error;
  } finally {
    output.off('close', onClose);
  }
}
