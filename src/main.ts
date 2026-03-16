import { once } from 'node:events';
import { createServer } from 'node:http';
import { createApp } from './app';
import { appConfig, databaseUrl, storageConfig } from './config';
import { createDatabase } from './database';
import { reportFailure } from './errors';
import { createFiles } from './files';
import { createObjectStorage } from './object-storage';
import { createTrashPurge } from './trash-purge';

function startMaintenance(signal: AbortSignal, intervalMs: number, context: string, work: () => Promise<unknown>) {
  let next: NodeJS.Timeout | undefined;
  let current: Promise<void> | undefined;
  function run() {
    if (signal.aborted) return;
    current = (async () => {
      try {
        await work();
      } catch (error) {
        reportFailure(context, error);
      }
      if (!signal.aborted) next = setTimeout(run, intervalMs);
    })();
  }
  run();
  return async () => { clearTimeout(next); await current; };
}

async function main(): Promise<void> {
  const config = appConfig();
  const db = createDatabase(databaseUrl());
  const storage = createObjectStorage(storageConfig());
  const trashPurge = createTrashPurge(db, storage);
  const server = createServer(createApp(db, storage, config));
  server.requestTimeout = 120000;
  server.headersTimeout = 10000;

  try {
    await db.initialize();
    const [schema] = await db.query<{ exists: boolean }[]>(`
      SELECT to_regclass('users') IS NOT NULL AND to_regclass('sessions') IS NOT NULL
        AND to_regclass('folders') IS NOT NULL AND EXISTS (
          SELECT 1 FROM pg_attribute
          WHERE attrelid = to_regclass('files') AND attname = 'trashed_at' AND NOT attisdropped
        ) AND to_regclass('file_shares') IS NOT NULL
          AND to_regclass('folders_sibling_name_unique') IS NOT NULL
          AND to_regclass('folder_shares') IS NOT NULL
          AND to_regclass('folders_trash_batch') IS NOT NULL
          AND to_regclass('trash_retention_policy') IS NOT NULL
          AND to_regclass('trash_purge_jobs') IS NOT NULL
          AND to_regclass('trash_purge_files') IS NOT NULL
          AND to_regclass('trash_empty_requests') IS NOT NULL AND EXISTS (
            SELECT 1 FROM pg_attribute
            WHERE attrelid = to_regclass('folders') AND attname = 'description' AND NOT attisdropped
          ) AS exists
    `);
    if (!schema?.exists) {
      console.error('Database schema missing. Run the migration command before starting.');
      throw new Error('Missing database schema');
    }
    await trashPurge.activateRetention();
    server.listen(config.port, config.host);
    await once(server, 'listening');
  } catch (error) {
    storage.close();
    if (db.isInitialized) await db.destroy();
    throw error;
  }

  const files = createFiles(db, storage, config.uploadRecoveryAgeMs);
  const maintenance = new AbortController();
  const maintenanceTasks = [
    startMaintenance(maintenance.signal, 60000, 'Backend maintenance pass failed', async () => {
      await files.reconcile(maintenance.signal);
      if (!maintenance.signal.aborted) await db.query('DELETE FROM sessions WHERE expires_at <= now()');
    }),
    startMaintenance(maintenance.signal, 60000, 'Unable to queue expired Trash entries',
      () => trashPurge.reserveExpired(undefined, maintenance.signal)),
    startMaintenance(maintenance.signal, 1000, 'Trash purge processing failed',
      () => trashPurge.processQueue(undefined, maintenance.signal)),
  ];

  async function shutdown(): Promise<void> {
    if (maintenance.signal.aborted) return;
    maintenance.abort();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.all(maintenanceTasks.map((stop) => stop()));
    storage.close();
    await db.destroy();
  }
  function handleSignal(): void {
    void shutdown().catch((error: unknown) => {
      reportFailure('Backend shutdown failed', error);
      process.exitCode = 1;
    });
  }
  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);
  console.log('Cloud Drive API listening on port ' + config.port);
}

main().catch((error: unknown) => {
  reportFailure('Backend startup failed', error);
  process.exitCode = 1;
});
