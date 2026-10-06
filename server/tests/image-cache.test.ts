import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import type { Fetcher } from '../src/fetcher.js';
import { MediaNotFoundError } from '../src/media-errors.js';
import { getLogs } from '../src/logger.js';

const dataDir = mkdtempSync(join(tmpdir(), 'nitter-images-'));
process.env.DATA_DIR = dataDir;
const { ImageCache, isAllowedImageUrl, isAllowedVideoUrl } = await import('../src/image-cache.js');

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

test('stores an image on disk and reuses it without another upstream request', async () => {
  let requests = 0;
  const body = Buffer.from('fake-image');
  const fetcher = {
    fetchImage: async () => {
      requests++;
      return new Response(body, { headers: { 'content-type': 'image/jpeg', 'content-length': String(body.length) } });
    },
  } as unknown as Fetcher;
  const url = 'https://nitter.click/pic/media%2Fexample.jpg';

  const firstCache = new ImageCache(fetcher);
  assert.deepEqual((await firstCache.get(url)).body, body);
  const secondCache = new ImageCache(fetcher);
  assert.deepEqual((await secondCache.get(url)).body, body);
  assert.equal(requests, 1);
});

test('video allowlist accepts only the configured Nitter video path', () => {
  assert.equal(isAllowedVideoUrl('https://nitter.click/video/vid.twimg.com%2Fclip.mp4'), true);
  assert.equal(isAllowedVideoUrl('https://nitter.click/pic/video.twimg.com%2Ftweet_video%2Fclip.mp4'), true);
  assert.equal(isAllowedVideoUrl('https://nitter.click/pic/video.twimg.com%2Ftweet_video%2Fclip.mp4%3Ftag%3D12'), true);
  assert.equal(isAllowedVideoUrl('https://video.twimg.com/tweet_video/clip.mp4?tag=12'), true);
  assert.equal(isAllowedImageUrl('https://pbs.twimg.com/media/example.jpg'), true);
  assert.equal(isAllowedImageUrl('https://nitter.click/pic/video.twimg.com%2Ftweet_video%2Fclip.mp4'), false);
  assert.equal(isAllowedVideoUrl('https://nitter.click/pic/poster.jpg'), false);
  assert.equal(isAllowedVideoUrl('https://example.com/video/clip.mp4'), false);
});

test('rejects oversized image streams without buffering the entire response', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(10 * 1024 * 1024));
      controller.enqueue(new Uint8Array(1));
    },
    cancel() { cancelled = true; },
  });
  const fetcher = { fetchImage: async () => new Response(stream, { headers: { 'content-type': 'image/jpeg' } }) } as unknown as Fetcher;
  await assert.rejects(new ImageCache(fetcher).get('https://nitter.click/pic/oversized.jpg'), /Image is too large/);
  assert.equal(cancelled, true);
});

test('missing images are briefly cached, skipped during prefetch, and retried after expiry', async () => {
  let now = 0;
  let requests = 0;
  let available = false;
  const url = 'https://nitter.click/pic/missing-then-restored.jpg';
  const fetcher = { fetchImage: async () => {
    requests++;
    if (!available) throw new MediaNotFoundError(404, url);
    return new Response('restored-image', { headers: { 'content-type': 'image/jpeg' } });
  } } as unknown as Fetcher;
  const cache = new ImageCache(fetcher, () => now);
  const results = await Promise.allSettled([cache.get(url), cache.get(url)]);
  assert.ok(results.every(result => result.status === 'rejected' && result.reason instanceof MediaNotFoundError));
  assert.equal(requests, 1);
  await assert.rejects(cache.get(url), MediaNotFoundError);
  cache.prefetch([url]);
  assert.equal(requests, 1);

  available = true;
  now += 5 * 60_000;
  assert.equal((await cache.get(url)).body.toString(), 'restored-image');
  assert.equal(requests, 2);
  assert.equal((await cache.get(url)).body.toString(), 'restored-image');
  assert.equal(requests, 2);
});

test('missing-image prefetch does not log an error', async t => {
  const watermark = getLogs().latest;
  const url = 'https://nitter.click/pic/prefetch-missing.jpg';
  const cache = new ImageCache({} as Fetcher);
  const get = t.mock.method(cache, 'get', async () => { throw new MediaNotFoundError(404, url); });
  cache.prefetch([url]);
  await setImmediate();
  assert.equal(get.mock.callCount(), 1);
  assert.equal(getLogs({ after: watermark, minLevel: 'error' }).entries.some(entry => entry.scope === 'image-cache'), false);
});

test('genuine prefetch failures remain visible and include the affected URL', async t => {
  const watermark = getLogs().latest;
  const url = 'https://nitter.click/pic/prefetch-failed.jpg';
  const cache = new ImageCache({} as Fetcher);
  t.mock.method(cache, 'get', async () => { throw new Error('Upstream image request returned HTTP 503'); });
  cache.prefetch([url]);
  await setImmediate();
  assert.equal(getLogs({ after: watermark, minLevel: 'error' }).entries.some(entry => entry.scope === 'image-cache' && entry.message.includes('HTTP 503') && entry.message.includes(url)), true);
});
