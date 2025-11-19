import { databaseUrl, recoveryAgeMs, storageConfig } from './config';
import { createDatabase } from './database';
import { reportFailure } from './errors';
import { createFiles } from './files';
import { createObjectStorage } from './object-storage';
import { seedDrive } from './seed';

async function run(command: string | undefined): Promise<void> {
  if (!command || !['migrate', 'seed', 'reconcile'].includes(command)) {
    throw new Error('Expected a migrate, seed, or reconcile command');
  }
  if (command === 'seed' && process.env.NODE_ENV === 'production') {
    throw new Error('Synthetic fixture setup is disabled in production');
  }

  const db = await createDatabase(databaseUrl()).initialize();
  try {
    if (command === 'migrate') {
      const migrations = await db.runMigrations();
      console.log(migrations.length + ' migration(s) applied');
      return;
    }
    const storage = createObjectStorage(storageConfig());
    try {
      const age = recoveryAgeMs();
      if (command === 'seed') {
        await storage.ensureDevelopmentBucket();
        await seedDrive(db, storage, age, process.env.DEMO_PASSWORD || 'CloudDrive-Demo-2025!');
        console.log('Synthetic Drive fixtures are ready');
      } else {
        const { removed, failed } = await createFiles(db, storage, age).reconcile();
        console.log('Reconciled uploads: ' + removed + ', eligible for retry: ' + failed);
        if (failed) process.exitCode = 1;
      }
    } finally {
      storage.close();
    }
  } finally {
    await db.destroy();
  }
}

run(process.argv[2]).catch((error: unknown) => {
  reportFailure('Backend maintenance command failed', error);
  process.exitCode = 1;
});
