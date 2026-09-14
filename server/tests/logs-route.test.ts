import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import express from 'express';
import type { Fetcher } from '../src/fetcher.js';
import type { ImageCache } from '../src/image-cache.js';
import { createLogger, getLogs } from '../src/logger.js';

const dataDir = mkdtempSync(join(tmpdir(), 'nitter-logs-route-'));
process.env.DATA_DIR = dataDir;

const { createRouter } = await import('../src/routes.js');
const database = await import('../src/db.js');

test.after(() => {
  database.default.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function setup() {
  const fetcher = {} as Fetcher;
  const scheduler = { isRunning: false, run: async () => {} };
  const imageCache = {} as ImageCache;
  const app = express();
  app.use('/api', createRouter(fetcher, scheduler, imageCache, 'test-secret'));
  return app;
}

async function withServer<T>(app: express.Express, run: (base: string) => Promise<T>): Promise<T> {
  const server = app.listen(0);
  try {
    const address = server.address();
    assert(address && typeof address !== 'string');
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
  }
}

interface LogResponse {
  entries: Array<{ id: number; ts: string; level: string; scope: string; message: string }>;
  latest: number;
}

test('logs endpoint returns buffered entries with watermarks', async () => {
  const watermark = getLogs().latest;
  const testLog = createLogger('logs-test');
  testLog('info message one');
  testLog.warn('warn message two');
  testLog.error('error message three');

  const app = setup();
  await withServer(app, async base => {
    const response = await fetch(`${base}/api/logs?after=${watermark}`);
    assert.equal(response.status, 200);
    const body = await response.json() as LogResponse;
    assert.equal(body.entries.length, 3);
    assert.deepEqual(body.entries.map(e => e.level), ['info', 'warn', 'error']);
    assert.deepEqual(body.entries.map(e => e.scope), ['logs-test', 'logs-test', 'logs-test']);
    assert.equal(body.entries[0].message, 'info message one');
    assert.ok(body.entries[0].ts.includes('T'));
    assert.equal(body.latest, body.entries[2].id);
    assert.ok(body.entries[0].id < body.entries[1].id);
  });
});

test('logs endpoint filters by level and limit', async () => {
  const watermark = getLogs().latest;
  const testLog = createLogger('logs-filter');
  testLog('just info');
  testLog.warn('just warn');
  testLog.error('just error');

  const app = setup();
  await withServer(app, async base => {
    const byLevel = await fetch(`${base}/api/logs?after=${watermark}&level=warn`);
    assert.equal(byLevel.status, 200);
    const warnBody = await byLevel.json() as LogResponse;
    assert.deepEqual(warnBody.entries.map(e => e.level), ['warn', 'error']);

    const limited = await fetch(`${base}/api/logs?after=${watermark}&limit=1`);
    const limitBody = await limited.json() as LogResponse;
    assert.equal(limitBody.entries.length, 1);
    assert.equal(limitBody.entries[0].message, 'just error');
  });
});

test('logs endpoint rejects invalid level values', async () => {
  const app = setup();
  await withServer(app, async base => {
    for (const level of ['bogus', 'silent', 'INFO extra']) {
      const response = await fetch(`${base}/api/logs?level=${encodeURIComponent(level)}`);
      assert.equal(response.status, 400, level);
    }
  });
});
