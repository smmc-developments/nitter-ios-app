import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Fetcher } from '../src/fetcher.js';
import { getLogs } from '../src/logger.js';

const dataDir = mkdtempSync(join(tmpdir(), 'nitter-image-init-'));
process.env.DATA_DIR = dataDir;
// A file at the directory path makes mkdir reject deterministically.
writeFileSync(join(dataDir, 'images'), 'not a directory');
const { ImageCache } = await import('../src/image-cache.js');

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

test('cache initialization failures are handled and logged instead of becoming unhandled rejections', async () => {
  const watermark = getLogs().latest;
  const cache = new ImageCache({} as Fetcher);
  await assert.doesNotReject(cache.ready);
  assert.ok(getLogs({ after: watermark }).entries.some(entry =>
    entry.scope === 'image-cache' && entry.level === 'warn' && entry.message.includes('Cache initialization failed')));
});
