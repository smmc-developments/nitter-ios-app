import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import express from 'express';
import type { Fetcher } from '../src/fetcher.js';
import type { ImageCache } from '../src/image-cache.js';

const dataDir = mkdtempSync(join(tmpdir(), 'twv-tweet-route-'));
process.env.DATA_DIR = dataDir;

const { createRouter } = await import('../src/routes.js');
const database = await import('../src/db.js');

test.after(() => {
  database.default.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function setup() {
  const fetchedPaths: string[] = [];
  const fetcher = {
    fetchJson: async (path: string) => {
      fetchedPaths.push(path);
      return {
        success: true,
        data: {
          id: '1234567890',
          author: { username: 'nasa', displayName: 'NASA', avatar: null },
          content: 'Hello',
          createdAt: '2026-08-25T16:47:24.000Z',
        },
      };
    },
  } as unknown as Fetcher;
  const scheduler = { isRunning: false, run: async () => {} };
  const imageCache = {} as ImageCache;
  const app = express();
  app.use('/api', createRouter(fetcher, scheduler, imageCache, 'test-secret'));
  return { app, fetchedPaths };
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

test('tweet route fetches the API tweet endpoint for valid params', async () => {
  const { app, fetchedPaths } = setup();
  await withServer(app, async base => {
    const response = await fetch(`${base}/api/tweet/NASA/1234567890`);
    assert.equal(response.status, 200);
    assert.deepEqual(fetchedPaths, ['/api/tweet/1234567890']);
    const body = await response.json() as { tweet: { id: string } | null; replies: unknown[] };
    assert.equal(body.tweet?.id, '1234567890');
    assert.deepEqual(body.replies, []);
  });
});

test('tweet route rejects encoded traversal in username', async () => {
  const { app, fetchedPaths } = setup();
  await withServer(app, async base => {
    const response = await fetch(`${base}/api/tweet/..%2F..%2Fsearch/123`);
    assert.equal(response.status, 400);
    assert.deepEqual(fetchedPaths, []);
  });
});

test('tweet route rejects encoded slashes and non-numeric tweet IDs', async () => {
  const { app, fetchedPaths } = setup();
  await withServer(app, async base => {
    for (const path of ['/api/tweet/nasa/12%2F34', '/api/tweet/nasa/abc', '/api/tweet/nasa/123%3Ffoo']) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 400, path);
    }
    assert.deepEqual(fetchedPaths, []);
  });
});
