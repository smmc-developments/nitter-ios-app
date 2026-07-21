import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import express from 'express';
import type { Fetcher } from '../src/fetcher.js';
import type { ImageCache } from '../src/image-cache.js';

const dataDir = mkdtempSync(join(tmpdir(), 'xcancel-video-proxy-'));
process.env.DATA_DIR = dataDir;
const { createRouter } = await import('../src/routes.js');

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

test('video proxy forwards byte ranges and streams partial content', async () => {
  let forwardedRange: string | undefined;
  const fetcher = {
    fetchMedia: async (_url: string, headers: Record<string, string>) => {
      forwardedRange = headers.range;
      return new Response(Buffer.from('data'), {
        status: 206,
        headers: {
          'content-type': 'video/mp4',
          'content-length': '4',
          'content-range': 'bytes 0-3/10',
          'accept-ranges': 'bytes',
        },
      });
    },
  } as unknown as Fetcher;
  const scheduler = { isRunning: false, run: async () => {} };
  const imageCache = {} as ImageCache;
  const secret = 'test-secret';
  const upstream = 'https://nitter.poast.org/video/vid.twimg.com%2Fclip.mp4';
  const expires = String(Math.floor(Date.now() / 1000) + 3_600);
  const sig = createHmac('sha256', secret).update(`${expires}\n${upstream}`).digest('hex');

  const app = express();
  app.use('/api', createRouter(fetcher, scheduler, imageCache, secret));
  const server = app.listen(0);
  try {
    const address = server.address();
    assert(address && typeof address !== 'string');
    const url = new URL(`http://127.0.0.1:${address.port}/api/proxy`);
    url.searchParams.set('url', upstream);
    url.searchParams.set('expires', expires);
    url.searchParams.set('sig', sig);
    const response = await fetch(url, { headers: { range: 'bytes=0-3' } });

    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-type'), 'video/mp4');
    assert.equal(response.headers.get('content-range'), 'bytes 0-3/10');
    assert.equal(await response.text(), 'data');
    assert.equal(forwardedRange, 'bytes=0-3');
  } finally {
    server.close();
  }
});
