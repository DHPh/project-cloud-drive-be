import { Readable } from 'node:stream';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import type { storageConfig } from './config';

export interface ObjectStorage {
  put(key: string, bytes: Buffer, mimeType: string): Promise<void>;
  read(key: string): Promise<Readable>;
  remove(key: string): Promise<void>;
}

const requestTimeoutMs = 25000;

export function createObjectStorage(config: ReturnType<typeof storageConfig>) {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
    maxAttempts: 1,
  });

  return {
    async put(key: string, bytes: Buffer, mimeType: string): Promise<void> {
      await client.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: bytes,
        ContentLength: bytes.length,
        ContentType: mimeType,
      }), { abortSignal: AbortSignal.timeout(requestTimeoutMs) });
    },

    async read(key: string): Promise<Readable> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        const result = await client.send(
          new GetObjectCommand({ Bucket: config.bucket, Key: key }),
          { abortSignal: controller.signal }
        );
        if (!(result.Body instanceof Readable)) throw new Error('Missing response stream');
        return result.Body;
      } finally {
        clearTimeout(timer);
      }
    },

    async remove(key: string): Promise<void> {
      const result = await client.send(
        new DeleteObjectCommand({ Bucket: config.bucket, Key: key }),
        { abortSignal: AbortSignal.timeout(requestTimeoutMs) }
      );
      if (result.DeleteMarker) throw new Error('Object storage created a delete marker instead of removing the object');
    },

    async ensureDevelopmentBucket(): Promise<void> {
      try {
        await client.send(
          new HeadBucketCommand({ Bucket: config.bucket }),
          { abortSignal: AbortSignal.timeout(requestTimeoutMs) }
        );
      } catch (error: unknown) {
        if (!(error instanceof S3ServiceException) || error.$metadata.httpStatusCode !== 404) throw error;
        await client.send(
          new CreateBucketCommand({ Bucket: config.bucket }),
          { abortSignal: AbortSignal.timeout(requestTimeoutMs) }
        );
      }
    },

    close(): void {
      client.destroy();
    },
  } satisfies ObjectStorage & { ensureDevelopmentBucket(): Promise<void>; close(): void };
}
