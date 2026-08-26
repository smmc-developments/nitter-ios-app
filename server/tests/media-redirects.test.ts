import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

// Redirect target ("attacker"/other host) — records whether it was hit.
let targetHits = 0;
const target = http.createServer((req, res) => {
  targetHits++;
  res.writeHead(200, { 'content-type': 'video/mp4' });
  res.end('video-bytes');
});
await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
const targetPort = (target.address() as AddressInfo).port;

// Allowlisted origin — serves redirects like a media host would.
const origin = http.createServer((req, res) => {
  if (req.url === '/video/clip.mp4') {
    res.writeHead(302, { location: `http://127.0.0.1:${targetPort}/clip.mp4` });
    return res.end();
  }
  if (req.url === '/video/loop.mp4') {
    res.writeHead(302, { location: '/video/loop.mp4' });
    return res.end();
  }
  res.writeHead(404);
  res.end();
});
await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve));
const originPort = (origin.address() as AddressInfo).port;
const originUrl = `http://127.0.0.1:${originPort}`;

const { Fetcher } = await import('../src/fetcher.js');

test.after(() => {
  origin.close();
  target.close();
});

function createFetcher(): Fetcher {
  const fetcher = new Fetcher() as unknown as {
    ready: boolean;
    userAgent: string;
    fetchMedia: Fetcher['fetchMedia'];
  };
  fetcher.ready = true;
  fetcher.userAgent = 'redirect-test';
  return fetcher as unknown as Fetcher;
}

const allowAll = () => true;

test('fetchMedia follows allowlisted redirects', async () => {
  const fetcher = createFetcher();
  const response = await fetcher.fetchMedia(
    `${originUrl}/video/clip.mp4`, {}, AbortSignal.timeout(10_000), 'GET', allowAll,
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'video-bytes');
  assert.equal(targetHits, 1);
});

test('fetchMedia blocks redirects rejected by the allowlist', async () => {
  targetHits = 0;
  const fetcher = createFetcher();
  const rejectTarget = (url: string) => new URL(url).port === String(originPort);
  await assert.rejects(
    fetcher.fetchMedia(`${originUrl}/video/clip.mp4`, {}, AbortSignal.timeout(10_000), 'GET', rejectTarget),
    /redirect target is not allowed/i,
  );
  assert.equal(targetHits, 0);
});

test('fetchMedia gives up after too many redirects', async () => {
  const fetcher = createFetcher();
  await assert.rejects(
    fetcher.fetchMedia(`${originUrl}/video/loop.mp4`, {}, AbortSignal.timeout(10_000), 'GET', allowAll),
    /redirected too many times/i,
  );
});
