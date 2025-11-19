import { once } from 'node:events';
import { createServer } from 'node:http';
import { createApp } from './app';
import { appConfig, databaseUrl, storageConfig } from './config';
import { createDatabase } from './database';
import { reportFailure } from './errors';
import { createFiles } from './files';
import { createObjectStorage } from './object-storage';

async function main(): Promise<void> {
  const config = appConfig();
  const db = createDatabase(databaseUrl());
  const storage = createObjectStorage(storageConfig());
  const server = createServer(createApp(db, storage, config));
  server.requestTimeout = 120000;
  server.headersTimeout = 10000;

  try {
    await db.initialize();
    const [schema] = await db.query<{ exists: boolean }[]>(`
      SELECT to_regclass('users') IS NOT NULL AND to_regclass('sessions') IS NOT NULL
        AND to_regclass('folders') IS NOT NULL AND to_regclass('files') IS NOT NULL AS exists
    `);
    if (!schema?.exists) {
      console.error('Database schema missing. Run the migration command before starting.');
      throw new Error('Missing database schema');
    }
    server.listen(config.port, config.host);
    await once(server, 'listening');
  } catch (error) {
    storage.close();
    if (db.isInitialized) await db.destroy();
    throw error;
  }

  const files = createFiles(db, storage, config.uploadRecoveryAgeMs);
  const maintenance = new AbortController();
  let next: NodeJS.Timeout | undefined;
  let current: Promise<void> | undefined;

  function runMaintenance(): void {
    current = (async () => {
      try {
        await files.reconcile(maintenance.signal);
        if (!maintenance.signal.aborted) await db.query('DELETE FROM sessions WHERE expires_at <= now()');
      } catch (error) {
        reportFailure('Backend maintenance pass failed', error);
      }
      if (!maintenance.signal.aborted) next = setTimeout(runMaintenance, 60000);
    })();
  }
  runMaintenance();

  async function shutdown(): Promise<void> {
    if (maintenance.signal.aborted) return;
    maintenance.abort();
    clearTimeout(next);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await current;
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
