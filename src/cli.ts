import { databaseUrl, recoveryAgeMs, storageConfig } from './config';
import { createDatabase } from './database';
import { reportFailure } from './errors';
import { createFiles } from './files';
import { createObjectStorage } from './object-storage';
import { seedDrive } from './seed';
import { auditStorage } from './storage-audit';

async function run(command: string | undefined): Promise<void> {
  if (!command || !['migrate', 'seed', 'reconcile', 'audit'].includes(command)) {
    throw new Error('Expected a migrate, seed, reconcile, or audit command');
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
      if (command === 'audit') {
        const report = await auditStorage(db, storage, age);
        console.log(JSON.stringify(report));
        if (Object.values(report.findings).some(count => count > 0)) process.exitCode = 2;
      } else if (command === 'seed') {
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

const command = process.argv[2];
run(command).catch((error: unknown) => {
  if (command === 'audit') console.error('Storage audit failed to complete');
  else reportFailure('Backend maintenance command failed', error);
  process.exitCode = 1;
});
