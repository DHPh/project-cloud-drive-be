import { z } from 'zod';

const uuidPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const isDbText = (value: string): boolean => !/[\u0000\uD800-\uDFFF]/u.test(value);
const isDbTextWithin = (value: string, max: number): boolean => isDbText(value) && [...value].length <= max;
const isFileName = (value: string): boolean =>
  !/[/\\\u0000-\u001F\u007F\uD800-\uDFFF]/u.test(value) && value.trim().length > 0 && value !== '.' && value !== '..';

export const fileIdSchema = z.string().regex(uuidPattern);
export const folderUuidSchema = fileIdSchema.transform((value) => value.toLowerCase());
export const folderIdSchema = z.union([z.literal('root'), fileIdSchema]).transform((value) => value === 'root' ? null : value);
export const fileNameSchema = z.string().min(1).max(255).refine(isFileName);
export const mimeTypeSchema = z.string().regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i).max(255);

const emailSchema = z.email().max(254).transform((value) => value.toLowerCase());
const currentPasswordSchema = z.string().min(1).refine((value) => [...value].length <= 1024);
const newPasswordSchema = currentPasswordSchema.refine((value) => isDbText(value) && [...value].length >= 12);
const accountNameSchema = z.string().trim().min(1).refine((value) => isDbTextWithin(value, 120));
const accountLinkSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const loginSchema = z.strictObject({
  email: emailSchema,
  password: currentPasswordSchema,
});

export const accountProfileSchema = z.strictObject({ name: accountNameSchema });
export const changePasswordSchema = z.strictObject({ currentPassword: currentPasswordSchema, password: newPasswordSchema });
export const acceptInviteSchema = z.strictObject({ token: accountLinkSchema, password: newPasswordSchema, name: accountNameSchema });
export const resetPasswordSchema = z.strictObject({ token: accountLinkSchema, password: newPasswordSchema });
export const createInviteSchema = z.strictObject({ email: emailSchema });
export const bootstrapAdminSchema = z.strictObject({ email: emailSchema, name: accountNameSchema, password: newPasswordSchema });
export const updateAdminUserSchema = z.strictObject({
  quotaBytes: z.int().nonnegative().optional(),
  role: z.enum(['user', 'admin']).optional(),
  disabled: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0);

function positiveInteger(max = Number.MAX_SAFE_INTEGER) {
  return z.string().regex(/^\d+$/).transform(Number).pipe(z.int().min(1).max(max));
}

export const paginationQuerySchema = z.strictObject({
  page: positiveInteger().default(1),
  limit: positiveInteger(100).default(20),
});

export const adminInviteQuerySchema = paginationQuerySchema.extend({
  status: z.enum(['all', 'active', 'expired', 'used', 'revoked']).default('all'),
});

export const adminUserQuerySchema = paginationQuerySchema.extend({
  q: z.string().refine((value) => isDbTextWithin(value, 255)).transform((value) => value.trim()).default(''),
});

export const trashQuerySchema = paginationQuerySchema.extend({
  includeFolders: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
});

export const trashKindSchema = z.enum(['file', 'folder']);
export const trashEventSchema = z.strictObject({ trashEventId: folderUuidSchema });
export const emptyTrashSchema = z.strictObject({ requestId: folderUuidSchema });

export const folderQuerySchema = paginationQuerySchema.extend({
  q: z.string().max(255).refine(isDbText).transform((value) => value.trim()).default(''),
  type: z.enum(['all', 'folders']).default('all'),
});

const driveItemTypeSchema = z.enum(['all', 'files', 'folders']).default('all');

export const driveSearchQuerySchema = paginationQuerySchema.extend({
  q: z.string().refine((value) => isDbTextWithin(value, 255)).transform((value) => value.trim()).default(''),
  includeMetadata: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  type: driveItemTypeSchema,
  sort: z.enum(['name', 'newest']).default('name'),
});

export const outgoingShareQuerySchema = paginationQuerySchema.extend({
  type: driveItemTypeSchema,
  status: z.enum(['all', 'active', 'expired']).default('all'),
});

const timelineDateSchema = z.iso.date().refine((date) => !date.startsWith('0000')).optional();

export const driveTimelineQuerySchema = paginationQuerySchema.extend({
  from: timelineDateSchema,
  to: timelineDateSchema,
  type: z.enum(['all', 'image', 'video', 'audio', 'pdf', 'document', 'other']).default('all'),
}).refine(({ from, to }) => !from || !to || from <= to);

const folderNameSchema = z.string().trim().min(1).refine((name) => isDbText(name) && [...name].length <= 255);
const descriptionSchema = z.string().refine((value) => isDbTextWithin(value, 2000)).nullable().optional();

export const createFolderSchema = z.strictObject({
  name: folderNameSchema,
  parentId: folderUuidSchema.nullish(),
  description: descriptionSchema,
});

export const updateFolderSchema = z.strictObject({
  name: folderNameSchema.optional(),
  parentId: folderUuidSchema.nullish(),
  description: descriptionSchema,
}).refine(({ name, parentId, description }) => name !== undefined || parentId !== undefined || description !== undefined);

export const updateFileSchema = z.strictObject({
  originalName: fileNameSchema.optional(),
  description: descriptionSchema,
  tags: z.array(z.string().min(1).refine((tag) => isDbTextWithin(tag, 64))).max(20)
    .refine((tags) => tags.length === new Set(tags).size).optional(),
  folderId: folderUuidSchema.nullish(),
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
export type DriveSearchQuery = z.infer<typeof driveSearchQuerySchema>;
export type DriveTimelineQuery = z.infer<typeof driveTimelineQuerySchema>;
export type OutgoingShareQuery = z.infer<typeof outgoingShareQuerySchema>;
export type AdminInviteQuery = z.infer<typeof adminInviteQuerySchema>;
export type AdminUserQuery = z.infer<typeof adminUserQuerySchema>;
export type AdminUserUpdate = z.infer<typeof updateAdminUserSchema>;
export type BootstrapAdminInput = z.infer<typeof bootstrapAdminSchema>;
