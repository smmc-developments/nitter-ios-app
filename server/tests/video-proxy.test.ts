import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import express from 'express';
import type { Fetcher } from '../src/fetcher.js';
import type { ImageCache } from '../src/image-cache.js';

const dataDir = mkdtempSync(join(tmpdir(), 'nitter-video-proxy-'));
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

test('video proxy rejects upstream responses that are not video', async () => {
  const fetcher = {
    fetchMedia: async () => new Response('<html><script>alert(1)</script></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }),
  } as unknown as Fetcher;
  const scheduler = { isRunning: false, run: async () => {} };
  const imageCache = {} as ImageCache;
  const secret = 'test-secret';
  const upstream = 'https://nitter.poast.org/video/vid.twimg.com%2Fclip.mp4';

  const app = express();
  app.use('/api', createRouter(fetcher, scheduler, imageCache, secret));
  const server = app.listen(0);
  try {
    const address = server.address();
    assert(address && typeof address !== 'string');
    const response = await fetch(signedProxyUrl(address.port, secret, upstream));

    assert.equal(response.status, 502);
    assert.notEqual(response.headers.get('content-type'), 'text/html');
    const body = await response.text();
    assert(!body.includes('<script>'));
  } finally {
    server.close();
  }
});

test('video proxy allows octet-stream video bodies', async () => {
  const fetcher = {
    fetchMedia: async () => new Response(Buffer.from('data'), {
      status: 200,
      headers: { 'content-type': 'application/octet-stream', 'content-length': '4' },
    }),
  } as unknown as Fetcher;
  const scheduler = { isRunning: false, run: async () => {} };
  const imageCache = {} as ImageCache;
  const secret = 'test-secret';
  const upstream = 'https://nitter.poast.org/video/vid.twimg.com%2Fclip.mp4';

  const app = express();
  app.use('/api', createRouter(fetcher, scheduler, imageCache, secret));
  const server = app.listen(0);
  try {
    const address = server.address();
    assert(address && typeof address !== 'string');
    const response = await fetch(signedProxyUrl(address.port, secret, upstream));

    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'data');
  } finally {
    server.close();
  }
});

function signedProxyUrl(port: number, secret: string, upstream: string): URL {
  const expires = String(Math.floor(Date.now() / 1000) + 3_600);
  const sig = createHmac('sha256', secret).update(`${expires}\n${upstream}`).digest('hex');
  const url = new URL(`http://127.0.0.1:${port}/api/proxy`);
  url.searchParams.set('url', upstream);
  url.searchParams.set('expires', expires);
  url.searchParams.set('sig', sig);
  return url;
}
