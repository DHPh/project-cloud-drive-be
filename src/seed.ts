import type { DataSource } from 'typeorm';
import { createFiles } from './files';
import type { ObjectStorage } from './object-storage';
import { hashPassword } from './session';

const demoOwner = '10000000-0000-4000-8000-000000000001';
const viewerOwner = '10000000-0000-4000-8000-000000000002';
const reviewerOwner = '10000000-0000-4000-8000-000000000003';
const documents = '10000000-0000-4000-8000-000000000101';
const projects = '10000000-0000-4000-8000-000000000102';
const empty = '10000000-0000-4000-8000-000000000103';
const archive = '10000000-0000-4000-8000-000000000104';
const viewerFolder = '10000000-0000-4000-8000-000000000201';

export async function seedDrive(db: DataSource, storage: ObjectStorage, recoveryAgeMs: number, password: string) {
  if (password.length < 12) throw new Error('DEMO_PASSWORD must be at least 12 characters');
  const passwordHash = await hashPassword(password);
  await db.transaction(async (manager) => {
    for (const [id, email, name] of [
      [demoOwner, 'demo@example.test', 'Minh Anh'],
      [viewerOwner, 'viewer@example.test', 'Other Drive User'],
      [reviewerOwner, 'reviewer@example.test', 'Drive Reviewer'],
    ]) {
      await manager.query(`
        INSERT INTO users (id, email, name, password_hash, quota_bytes)
        VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING
      `, [id, email, name, passwordHash, 1073741824]);
    }
    for (const [id, owner, parent, name] of [
      [documents, demoOwner, null, 'Documents'],
      [projects, demoOwner, documents, 'Projects'],
      [empty, demoOwner, null, 'Empty'],
      [archive, demoOwner, null, 'Archive'],
      [viewerFolder, viewerOwner, null, 'Private folder'],
    ]) {
      await manager.query(`
        INSERT INTO folders (id, owner_id, parent_id, name)
        VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING
      `, [id, owner, parent, name]);
    }
  });

  const files = createFiles(db, storage, recoveryAgeMs);
  await files.reconcile();
  const fixtures = [
    { ownerId: demoOwner, folderId: null, name: 'Báo cáo tháng 11.txt', text: 'Báo cáo tổng hợp tháng 11.\n' },
    { ownerId: demoOwner, folderId: null, name: 'Danh sách tài liệu.csv', text: 'name,category\nNotes,Planning\n' },
    { ownerId: demoOwner, folderId: null, name: 'Scope sample - Root.txt', text: 'This fixture lives in the root.\n' },
    { ownerId: demoOwner, folderId: documents, name: 'Scope sample - Documents.txt', text: 'This fixture lives in Documents.\n' },
    { ownerId: demoOwner, folderId: archive, name: 'Scope sample - Archive.txt', text: 'This fixture lives in Archive.\n' },
    { ownerId: demoOwner, folderId: projects, name: 'Ghi chú dự án.txt', text: 'Ghi chú cho một dự án minh họa.\n' },
    { ownerId: viewerOwner, folderId: viewerFolder, name: 'Viewer fixture.txt', text: 'A second account owns this file.\n' },
    ...Array.from({ length: 24 }, (_, index) => ({
      ownerId: demoOwner,
      folderId: documents,
      name: 'Document ' + String(index + 1).padStart(2, '0') + '.txt',
      text: 'Synthetic pagination fixture ' + (index + 1) + '.\n',
    })),
  ];

  for (const [index, fixture] of fixtures.entries()) {
    const id = '10000000-0000-4000-8000-00000000' + String(1000 + index);
    await files.upload(fixture.ownerId, {
      originalName: fixture.name,
      folderId: fixture.folderId,
      mimeType: fixture.name.endsWith('.csv') ? 'text/csv' : 'text/plain',
      bytes: Buffer.from(fixture.text, 'utf8'),
    }, id);
  }
}
