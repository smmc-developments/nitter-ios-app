import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import express from 'express';
import type { Fetcher } from '../src/fetcher.js';
import type { ImageCache } from '../src/image-cache.js';

const dataDir = mkdtempSync(join(tmpdir(), 'nitter-error-logging-'));
process.env.DATA_DIR = dataDir;
const database = await import('../src/db.js');
const { Scheduler } = await import('../src/scheduler.js');
const { createRouter } = await import('../src/routes.js');

test.after(() => {
  database.default.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const reason = 'apiRequestContext.fetch: Timeout 30000ms exceeded.';
const unsafeMessage = `${reason}\nCall log:\n  - → GET https://instance.example/alice\n  - cookie: session=secret-rate-cookie\n  - authorization: Bearer secret-token`;

async function withServer(app: express.Express, run: (base: string) => Promise<void>) {
  const server = app.listen(0);
  try {
    const address = server.address();
    assert(address && typeof address !== 'string');
    await run(`http://127.0.0.1:${address.port}/api`);
  } finally {
    server.close();
  }
}

test('scheduler saves only the failure reason and never mistakes a cookie for a rate limit', async () => {
  database.addAccount('alice');
  let calls = 0;
  const fetcher = { fetchPage: async () => { calls++; throw new Error(unsafeMessage); } } as unknown as Fetcher;
  const scheduler = new Scheduler(fetcher, {} as ImageCache);
  await scheduler.run(true);
  assert.equal(calls, 1);
  assert.equal(database.getAccount('alice')?.fetch_error, reason);
  assert.equal(database.getAccount('alice')?.consecutive_failures, 1);
});

test('tweet error responses never expose Playwright request headers', async () => {
  const fetcher = { fetchPage: async () => { throw new Error(unsafeMessage); } } as unknown as Fetcher;
  const app = express();
  app.use('/api', createRouter(fetcher, { isRunning: false, run: async () => {} }, {} as ImageCache, 'test-secret'));
  await withServer(app, async base => {
    const response = await fetch(`${base}/tweet/alice/123`);
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: reason });
  });
});

test('legacy saved account errors are sanitized when served without rewriting user data', async () => {
  database.addAccount('legacy');
  database.default.prepare('UPDATE accounts SET fetch_error = ? WHERE username = ?').run(unsafeMessage, 'legacy');
  const app = express();
  app.use('/api', createRouter({} as Fetcher, { isRunning: false, run: async () => {} }, {} as ImageCache, 'test-secret'));
  await withServer(app, async base => {
    const response = await fetch(`${base}/accounts`);
    assert.equal(response.status, 200);
    const accounts = await response.json() as Array<{ username: string; fetch_error: string | null }>;
    assert.equal(accounts.find(account => account.username === 'legacy')?.fetch_error, reason);
    assert.ok(!JSON.stringify(accounts).includes('secret-'));
  });
  assert.equal(database.getAccount('legacy')?.fetch_error, unsafeMessage);
});
