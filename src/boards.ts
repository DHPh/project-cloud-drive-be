import { randomUUID } from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';
import { lockAccountAdministration, recordAdminAction } from './accounts';
import { ApiError, invalidRequest, notFound, sessionRequired } from './errors';
import { fileParentIsActive, lockFolderTree } from './folder-tree';

export type BoardVisibility = 'draft' | 'link' | 'discoverable';
type Page = { page: number; limit: number };
type BoardRow = {
  id: string;
  public_id: string;
  title: string;
  description: string | null;
  visibility: BoardVisibility;
  hidden_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};
type PublicBoardRow = Pick<BoardRow, 'public_id' | 'title' | 'description'>;
type ItemFields = {
  id: string;
  original_name: string;
  mime_type: string;
  size_bytes: string | number;
  allow_download: boolean;
};
type OwnedItemRow = ItemFields & {
  file_id: string;
  position: number;
  published: boolean;
  available: boolean;
};

export const maxBoardItems = 100;

const boardFields = 'id, public_id, title, description, visibility, hidden_at, created_at, updated_at';
const activeFile = `f.upload_state = 'ready' AND f.trashed_at IS NULL AND ${fileParentIsActive('f')}`;
const itemFields = 'i.id, f.original_name, f.mime_type, f.size_bytes, i.allow_download';
const publicBoardFields = 'b.public_id, b.title, b.description';
const publicBoardVisible = "b.visibility IN ('link', 'discoverable') AND b.hidden_at IS NULL AND u.disabled_at IS NULL";
const publicItemVisible = `i.published AND f.owner_id = b.owner_id AND ${activeFile}`;
const excerptTypes = new Set([
  'text/plain', 'text/markdown', 'text/csv', 'text/javascript', 'text/x-python', 'text/x-typescript',
  'text/x-shellscript', 'application/json', 'application/javascript',
]);

export function supportsBoardExcerpt(mimeType: string) {
  return excerptTypes.has(mimeType);
}

function boardSummary(row: BoardRow) {
  return {
    id: row.id, publicId: row.public_id, title: row.title, description: row.description,
    visibility: row.visibility, hiddenAt: row.hidden_at ? new Date(row.hidden_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function publicBoardSummary(row: PublicBoardRow) {
  return { publicId: row.public_id, title: row.title, description: row.description };
}

function publicItemSummary(row: ItemFields) {
  return {
    id: row.id, originalName: row.original_name, mimeType: row.mime_type, size: Number(row.size_bytes),
    allowDownload: row.allow_download, canPreview: supportsBoardExcerpt(row.mime_type),
  };
}

function ownedItemSummary(row: OwnedItemRow) {
  return {
    ...publicItemSummary(row), fileId: row.file_id, position: row.position,
    published: row.published, available: row.available,
  };
}

async function pageRows<Row>(db: DataSource, page: Page, matches: string, filters: unknown[]) {
  const { page: number, limit } = page;
  const offset = (BigInt(number - 1) * BigInt(limit)).toString();
  const [result] = await db.query<{ total: string; items: Row[] }[]>(`
    WITH matching AS NOT MATERIALIZED (${matches}), selected AS (
      SELECT * FROM matching ORDER BY updated_at DESC, public_id
      LIMIT $${filters.length + 1} OFFSET $${filters.length + 2}::bigint
    )
    SELECT (SELECT count(*) FROM matching) AS total,
      COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY updated_at DESC, public_id) FROM selected s), '[]') AS items
  `, [...filters, limit, offset]);
  if (!result) throw new Error('Board listing did not return a summary');
  const total = Number(result.total);
  return { items: result.items, pagination: { page: number, limit, total, totalPages: Math.ceil(total / limit) } };
}

async function requireOwnerBoard(manager: EntityManager, ownerId: string, boardId: string) {
  const [board] = await manager.query<BoardRow[]>(`
    SELECT ${boardFields} FROM boards
    WHERE id = $1 AND owner_id = $2 AND EXISTS (SELECT 1 FROM users WHERE id = $2 AND disabled_at IS NULL)
    FOR UPDATE
  `, [boardId, ownerId]);
  if (!board) throw notFound();
  return board;
}

async function requireOwnerFile(manager: EntityManager, ownerId: string, fileId: string) {
  const [file] = await manager.query<{ original_name: string; mime_type: string; size_bytes: string }[]>(`
    SELECT f.original_name, f.mime_type, f.size_bytes FROM files f
    WHERE f.id = $1 AND f.owner_id = $2 AND ${activeFile}
  `, [fileId, ownerId]);
  if (!file) throw notFound();
  return file;
}

async function requireAdmin(manager: EntityManager, actorId: string) {
  await lockAccountAdministration(manager);
  const [actor] = await manager.query<{ role: string }[]>(
    'SELECT role FROM users WHERE id = $1 AND disabled_at IS NULL', [actorId]
  );
  if (!actor) throw sessionRequired();
  if (actor.role !== 'admin') throw new ApiError(403, 'FORBIDDEN', 'Only administrators can moderate boards.');
}

export function createBoards(db: DataSource) {
  async function ownedList(ownerId: string, page: Page) {
    const { items, pagination } = await pageRows<BoardRow>(db, page,
      `SELECT ${boardFields} FROM boards WHERE owner_id = $1`, [ownerId]);
    return { data: { items: items.map(boardSummary) }, pagination };
  }

  async function ownedGet(ownerId: string, boardId: string) {
    const [board] = await db.query<BoardRow[]>(`
      SELECT ${boardFields} FROM boards
      WHERE id = $1 AND owner_id = $2 AND EXISTS (SELECT 1 FROM users WHERE id = $2 AND disabled_at IS NULL)
    `, [boardId, ownerId]);
    if (!board) throw notFound();
    const items = await db.query<OwnedItemRow[]>(`
      SELECT ${itemFields}, i.file_id, i.position, i.published, (${activeFile}) AS available
      FROM board_items i JOIN files f ON f.id = i.file_id
      WHERE i.board_id = $1 AND f.owner_id = $2 ORDER BY i.position, i.id LIMIT ${maxBoardItems}
    `, [boardId, ownerId]);
    return { ...boardSummary(board), items: items.map(ownedItemSummary) };
  }

  async function create(ownerId: string, title: string, description: string | null) {
    return db.transaction(async (manager) => {
      await lockFolderTree(manager, ownerId);
      const [board] = await manager.query<BoardRow[]>(`
        INSERT INTO boards (id, public_id, owner_id, title, description)
        SELECT $1, $2, u.id, $4, $5 FROM users u WHERE u.id = $3 AND u.disabled_at IS NULL
        RETURNING ${boardFields}
      `, [randomUUID(), randomUUID(), ownerId, title, description]);
      if (!board) throw sessionRequired();
      return boardSummary(board);
    });
  }

  async function update(ownerId: string, boardId: string, input: { title?: string; description?: string | null; visibility?: BoardVisibility }) {
    return db.transaction(async (manager) => {
      await lockFolderTree(manager, ownerId);
      const previous = await requireOwnerBoard(manager, ownerId, boardId);
      const title = input.title ?? previous.title;
      const description = input.description === undefined ? previous.description : input.description;
      const visibility = input.visibility ?? previous.visibility;
      if (title === previous.title && description === previous.description && visibility === previous.visibility) return boardSummary(previous);
      const [board] = await manager.query<BoardRow[]>(`
        WITH changed AS (
          UPDATE boards SET title = $2, description = $3, visibility = $4, updated_at = statement_timestamp()
          WHERE id = $1 RETURNING ${boardFields}
        ) SELECT * FROM changed
      `, [boardId, title, description, visibility]);
      if (!board) throw notFound();
      return boardSummary(board);
    });
  }

  async function remove(ownerId: string, boardId: string) {
    return db.transaction(async (manager) => {
      await lockFolderTree(manager, ownerId);
      await requireOwnerBoard(manager, ownerId, boardId);
      await manager.query('DELETE FROM boards WHERE id = $1', [boardId]);
      return { deleted: true as const };
    });
  }

  async function addItem(ownerId: string, boardId: string, fileId: string) {
    return db.transaction(async (manager) => {
      await lockFolderTree(manager, ownerId);
      await requireOwnerBoard(manager, ownerId, boardId);
      const file = await requireOwnerFile(manager, ownerId, fileId);
      const [set] = await manager.query<{ count: number; position: number; duplicate: boolean }[]>(`
        SELECT count(*)::integer AS count, coalesce(MAX(position) + 1, 0) AS position,
          COALESCE(bool_or(file_id = $2), false) AS duplicate FROM board_items WHERE board_id = $1
      `, [boardId, fileId]);
      if (!set) throw new Error('Board item count did not return a summary');
      if (set.duplicate) throw new ApiError(409, 'BOARD_ITEM_EXISTS', 'This file already belongs to the board.');
      if (set.count >= maxBoardItems) throw new ApiError(409, 'BOARD_ITEM_LIMIT', 'The board has reached its item limit.');
      const id = randomUUID();
      await manager.query('INSERT INTO board_items (id, board_id, file_id, position) VALUES ($1, $2, $3, $4)',
        [id, boardId, fileId, set.position]);
      return ownedItemSummary({ ...file, id, file_id: fileId, position: set.position, available: true, published: false, allow_download: false });
    });
  }

  async function updateItem(ownerId: string, boardId: string, itemId: string, input: { published?: boolean; allowDownload?: boolean }) {
    return db.transaction(async (manager) => {
      await lockFolderTree(manager, ownerId);
      await requireOwnerBoard(manager, ownerId, boardId);
      const [item] = await manager.query<OwnedItemRow[]>(`
        SELECT ${itemFields}, i.file_id, i.position, i.published, (${activeFile}) AS available
        FROM board_items i JOIN files f ON f.id = i.file_id
        WHERE i.board_id = $1 AND i.id = $2 AND f.owner_id = $3
      `, [boardId, itemId, ownerId]);
      if (!item || (input.published === true && !item.available)) throw notFound();
      const published = input.published ?? item.published;
      const allowDownload = input.allowDownload ?? item.allow_download;
      await manager.query('UPDATE board_items SET published = $2, allow_download = $3 WHERE id = $1', [itemId, published, allowDownload]);
      return ownedItemSummary({ ...item, published, allow_download: allowDownload });
    });
  }

  async function removeItem(ownerId: string, boardId: string, itemId: string) {
    return db.transaction(async (manager) => {
      await lockFolderTree(manager, ownerId);
      await requireOwnerBoard(manager, ownerId, boardId);
      const [deleted] = await manager.query<{ id: string }[]>(`
        WITH removed AS (DELETE FROM board_items WHERE board_id = $1 AND id = $2 RETURNING id)
        SELECT id FROM removed
      `, [boardId, itemId]);
      if (!deleted) throw notFound();
      return { deleted: true as const };
    });
  }

  async function orderItems(ownerId: string, boardId: string, itemIds: string[]) {
    return db.transaction(async (manager) => {
      await lockFolderTree(manager, ownerId);
      await requireOwnerBoard(manager, ownerId, boardId);
      const existing = await manager.query<{ id: string }[]>('SELECT id FROM board_items WHERE board_id = $1', [boardId]);
      const wanted = new Set(itemIds);
      if (wanted.size !== itemIds.length || wanted.size !== existing.length || existing.some(item => !wanted.has(item.id))) {
        throw invalidRequest();
      }
      await manager.query(`
        UPDATE board_items i SET position = (ordered.ordinality - 1)::integer
        FROM unnest($2::uuid[]) WITH ORDINALITY ordered(id, ordinality)
        WHERE i.board_id = $1 AND i.id = ordered.id
      `, [boardId, itemIds]);
      return { itemIds };
    });
  }

  async function publicList(page: Page) {
    const { items, pagination } = await pageRows<PublicBoardRow>(db, page, `
      SELECT ${publicBoardFields}, b.updated_at FROM boards b JOIN users u ON u.id = b.owner_id
      WHERE b.visibility = 'discoverable' AND b.hidden_at IS NULL AND u.disabled_at IS NULL
    `, []);
    return { data: { items: items.map(publicBoardSummary) }, pagination };
  }

  async function publicGet(publicId: string) {
    const [board] = await db.query<(PublicBoardRow & { items: ItemFields[] })[]>(`
      WITH b AS (
        SELECT candidate.* FROM boards candidate JOIN users u ON u.id = candidate.owner_id
        WHERE candidate.public_id = $1 AND candidate.visibility IN ('link', 'discoverable')
          AND candidate.hidden_at IS NULL AND u.disabled_at IS NULL
      ), visible AS (
        SELECT ${itemFields}, i.position FROM b JOIN board_items i ON i.board_id = b.id
        JOIN files f ON f.id = i.file_id WHERE ${publicItemVisible}
        ORDER BY i.position, i.id LIMIT ${maxBoardItems}
      )
      SELECT ${publicBoardFields}, COALESCE((SELECT jsonb_agg(to_jsonb(v) ORDER BY v.position, v.id) FROM visible v), '[]') AS items
      FROM b
    `, [publicId]);
    if (!board) throw notFound();
    return { ...publicBoardSummary(board), items: board.items.map(publicItemSummary) };
  }

  async function publicObject(publicId: string, itemId: string) {
    const [asset] = await db.query<(ItemFields & { object_key: string })[]>(`
      SELECT ${itemFields}, f.object_key FROM boards b JOIN users u ON u.id = b.owner_id
      JOIN board_items i ON i.board_id = b.id JOIN files f ON f.id = i.file_id
      WHERE b.public_id = $1 AND i.id = $2 AND ${publicBoardVisible} AND ${publicItemVisible}
    `, [publicId, itemId]);
    if (!asset) throw notFound();
    return asset;
  }

  async function moderatorList(actor: { role: 'user' | 'admin' }, page: Page) {
    if (actor.role !== 'admin') throw new ApiError(403, 'FORBIDDEN', 'Only administrators can moderate boards.');
    const { items, pagination } = await pageRows<BoardRow>(db, page,
      `SELECT ${boardFields} FROM boards WHERE visibility IN ('link', 'discoverable')`, []);
    return { data: { items: items.map(row => ({
      id: row.id, publicId: row.public_id, title: row.title, visibility: row.visibility,
      hiddenAt: row.hidden_at ? new Date(row.hidden_at).toISOString() : null,
    })) }, pagination };
  }

  async function hide(actorId: string, boardId: string) {
    return db.transaction(async (manager) => {
      await requireAdmin(manager, actorId);
      const [target] = await manager.query<{ owner_id: string }[]>('SELECT owner_id FROM boards WHERE id = $1', [boardId]);
      if (!target) throw notFound();
      await lockFolderTree(manager, target.owner_id);
      const [board] = await manager.query<{ hidden_at: Date | null }[]>(`
        SELECT hidden_at FROM boards WHERE id = $1 AND (visibility IN ('link', 'discoverable') OR hidden_at IS NOT NULL)
        FOR UPDATE
      `, [boardId]);
      if (!board) throw notFound();
      if (board.hidden_at) return { hiddenAt: board.hidden_at.toISOString() };
      const [hidden] = await manager.query<{ hidden_at: Date }[]>(`
        WITH changed AS (UPDATE boards SET hidden_at = statement_timestamp() WHERE id = $1 RETURNING hidden_at)
        SELECT hidden_at FROM changed
      `, [boardId]);
      if (!hidden) throw notFound();
      await recordAdminAction(manager, actorId, 'board_hidden', boardId, null);
      return { hiddenAt: hidden.hidden_at.toISOString() };
    });
  }

  return { ownedList, ownedGet, create, update, remove, addItem, updateItem, removeItem, orderItems,
    publicList, publicGet, publicObject, moderatorList, hide };
}
