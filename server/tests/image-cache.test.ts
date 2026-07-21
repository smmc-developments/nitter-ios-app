import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Fetcher } from '../src/fetcher.js';

const dataDir = mkdtempSync(join(tmpdir(), 'xcancel-images-'));
process.env.DATA_DIR = dataDir;
const { ImageCache, isAllowedImageUrl, isAllowedVideoUrl } = await import('../src/image-cache.js');

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

test('stores an image on disk and reuses it without another upstream request', async () => {
  let requests = 0;
  const body = Buffer.from('fake-image');
  const fetcher = {
    getContext: () => ({
      request: {
        fetch: async () => {
          requests++;
          return {
            status: () => 200,
            ok: () => true,
            headers: () => ({ 'content-type': 'image/jpeg', 'content-length': String(body.length) }),
            body: async () => body,
          };
        },
      },
    }),
    ensureSession: async () => {},
  } as unknown as Fetcher;
  const url = 'https://nitter.poast.org/pic/media%2Fexample.jpg';

  const firstCache = new ImageCache(fetcher);
  assert.deepEqual((await firstCache.get(url)).body, body);
  const secondCache = new ImageCache(fetcher);
  assert.deepEqual((await secondCache.get(url)).body, body);
  assert.equal(requests, 1);
});

test('video allowlist accepts only the configured Nitter video path', () => {
  assert.equal(isAllowedVideoUrl('https://nitter.poast.org/video/vid.twimg.com%2Fclip.mp4'), true);
  assert.equal(isAllowedVideoUrl('https://nitter.poast.org/pic/video.twimg.com%2Ftweet_video%2Fclip.mp4'), true);
  assert.equal(isAllowedVideoUrl('https://nitter.poast.org/pic/video.twimg.com%2Ftweet_video%2Fclip.mp4%3Ftag%3D12'), true);
  assert.equal(isAllowedVideoUrl('https://video.twimg.com/tweet_video/clip.mp4?tag=12'), true);
  assert.equal(isAllowedImageUrl('https://nitter.poast.org/pic/video.twimg.com%2Ftweet_video%2Fclip.mp4'), false);
  assert.equal(isAllowedVideoUrl('https://nitter.poast.org/pic/poster.jpg'), false);
  assert.equal(isAllowedVideoUrl('https://example.com/video/clip.mp4'), false);
});
