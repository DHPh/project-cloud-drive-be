import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';
import test from 'node:test';
import { ApiError, notFound } from '../src/errors';
import { writeFolderArchive } from '../src/folder-archive';
import { getPreview } from '../src/preview';

function fixture(mimeType: string, body: Buffer, size = body.length) {
  const name = 'Tệp thử';
  return {
    async get() {
      return {
        kind: 'file' as const, id: 'file', originalName: name, folderId: null,
        mimeType, size, description: null, tags: [], access: 'owner' as const,
        createdAt: '2026-11-25T00:00:00.000Z', updatedAt: '2026-11-25T00:00:00.000Z',
      };
    },
    async download() { return { stream: Readable.from([body]), name, size: String(body.length) }; },
  };
}

test('PREVIEW-01 limits formats, inspects content and preserves authorization', async () => {
  const body = Buffer.from('Mô tả <b>tệp</b>');
  const text = await getPreview(fixture('text/markdown', body), 'owner', 'file');
  assert.equal(text.mimeType, 'text/plain; charset=utf-8');
  assert.deepEqual(text.body, body);

  for (const files of [fixture('text/html', body), fixture('image/svg+xml', body), fixture('image/png', body), fixture('text/plain', Buffer.from([0xff]))]) {
    await assert.rejects(getPreview(files, 'owner', 'file'), (error) => error instanceof ApiError && error.code === 'PREVIEW_UNSUPPORTED');
  }
  await assert.rejects(getPreview(fixture('text/plain', body, 512 * 1024 + 1), 'owner', 'file'), (error) => error instanceof ApiError && error.status === 413);
  const unauthorized = { ...fixture('text/plain', body), async get() { throw notFound(); } };
  await assert.rejects(getPreview(unauthorized, 'other', 'file'), (error) => error instanceof ApiError && error.status === 404);
  const pdf = Buffer.from('%PDF-1.7\nsample');
  assert.deepEqual((await getPreview(fixture('application/pdf', pdf), 'owner', 'file')).body, pdf);
});

function unpackStoredEntries(bytes: Buffer) {
  const directoryEnd = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(directoryEnd), 0x06054b50);
  const count = bytes.readUInt16LE(directoryEnd + 10);
  let offset = bytes.readUInt32LE(directoryEnd + 16);
  const entries = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    assert.equal(bytes.readUInt16LE(offset + 10), 0);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const nameSize = bytes.readUInt16LE(offset + 28);
    const name = bytes.toString('utf8', offset + 46, offset + 46 + nameSize);
    const local = bytes.readUInt32LE(offset + 42);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    entries.set(name, bytes.subarray(start, start + compressedSize));
    offset += 46 + nameSize + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  return entries;
}

test('ZIP-01 streams empty directories and keeps Unicode paths and object bytes', async () => {
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on('data', (chunk: Buffer) => chunks.push(chunk));
  const bytes = Buffer.from('Báo cáo ngày mới');
  const path = 'Nhóm thử/Báo cáo.txt';
  await writeFolderArchive({ name: 'Nhóm thử.zip', directories: ['Nhóm thử', 'Nhóm thử/Trống'], files: [{ id: 'file', path, size: bytes.length }] }, fixture('text/plain', bytes), 'owner', output);
  const entries = unpackStoredEntries(Buffer.concat(chunks));
  assert.deepEqual([...entries.keys()], ['Nhóm thử/', 'Nhóm thử/Trống/', path]);
  assert.deepEqual(entries.get(path), bytes);
});
