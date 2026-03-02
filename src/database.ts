import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { Baseline1762214400000 } from './migrations/1762214400000-Baseline';
import { AddFileTrash1763683200000 } from './migrations/1763683200000-AddFileTrash';
import { AddFileShares1764201600000 } from './migrations/1764201600000-AddFileShares';
import { AddFolderSiblingUniqueness1764806400000 } from './migrations/1764806400000-AddFolderSiblingUniqueness';
import { AddFolderShares1765152000000 } from './migrations/1765152000000-AddFolderShares';

export function createDatabase(url: string): DataSource {
  return new DataSource({
    type: 'postgres',
    url,
    synchronize: false,
    migrationsRun: false,
    migrations: [
      Baseline1762214400000,
      AddFileTrash1763683200000,
      AddFileShares1764201600000,
      AddFolderSiblingUniqueness1764806400000,
      AddFolderShares1765152000000,
    ],
    extra: { connectionTimeoutMillis: 5000, statement_timeout: 10000 },
  });
}
