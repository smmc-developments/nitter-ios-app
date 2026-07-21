import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

const dataDir = mkdtempSync(join(tmpdir(), 'nitter-db-migration-'));
const legacyPath = join(dataDir, 'xcancel.db');
const databasePath = join(dataDir, 'nitter.db');

const legacyDatabase = new Database(legacyPath);
legacyDatabase.exec('CREATE TABLE migration_marker (value TEXT NOT NULL)');
legacyDatabase.prepare('INSERT INTO migration_marker (value) VALUES (?)').run('preserved');
legacyDatabase.close();

process.env.DATA_DIR = dataDir;
const database = await import('../src/db.js');

test.after(() => {
  database.default.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('migrates the legacy database without losing data', () => {
  assert.equal(existsSync(legacyPath), false);
  assert.equal(existsSync(databasePath), true);
  const marker = database.default
    .prepare('SELECT value FROM migration_marker')
    .get() as { value: string };
  assert.equal(marker.value, 'preserved');
});
