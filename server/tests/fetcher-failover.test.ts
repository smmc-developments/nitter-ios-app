import assert from 'node:assert/strict';
import test from 'node:test';
import { Fetcher } from '../src/fetcher.js';
import { NitterInstances } from '../src/instances.js';
import { isAllowedImageUrl, isAllowedVideoUrl } from '../src/image-cache.js';
import { MediaNotFoundError } from '../src/media-errors.js';

const first = 'https://first.example';
const second = 'https://second.example';
const third = 'https://third.example';
const html = '<div class="timeline">Posts</div>';

function apiResponse(status = 200, body = html) {
  return { status: () => status, ok: () => status >= 200 && status < 300, text: async () => body, dispose: async () => {} };
}

function setup(request: (url: string, options: unknown) => Promise<ReturnType<typeof apiResponse>>, automatic = true) {
  const instances = new NitterInstances({ automatic, baseUrl: first, discover: async () => [first, second, third] });
  const fetcher = new Fetcher(instances);
  const bootstraps: string[] = [];
  const cookiesFor: string[] = [];
  const state = fetcher as unknown as { ready: boolean; context: unknown; solveChallenge: (path: string, base: string) => Promise<void> };
  state.ready = true;
  state.context = {
    request: { fetch: request },
    cookies: async (url: string) => {
      cookiesFor.push(url);
      return [{ name: 'session', value: new URL(url).hostname }];
    },
  };
  state.solveChallenge = async (_path, base) => { bootstraps.push(base); };
  return { fetcher, instances, bootstraps, cookiesFor, state };
}

test('rate limits switch to another instance and preserve the requested path and query', async () => {
  const requested: string[] = [];
  const { fetcher, instances } = setup(async (url, options) => {
    requested.push(url);
    assert.deepEqual(options, { maxRedirects: 0, timeout: 30_000, headers: { 'user-agent': 'Mozilla/5.0' } });
    return apiResponse(url.startsWith(first) ? 429 : 200);
  });
  const path = '/nasa/with_replies?cursor=abc';
  assert.deepEqual(await fetcher.fetchPage(path), { html, baseUrl: second });
  assert.deepEqual(requested, [first + path, second + path]);
  assert.equal(await instances.select(), second);
});

test('network failures and incomplete HTML trigger failover', async () => {
  const { fetcher } = setup(async url => {
    if (url.startsWith(first)) throw new Error('Connection refused');
    return url.startsWith(second) ? apiResponse(200, '<html>Unavailable</html>') : apiResponse();
  });
  assert.deepEqual(await fetcher.fetchPage('/nasa'), { html, baseUrl: third });
});

test('expired sessions refresh on the same host before switching', async () => {
  const requested: string[] = [];
  const { fetcher, bootstraps } = setup(async url => {
    requested.push(url);
    return apiResponse(url.startsWith(first) ? 503 : 200);
  });
  assert.equal((await fetcher.fetchPage('/nasa')).baseUrl, second);
  assert.deepEqual(requested, [first + '/nasa', first + '/nasa', second + '/nasa']);
  assert.deepEqual(bootstraps, [first, first, second]);
});

test('a profile-only Anubis challenge is solved on the actual path with the same user agent', async () => {
  let calls = 0;
  const path = '/nasa/with_replies?cursor=abc';
  const { fetcher, state } = setup(async (_url, options) => {
    assert.equal((options as { headers: Record<string, string> }).headers['user-agent'], 'Mozilla/5.0');
    return ++calls === 1 ? apiResponse(200, '<title>Making sure you\'re not a bot!</title>') : apiResponse();
  });
  const challenged: Array<{ path: string; base: string }> = [];
  state.solveChallenge = async (path, base) => { challenged.push({ path, base }); };
  assert.deepEqual(await fetcher.fetchPage(path), { html, baseUrl: first });
  assert.deepEqual(challenged, [{ path: '/', base: first }, { path, base: first }]);
  assert.equal(calls, 2);
});

test('not-found errors do not switch instances', async () => {
  let calls = 0;
  const { fetcher } = setup(async () => { calls++; return apiResponse(404, 'Not found'); });
  await assert.rejects(fetcher.fetchPage('/missing'), /HTTP 404/);
  assert.equal(calls, 1);
});

test('failover is bounded to three instances and direct mode never switches', async () => {
  let calls = 0;
  const request = async () => { calls++; return apiResponse(429); };
  await assert.rejects(setup(request).fetcher.fetchPage('/nasa'), /429/);
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(setup(request, false).fetcher.fetchPage('/nasa'), /429/);
  assert.equal(calls, 1);
});

test('concurrent responses retain their own origins when another request switches hosts', async () => {
  let resolveSlow!: (response: ReturnType<typeof apiResponse>) => void;
  let started!: () => void;
  const slowStarted = new Promise<void>(resolve => { started = resolve; });
  const { fetcher } = setup(async url => {
    if (url === first + '/slow') {
      started();
      return new Promise(resolve => { resolveSlow = resolve; });
    }
    return apiResponse(url.startsWith(first) ? 429 : 200);
  });
  const slow = fetcher.fetchPage('/slow');
  await slowStarted;
  const fast = await fetcher.fetchPage('/fast');
  resolveSlow(apiResponse());
  assert.equal((await slow).baseUrl, first);
  assert.equal(fast.baseUrl, second);
});

test('concurrent failed session bootstraps are shared and both requests fail over', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { fetcher, state } = setup(async () => apiResponse());
  const bootstraps: string[] = [];
  state.solveChallenge = async (_path, base) => {
    bootstraps.push(base);
    if (base === first) { await gate; throw new Error('Challenge timed out'); }
  };
  const requests = [fetcher.fetchPage('/nasa'), fetcher.fetchPage('/other')];
  release();
  const results = await Promise.all(requests);
  assert.deepEqual(results.map(result => result.baseUrl), [second, second]);
  assert.deepEqual(bootstraps, [first, second]);
});

test('image requests fail over, use origin-specific cookies, and reject unknown hosts', async t => {
  const { fetcher, instances } = setup(async () => apiResponse());
  await instances.select();
  const requested: Array<{ url: string; cookie: string | undefined }> = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    requested.push({ url, cookie: (init.headers as Record<string, string>).cookie });
    return url.startsWith(first)
      ? new Response('Unavailable', { status: 502 })
      : new Response('image-bytes', { headers: { 'content-type': 'image/jpeg' } });
  });
  const response = await fetcher.fetchImage(first + '/pic/image.jpg?name=small');
  assert.equal(await response.text(), 'image-bytes');
  assert.deepEqual(requested, [
    { url: first + '/pic/image.jpg?name=small', cookie: 'session=first.example' },
    { url: second + '/pic/image.jpg?name=small', cookie: 'session=second.example' },
  ]);
  await assert.rejects(fetcher.fetchImage('https://unknown.example/pic/image.jpg'), /not allowed/);
  assert.equal(requested.length, 2);
  assert.equal(isAllowedImageUrl(first + '/pic/image.jpg', fetcher.nitterBaseUrls), true);
  assert.equal(isAllowedImageUrl('https://unknown.example/pic/image.jpg', fetcher.nitterBaseUrls), false);
});

for (const status of [404, 410] as const) {
  test(`missing images (HTTP ${status}) do not retry other hosts or cool down a healthy instance`, async t => {
    const { fetcher, instances } = setup(async () => apiResponse());
    await instances.select();
    const request = t.mock.method(globalThis, 'fetch', async () => new Response('Missing', { status, headers: { 'content-type': 'text/html;charset=utf-8' } }));
    const url = first + `/pic/missing-${status}.jpg`;
    await assert.rejects(fetcher.fetchImage(url), error => {
      assert.ok(error instanceof MediaNotFoundError);
      assert.equal(error.status, status);
      assert.equal(error.url, url);
      return true;
    });
    assert.equal(request.mock.callCount(), 1);
    assert.equal(await instances.select(), first);
  });
}

test('missing video resources do not cool down a healthy instance', async t => {
  const { fetcher, instances } = setup(async () => apiResponse());
  await instances.select();
  const request = t.mock.method(globalThis, 'fetch', async () => new Response('Missing', { status: 404, headers: { 'content-type': 'text/html' } }));
  await assert.rejects(fetcher.fetchMedia(first + '/video/missing.mp4', {}, new AbortController().signal, 'GET', url => isAllowedVideoUrl(url, fetcher.nitterBaseUrls)), MediaNotFoundError);
  assert.equal(request.mock.callCount(), 1);
  assert.equal(await instances.select(), first);
});

test('video failover preserves range headers and never leaks session cookies to the Twitter CDN', async t => {
  const { fetcher, instances } = setup(async () => apiResponse());
  await instances.select();
  const requests: Array<{ url: string; headers: Record<string, string>; method: string }> = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    requests.push({ url, headers: init.headers as Record<string, string>, method: init.method! });
    if (url.startsWith(first)) return new Response('Failed', { status: 502 });
    if (url.startsWith(second)) return new Response(null, { status: 302, headers: { location: 'https://video.twimg.com/clip.mp4' } });
    return new Response('data', { status: 206, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-3/10' } });
  });
  const response = await fetcher.fetchMedia(first + '/video/clip.mp4', { range: 'bytes=0-3', 'if-range': 'etag' }, new AbortController().signal, 'GET', url => isAllowedVideoUrl(url, fetcher.nitterBaseUrls));
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 0-3/10');
  assert.equal(await response.text(), 'data');
  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.equal(request.headers.range, 'bytes=0-3');
    assert.equal(request.headers['if-range'], 'etag');
    assert.equal(request.method, 'GET');
  }
  assert.equal(requests[0].headers.cookie, 'session=first.example');
  assert.equal(requests[1].headers.cookie, 'session=second.example');
  assert.equal(requests[2].headers.cookie, undefined);
});

test('media redirects to unknown or internal origins are not followed', async t => {
  const { fetcher, instances } = setup(async () => apiResponse());
  await instances.select();
  const requested: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    requested.push(url);
    return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/video/clip.mp4' } });
  });
  await assert.rejects(fetcher.fetchMedia(first + '/video/clip.mp4', {}, new AbortController().signal, 'GET', url => isAllowedVideoUrl(url, fetcher.nitterBaseUrls)), /redirect target is not allowed/);
  assert.equal(requested.length, 3);
  assert.equal(requested.some(url => url.includes('127.0.0.1')), false);
});

test('unsatisfiable video ranges are returned without marking the instance unhealthy', async t => {
  const { fetcher, instances } = setup(async () => apiResponse());
  await instances.select();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response(null, { status: 416, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes */10' } });
  });
  const response = await fetcher.fetchMedia(first + '/video/clip.mp4', { range: 'bytes=100-200' }, new AbortController().signal, 'GET', url => isAllowedVideoUrl(url, fetcher.nitterBaseUrls));
  assert.equal(response.status, 416);
  assert.equal(calls, 1);
  assert.equal(await instances.select(), first);
});

test('cancelled video requests do not fetch or cool down a healthy instance', async t => {
  const { fetcher, instances } = setup(async () => apiResponse());
  await instances.select();
  const request = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Must not fetch'); });
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(fetcher.fetchMedia(first + '/video/clip.mp4', {}, abort.signal, 'GET', url => isAllowedVideoUrl(url, fetcher.nitterBaseUrls)), /abort/i);
  assert.equal(request.mock.callCount(), 0);
  assert.equal(await instances.select(), first);
});
