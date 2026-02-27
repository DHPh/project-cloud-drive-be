import { z } from 'zod';

const uuidPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const isDbText = (value: string): boolean => !/[\u0000\uD800-\uDFFF]/u.test(value);
const isFileName = (value: string): boolean =>
  !/[/\\\u0000-\u001F\u007F\uD800-\uDFFF]/u.test(value) && value.trim().length > 0 && value !== '.' && value !== '..';

export const fileIdSchema = z.string().regex(uuidPattern);
export const folderUuidSchema = fileIdSchema.transform((value) => value.toLowerCase());
export const folderIdSchema = z.union([z.literal('root'), fileIdSchema]).transform((value) => value === 'root' ? null : value);
export const fileNameSchema = z.string().min(1).max(255).refine(isFileName);
export const mimeTypeSchema = z.string().regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i).max(255);

const emailSchema = z.email().max(254).transform((value) => value.toLowerCase());

export const loginSchema = z.strictObject({
  email: emailSchema,
  password: z.string().min(1).max(1024),
});

function positiveInteger(max = Number.MAX_SAFE_INTEGER) {
  return z.string().regex(/^\d+$/).transform(Number).pipe(z.int().min(1).max(max));
}

export const paginationQuerySchema = z.strictObject({
  page: positiveInteger().default(1),
  limit: positiveInteger(100).default(20),
});

export const folderQuerySchema = paginationQuerySchema.extend({
  q: z.string().max(255).refine(isDbText).transform((value) => value.trim()).default(''),
  type: z.enum(['all', 'folders']).default('all'),
});

const folderNameSchema = z.string().trim().min(1).refine((name) => isDbText(name) && [...name].length <= 255);

export const createFolderSchema = z.strictObject({
  name: folderNameSchema,
  parentId: folderUuidSchema.nullish(),
});

export const updateFolderSchema = z.strictObject({
  name: folderNameSchema.optional(),
  parentId: folderUuidSchema.nullish(),
}).refine(({ name, parentId }) => name !== undefined || parentId !== undefined);

export const updateFileSchema = z.strictObject({
  originalName: fileNameSchema.optional(),
  description: z.string().max(2000).refine(isDbText).nullable().optional(),
  tags: z.array(z.string().min(1).max(64).refine(isDbText)).max(20)
    .refine((tags) => tags.length === new Set(tags).size).optional(),
}).refine((value) => Object.keys(value).length > 0);

export const grantFileShareSchema = z.strictObject({
  email: emailSchema,
  expiresAt: z.iso.datetime({ offset: true })
    .regex(/T\d{2}:\d{2}:\d{2}/)
    .refine((value) => Number.isFinite(Date.parse(value)))
    .transform((value) => new Date(value).toISOString())
    .refine((value) => value.length === 24 && !value.startsWith('0000'))
    .nullish(),
});

export type FileUpdate = z.infer<typeof updateFileSchema>;
export type FileShareGrant = z.infer<typeof grantFileShareSchema>;
export type FolderCreate = z.infer<typeof createFolderSchema>;
export type FolderUpdate = z.infer<typeof updateFolderSchema>;
