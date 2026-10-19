import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('a test worker with an early DATA_DIR import cannot open the wrong database', t => {
  const root = mkdtempSync(join(tmpdir(), 'nitter-db-isolation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const early = join(root, 'early');
  const intended = join(root, 'intended');
  const paths = new URL('../src/paths.ts', import.meta.url).href;
  const db = new URL('../src/db.ts', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    await import(${JSON.stringify(paths)});
    process.env.DATA_DIR = ${JSON.stringify(intended)};
    await import(${JSON.stringify(db)});
  `], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, NODE_TEST_CONTEXT: 'child-v8', DATA_DIR: early },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Tests must set DATA_DIR before importing application modules/);
  assert.equal(existsSync(join(early, 'nitter.db')), false);
  assert.equal(existsSync(join(intended, 'nitter.db')), false);
});
