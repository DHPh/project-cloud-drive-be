import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export const invalidRequest = () => new ApiError(400, 'INVALID_REQUEST', 'The request contains invalid values.');
export const sessionRequired = () => new ApiError(401, 'SESSION_REQUIRED', 'Sign in to continue.');
export const notFound = () => new ApiError(404, 'NOT_FOUND', 'The requested item was not found.');
export const unsupportedMedia = () => new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'This upload media type is not supported.');
export const storageUnavailable = () => new ApiError(503, 'STORAGE_UNAVAILABLE', 'File storage is temporarily unavailable.');
export const staleTrashEvent = () => new ApiError(409, 'STALE_TRASH_EVENT', 'The Trash entry has changed. Refresh the list and try again.');
export const trashDeleteInProgress = () => new ApiError(409, 'DELETE_IN_PROGRESS', 'This item is being permanently deleted.');

export function reportFailure(context: string, error: unknown): void {
  const type = error instanceof Error ? error.name : 'Error';
  console.error(context, type);
}

export function sendError(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (res.destroyed) return;

  let result: ApiError;
  if (error instanceof ApiError) {
    result = error;
  } else if (
    error instanceof ZodError ||
    error instanceof SyntaxError ||
    error instanceof URIError ||
    (error instanceof Error && 'status' in error && error.status === 413)
  ) {
    result = invalidRequest();
  } else {
    reportFailure('Unhandled API error', error);
    result = new ApiError(500, 'INTERNAL_ERROR', 'An unexpected error occurred.');
  }

  res.status(result.status).json({ success: false, error: { code: result.code, message: result.message } });
}
