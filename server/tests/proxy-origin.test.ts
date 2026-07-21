import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import express from 'express';
import type { Fetcher } from '../src/fetcher.js';
import type { ImageCache } from '../src/image-cache.js';

const dataDir = mkdtempSync(join(tmpdir(), 'nitter-proxy-origin-'));
process.env.DATA_DIR = dataDir;

const { createRouter } = await import('../src/routes.js');
const database = await import('../src/db.js');

test.after(() => {
  database.default.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('uses the forwarded HTTPS origin for signed media URLs', async () => {
  database.addAccount('alice');
  database.updateAccountFetch('alice', {
    avatarUrl: 'https://nitter.poast.org/pic/pbs.twimg.com%2Fprofile_images%2Falice.jpg',
  });

  const app = express();
  app.set('trust proxy', 1);
  const fetcher = {} as Fetcher;
  const scheduler = { isRunning: false, run: async () => {} };
  const imageCache = {} as ImageCache;
  app.use('/api', createRouter(fetcher, scheduler, imageCache, 'test-secret'));

  const server = app.listen(0);
  try {
    const address = server.address();
    assert(address && typeof address !== 'string');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/accounts`, {
      headers: {
        'x-forwarded-proto': 'https',
      },
    });
    const accounts = await response.json() as Array<{ avatar_url: string }>;
    const avatarUrl = new URL(accounts[0].avatar_url);

    assert.equal(response.status, 200);
    assert.equal(avatarUrl.protocol, 'https:');
    assert.equal(avatarUrl.pathname, '/api/proxy');
    assert(avatarUrl.searchParams.has('sig'));
  } finally {
    server.close();
  }
});
