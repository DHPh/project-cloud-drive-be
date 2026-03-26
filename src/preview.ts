import { ApiError, reportFailure, storageUnavailable } from './errors';
import type { createFiles } from './files';

type Files = Pick<ReturnType<typeof createFiles>, 'get' | 'download'>;

const textLimit = 512 * 1024;
const binaryLimit = 10 * 1024 * 1024;
const textFormats = new Set([
  'text/plain', 'text/markdown', 'text/csv', 'text/tab-separated-values',
  'text/javascript', 'text/css', 'text/x-python', 'text/x-shellscript',
  'application/json', 'application/javascript', 'application/typescript',
]);

const startsWith = (bytes: Buffer, signature: Buffer) => bytes.subarray(0, signature.length).equals(signature);

const binaryFormats = new Map<string, (bytes: Buffer) => boolean>([
  ['image/jpeg', (bytes) => startsWith(bytes, Buffer.from([0xff, 0xd8, 0xff]))],
  ['image/png', (bytes) => startsWith(bytes, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['image/gif', (bytes) => ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))],
  ['image/webp', (bytes) => bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'],
  ['application/pdf', (bytes) => startsWith(bytes, Buffer.from('%PDF-'))],
]);

const unsupportedPreview = () => new ApiError(415, 'PREVIEW_UNSUPPORTED', 'This file format cannot be previewed.');
const oversizedPreview = () => new ApiError(413, 'PREVIEW_TOO_LARGE', 'This file is too large to preview.');

export async function getPreview(files: Files, userId: string, fileId: string) {
  const file = await files.get(userId, fileId);
  const mimeType = file.mimeType.toLowerCase();
  const isText = textFormats.has(mimeType);
  const signature = binaryFormats.get(mimeType);
  if (!isText && !signature) throw unsupportedPreview();
  const limit = isText ? textLimit : binaryLimit;
  if (file.size > limit) throw oversizedPreview();

  const { stream, name } = await files.download(userId, fileId);
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > limit) throw oversizedPreview();
      chunks.push(bytes);
    }
  } catch (error: unknown) {
    if (error instanceof ApiError) throw error;
    reportFailure('Preview read failed in object storage', error);
    throw storageUnavailable();
  }

  const body = Buffer.concat(chunks, size);
  if (signature) {
    if (!signature(body)) throw unsupportedPreview();
    return { mimeType, name, body };
  }

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    return { mimeType: 'text/plain; charset=utf-8', name, body: Buffer.from(text) };
  } catch {
    throw unsupportedPreview();
  }
}
