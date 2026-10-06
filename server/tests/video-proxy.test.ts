import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import http from 'node:http';
import { setImmediate } from 'node:timers/promises';
import express from 'express';
import type { Fetcher } from '../src/fetcher.js';
import type { ImageCache } from '../src/image-cache.js';
import { getLogs } from '../src/logger.js';
import { MediaNotFoundError } from '../src/media-errors.js';

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
  const upstream = 'https://nitter.click/video/vid.twimg.com%2Fclip.mp4';
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
  const upstream = 'https://nitter.click/video/vid.twimg.com%2Fclip.mp4';

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
  const upstream = 'https://nitter.click/video/vid.twimg.com%2Fclip.mp4';

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

test('client cancellations abort the upstream fetch without logging a proxy failure or writing a 502', async () => {
  const watermark = getLogs().latest;
  let started!: () => void;
  let cancelled!: () => void;
  const fetchStarted = new Promise<void>(resolve => { started = resolve; });
  const fetchCancelled = new Promise<void>(resolve => { cancelled = resolve; });
  const fetcher = {
    fetchMedia: async (_url: string, _headers: unknown, signal: AbortSignal) => {
      started();
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(signal.reason);
          cancelled();
        }, { once: true });
      });
    },
  } as unknown as Fetcher;
  const app = express();
  let errorResponses = 0;
  app.use((_req, res, next) => {
    const status = res.status.bind(res);
    res.status = code => { if (code === 502) errorResponses++; return status(code); };
    next();
  });
  app.use('/api', createRouter(fetcher, { isRunning: false, run: async () => {} }, {} as ImageCache, 'test-secret'));
  const server = app.listen(0);
  try {
    const address = server.address();
    assert(address && typeof address !== 'string');
    const request = http.get(signedProxyUrl(address.port, 'test-secret', 'https://nitter.click/video/clip.mp4'));
    request.on('error', () => {}); // Destroying the client socket is intentional.
    await fetchStarted;
    request.destroy();
    await fetchCancelled;
    await setImmediate(); // Let the route's rejection handler finish.
    assert.equal(errorResponses, 0);
    assert.equal(getLogs({ after: watermark }).entries.some(entry => entry.scope === 'routes' && entry.message.includes('GET /proxy FAILED')), false);
  } finally {
    server.close();
  }
});

test('an upstream abort while the client is connected is still reported as a failure', async () => {
  const watermark = getLogs().latest;
  const fetcher = { fetchMedia: async () => { throw new DOMException('This operation was aborted', 'AbortError'); } } as unknown as Fetcher;
  const app = express();
  app.use('/api', createRouter(fetcher, { isRunning: false, run: async () => {} }, {} as ImageCache, 'test-secret'));
  const server = app.listen(0);
  try {
    const address = server.address();
    assert(address && typeof address !== 'string');
    const response = await fetch(signedProxyUrl(address.port, 'test-secret', 'https://nitter.click/video/clip.mp4'));
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'This operation was aborted' });
    assert.equal(getLogs({ after: watermark, minLevel: 'error' }).entries.some(entry => entry.scope === 'routes' && entry.message.includes('GET /proxy FAILED')), true);
  } finally {
    server.close();
  }
});

test('image timeouts remain visible as genuine upstream failures', async () => {
  const watermark = getLogs().latest;
  const imageCache = { get: async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); } } as unknown as ImageCache;
  const app = express();
  app.use('/api', createRouter({} as Fetcher, { isRunning: false, run: async () => {} }, imageCache, 'test-secret'));
  const server = app.listen(0);
  try {
    const address = server.address();
    assert(address && typeof address !== 'string');
    const response = await fetch(signedProxyUrl(address.port, 'test-secret', 'https://nitter.click/pic/slow.jpg'));
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'The operation was aborted due to timeout' });
    assert.equal(getLogs({ after: watermark, minLevel: 'error' }).entries.some(entry => entry.scope === 'routes' && entry.message.includes('due to timeout')), true);
  } finally {
    server.close();
  }
});

for (const status of [404, 410] as const) {
  test(`missing media returns HTTP ${status}, not a server failure`, async () => {
    const watermark = getLogs().latest;
    const missing = async (url: string) => { throw new MediaNotFoundError(status, url); };
    const imageCache = { get: missing } as unknown as ImageCache;
    const fetcher = { fetchMedia: missing } as unknown as Fetcher;
    const app = express();
    app.use('/api', createRouter(fetcher, { isRunning: false, run: async () => {} }, imageCache, 'test-secret'));
    const server = app.listen(0);
    try {
      const address = server.address();
      assert(address && typeof address !== 'string');
      for (const path of ['/pic/missing.jpg', '/video/missing.mp4']) {
        const response = await fetch(signedProxyUrl(address.port, 'test-secret', 'https://nitter.click' + path));
        assert.equal(response.status, status);
        assert.deepEqual(await response.json(), { error: 'Media not found' });
        assert.equal(response.headers.get('cache-control'), 'no-store');
      }
      assert.equal(getLogs({ after: watermark, minLevel: 'error' }).entries.some(entry => entry.scope === 'routes'), false);
    } finally {
      server.close();
    }
  });
}

function signedProxyUrl(port: number, secret: string, upstream: string): URL {
  const expires = String(Math.floor(Date.now() / 1000) + 3_600);
  const sig = createHmac('sha256', secret).update(`${expires}\n${upstream}`).digest('hex');
  const url = new URL(`http://127.0.0.1:${port}/api/proxy`);
  url.searchParams.set('url', upstream);
  url.searchParams.set('expires', expires);
  url.searchParams.set('sig', sig);
  return url;
}
