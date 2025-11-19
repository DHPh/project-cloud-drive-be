import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { Baseline1762214400000 } from './migrations/1762214400000-Baseline';

export function createDatabase(url: string): DataSource {
  return new DataSource({
    type: 'postgres',
    url,
    synchronize: false,
    migrationsRun: false,
    migrations: [Baseline1762214400000],
    extra: { connectionTimeoutMillis: 5000, statement_timeout: 10000 },
  });
}
