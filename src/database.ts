import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { Baseline1762214400000 } from './migrations/1762214400000-Baseline';
import { AddFileTrash1763683200000 } from './migrations/1763683200000-AddFileTrash';
import { AddFileShares1764201600000 } from './migrations/1764201600000-AddFileShares';

export function createDatabase(url: string): DataSource {
  return new DataSource({
    type: 'postgres',
    url,
    synchronize: false,
    migrationsRun: false,
    migrations: [Baseline1762214400000, AddFileTrash1763683200000, AddFileShares1764201600000],
    extra: { connectionTimeoutMillis: 5000, statement_timeout: 10000 },
  });
}
