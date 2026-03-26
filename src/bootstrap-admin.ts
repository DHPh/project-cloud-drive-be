import { bootstrapAdmin } from './admin';
import { databaseUrl } from './config';
import { createDatabase } from './database';
import { ApiError, reportFailure } from './errors';
import { bootstrapAdminSchema } from './validation';

async function main() {
  const parsed = bootstrapAdminSchema.safeParse({
    email: process.env.BOOTSTRAP_ADMIN_EMAIL,
    name: process.env.BOOTSTRAP_ADMIN_NAME,
    password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
  });
  if (!parsed.success) {
    console.error('Set valid BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_ADMIN_NAME, and BOOTSTRAP_ADMIN_PASSWORD.');
    process.exitCode = 1;
    return;
  }
  const db = await createDatabase(databaseUrl()).initialize();
  try {
    await bootstrapAdmin(db, parsed.data);
    console.log('First administrator created.');
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  if (error instanceof ApiError) console.error(error.code, error.message);
  else reportFailure('Administrator bootstrap failed', error);
  process.exitCode = 1;
});
