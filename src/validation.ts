import { z } from 'zod';

const uuidPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const isDbText = (value: string): boolean => !/[\u0000\uD800-\uDFFF]/u.test(value);
const isFileName = (value: string): boolean =>
  !/[/\\\u0000-\u001F\u007F\uD800-\uDFFF]/u.test(value) && value.trim().length > 0 && value !== '.' && value !== '..';

export const fileIdSchema = z.string().regex(uuidPattern);
export const folderIdSchema = z.union([z.literal('root'), fileIdSchema]).transform((value) => value === 'root' ? null : value);
export const fileNameSchema = z.string().min(1).max(255).refine(isFileName);
export const mimeTypeSchema = z.string().regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i).max(255);

export const loginSchema = z.strictObject({
  email: z.email().max(254).transform((value) => value.toLowerCase()),
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
});

export const updateFileSchema = z.strictObject({
  originalName: fileNameSchema.optional(),
  description: z.string().max(2000).refine(isDbText).nullable().optional(),
  tags: z.array(z.string().min(1).max(64).refine(isDbText)).max(20)
    .refine((tags) => tags.length === new Set(tags).size).optional(),
}).refine((value) => Object.keys(value).length > 0);

export type FileUpdate = z.infer<typeof updateFileSchema>;
