import busboy from 'busboy';
import type { Request } from 'express';
import { ApiError, invalidRequest, unsupportedMedia } from './errors';
import { fileNameSchema, folderIdSchema, mimeTypeSchema } from './validation';

export type Upload = {
  originalName: string;
  mimeType: string;
  bytes: Buffer;
  folderId: string | null;
};

export function readUpload(req: Request, maxBytes: number): Promise<Upload> {
  if (!req.is('multipart/form-data')) throw unsupportedMedia();

  let parser: ReturnType<typeof busboy>;
  try {
    parser = busboy({
      headers: req.headers,
      defParamCharset: 'utf8',
      limits: { fileSize: maxBytes + 1, files: 1, fields: 1, parts: 3, fieldSize: 256 },
    });
  } catch {
    throw invalidRequest();
  }

  return new Promise<Upload>((resolve, reject) => {
    let invalid = false;
    let tooLarge = false;
    let originalName: string | undefined;
    let mimeType: string | undefined;
    let folder: string | undefined;
    const chunks: Buffer[] = [];

    const abort = () => fail(invalidRequest());
    function fail(error: unknown): void {
      req.off('aborted', abort);
      req.unpipe(parser);
      req.resume();
      reject(error);
    }

    req.once('aborted', abort);
    parser.on('file', (field, stream, info) => {
      originalName = info.filename;
      mimeType = info.mimeType;
      invalid ||= field !== 'file';
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.once('limit', () => { tooLarge = true; });
      stream.once('error', abort);
    });
    parser.on('field', (name, value, info) => {
      invalid ||= name !== 'folderId' || info.nameTruncated || info.valueTruncated;
      folder = value;
    });
    for (const event of ['filesLimit', 'fieldsLimit', 'partsLimit'] as const) {
      parser.once(event, () => { invalid = true; });
    }
    parser.once('error', abort);
    parser.once('close', () => {
      req.off('aborted', abort);
      if (invalid) return reject(invalidRequest());
      if (tooLarge) {
        return reject(new ApiError(413, 'FILE_TOO_LARGE', 'The file exceeds the upload size limit.'));
      }
      const parsedName = fileNameSchema.safeParse(originalName);
      const parsedFolder = folderIdSchema.safeParse(folder ?? 'root');
      if (!parsedName.success || !parsedFolder.success) return reject(invalidRequest());
      const parsedMime = mimeTypeSchema.safeParse(mimeType);
      if (!parsedMime.success) return reject(unsupportedMedia());
      resolve({
        originalName: parsedName.data,
        mimeType: parsedMime.data.toLowerCase(),
        bytes: Buffer.concat(chunks),
        folderId: parsedFolder.data,
      });
    });
    req.pipe(parser);
  });
}

export function attachmentHeader(originalName: string): string {
  const fallback = originalName.normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^\x20-\x7E]|["\\]/g, '_');
  const utf8 = encodeURIComponent(originalName)
    .replace(/['()*]/g, (character) => '%' + character.charCodeAt(0).toString(16).toUpperCase());
  return 'attachment; filename="' + fallback + '"; filename*=UTF-8' + "''" + utf8;
}
