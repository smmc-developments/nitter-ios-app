import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'twv-images-'));
process.env.DATA_DIR = dataDir;
const { ImageCache, isAllowedImageUrl, isAllowedVideoUrl } = await import('../src/image-cache.js');

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

test('stores an image on disk and reuses it without another upstream request', async () => {
  let requests = 0;
  const body = Buffer.from('fake-image');
  const url = 'https://pbs.twimg.com/media/example.jpg';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    requests++;
    return new Response(body, { headers: { 'content-type': 'image/jpeg', 'content-length': String(body.length) } });
  }) as typeof fetch;

  try {
    const firstCache = new ImageCache();
    assert.deepEqual((await firstCache.get(url)).body, body);
    const secondCache = new ImageCache();
    assert.deepEqual((await secondCache.get(url)).body, body);
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('media allowlist accepts only Twitter CDN hosts', () => {
  assert.equal(isAllowedImageUrl('https://pbs.twimg.com/media/example.jpg'), true);
  assert.equal(isAllowedImageUrl('https://pbs.twimg.com/profile_images/1/a.jpg'), true);
  assert.equal(isAllowedImageUrl('https://pbs.twimg.com/media/video_poster.jpg.mp4'), false);
  assert.equal(isAllowedVideoUrl('https://video.twimg.com/amplify_video/1/vid/avc1/1280x720/clip.mp4?tag=29'), true);
  assert.equal(isAllowedVideoUrl('https://video.twimg.com/tweet_video/clip.mp4?tag=12'), true);
  assert.equal(isAllowedVideoUrl('https://pbs.twimg.com/tweet_video/clip.mp4'), true);
  assert.equal(isAllowedVideoUrl('https://pbs.twimg.com/media/poster.jpg'), false);
  assert.equal(isAllowedImageUrl('https://example.com/pic/media%2Fexample.jpg'), false);
  assert.equal(isAllowedVideoUrl('https://example.com/video/clip.mp4'), false);
  assert.equal(isAllowedVideoUrl('http://video.twimg.com/tweet_video/clip.mp4'), false);
});
