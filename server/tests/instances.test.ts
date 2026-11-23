import assert from 'node:assert/strict';
import test from 'node:test';
import { automaticInstances, discoverInstances, isPublicAddress, NitterInstances, parseInstanceOrigins, shareBaseUrl, XNOTME_URL, XXCANCEL_URL } from '../src/instances.js';
import { getLogs } from '../src/logger.js';

const first = 'https://first.example';
const second = 'https://second.example';
const fallback = 'https://fallback.example';

test('discovery reads only dispatcher controls and instance options, preserving preference order', () => {
  const html = `
    <a href="https://unrelated.example/nasa">An unrelated link</a>
    <div id="redirect-controls" data-redirect-url="${second}/nasa"></div>
    <a id="open-now" href="${second}/nasa"></a>
    <section id="instance-options">
      <a href="${first}/nasa">First</a><a href="${second}/nasa">Duplicate</a>
      <details><a href="https://third.example/nasa">Other instance</a></details>
    </section>`;
  assert.deepEqual(parseInstanceOrigins(html), [second, first, 'https://third.example']);
});

test('discovery rejects unsafe hosts, credentials, ports, and unexpected paths', () => {
  const urls = [
    'http://plain.example/nasa', 'https://user:password@auth.example/nasa',
    'https://127.0.0.1/nasa', 'https://[::1]/nasa', 'https://2130706433/nasa',
    'https://localhost/nasa', 'https://service.local/nasa', 'https://private.internal/nasa',
    'https://instance.example:8443/nasa', 'https://instance.example/admin',
    'https://instance.example/nasa?url=https://internal', 'https://instance.example/nasa#fragment',
    'https://xxcancel.com/nasa', 'https://xnotme.com/nasa', 'javascript:alert(1)',
  ];
  const html = `<section id="instance-options">${urls.map(url => `<a href="${url}">Bad</a>`).join('')}<a href="${first}/nasa">Good</a></section>`;
  assert.deepEqual(parseInstanceOrigins(html), [first]);
});

test('discovery refuses non-public DNS addresses including IPv6 and mapped IPv4', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.1.1', '172.16.0.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2001:db8::1', 'not-an-ip']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress('93.184.216.34'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

test('discovery only approves hosts whose DNS answers are all public', async t => {
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, `${XNOTME_URL}/nasa`);
    assert.equal(init.redirect, 'manual');
    return new Response(`<div id="instance-options"><a href="${first}/nasa">First</a><a href="${second}/nasa">Second</a></div>`);
  });
  const origins = await discoverInstances(async host => host === 'first.example'
    ? [{ address: '93.184.216.34' }, { address: '127.0.0.1' }]
    : [{ address: '2606:4700:4700::1111' }]);
  assert.deepEqual(origins, [second]);
});

test('discovery refuses malformed dispatcher pages rather than trusting unrelated external links', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('<a href="https://unknown.example/nasa">Not an instance option</a>'));
  await assert.rejects(discoverInstances(async () => [{ address: '93.184.216.34' }]), /did not advertise any usable/);
});

test('discovery follows only trusted dispatcher redirects, cancels their bodies, and shares one deadline', async t => {
  const requested: string[] = [];
  const signals: AbortSignal[] = [];
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    requested.push(url);
    signals.push(init.signal as AbortSignal);
    if (requested.length === 1) return new Response(new ReadableStream({
      cancel() { cancelled = true; },
    }), { status: 301, headers: { location: `${XXCANCEL_URL}/nasa` } });
    return new Response(`<div id="instance-options"><a href="${first}/nasa">First</a></div>`);
  });
  assert.deepEqual(await discoverInstances(async () => [{ address: '93.184.216.34' }]), [first]);
  assert.deepEqual(requested, [`${XNOTME_URL}/nasa`, `${XXCANCEL_URL}/nasa`]);
  assert.equal(cancelled, true);
  assert.ok(signals[0] instanceof AbortSignal);
  assert.equal(signals[0], signals[1]);
});

test('discovery rejects unsafe redirect destinations without requesting them', async t => {
  for (const location of [
    'http://xnotme.com/nasa', 'https://127.0.0.1/nasa', 'https://unknown.example/nasa',
    'https://xnotme.com:8443/nasa', 'https://user:secret@xnotme.com/nasa',
    'https://xnotme.com/admin', 'https://xxcancel.com/nasa?url=https://internal',
    'https://xnotme.com/nasa#fragment', 'http://[invalid',
  ]) {
    const request = t.mock.method(globalThis, 'fetch', async () =>
      new Response(null, { status: 302, headers: { location } }));
    await assert.rejects(discoverInstances(), /redirect destination is not allowed|invalid redirect/);
    assert.equal(request.mock.callCount(), 1, location);
    request.mock.restore();
  }
});

test('discovery redirect loops are bounded', async t => {
  const request = t.mock.method(globalThis, 'fetch', async () =>
    new Response(null, { status: 308, headers: { location: '/nasa' } }));
  await assert.rejects(discoverInstances(), /redirected too many times/);
  assert.equal(request.mock.callCount(), 4);
});

test('discovery reports redirects without a Location and HTTP errors clearly', async t => {
  const request = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 301 }));
  await assert.rejects(discoverInstances(), /missing Location/);
  request.mock.restore();
  t.mock.method(globalThis, 'fetch', async () => new Response('Unavailable', { status: 503 }));
  await assert.rejects(discoverInstances(), /HTTP 503/);
});

test('direct configuration does not invoke discovery or change instance on failure', async () => {
  const pool = new NitterInstances({ automatic: false, baseUrl: fallback, discover: async () => { throw new Error('Must not discover'); } });
  assert.equal(await pool.select(), fallback);
  pool.failed(fallback);
  assert.equal(await pool.select(), fallback);
  assert.equal(pool.isInstanceUrl(`${first}/pic/image.jpg`), false);
});

test('automatic mode switches instances and respects cooldowns', async () => {
  let now = 0;
  const pool = new NitterInstances({ automatic: true, baseUrl: fallback, discover: async () => [first, second], now: () => now });
  assert.equal(await pool.select(), first);
  pool.failed(first);
  assert.equal(await pool.select(), second);
  pool.failed(second);
  assert.equal(await pool.select(), fallback);
  pool.failed(fallback);
  await assert.rejects(pool.select(), /No healthy Nitter instance/);
  now += 5 * 60_000;
  assert.equal(await pool.select(), first);
});

test('concurrent requests share one discovery and periodically refresh the list', async () => {
  let now = 0;
  let calls = 0;
  const pool = new NitterInstances({ automatic: true, baseUrl: fallback, now: () => now, discover: async () => { calls++; return [first]; } });
  assert.deepEqual(await Promise.all([pool.select(), pool.select(), pool.select()]), [first, first, first]);
  assert.equal(calls, 1);
  now += 15 * 60_000;
  await pool.select();
  assert.equal(calls, 2);
});

test('discovery outages retain previously known instances and the configured fallback', async () => {
  let now = 0;
  let unavailable = false;
  const pool = new NitterInstances({ automatic: true, baseUrl: fallback, now: () => now, discover: async () => {
    if (unavailable) throw new Error('Dispatcher offline');
    return [first, second];
  } });
  assert.equal(await pool.select(), first);
  unavailable = true;
  now += 15 * 60_000;
  pool.failed(first);
  assert.equal(await pool.select(), second);
  pool.failed(second);
  assert.equal(await pool.select(), fallback);
  assert.equal(pool.isInstanceUrl(`${first}/pic/cached.jpg`), true);
  assert.equal(pool.isInstanceUrl('https://unknown.example/pic/image.jpg'), false);
});

test('a first-start discovery outage falls back to the configured instance', async () => {
  const pool = new NitterInstances({ automatic: true, baseUrl: fallback, discover: async () => { throw new Error('Offline'); } });
  assert.equal(await pool.select(), fallback);
});

test('both dispatcher aliases select real instances rather than fetching a dispatcher as Nitter', async () => {
  for (const baseUrl of [XNOTME_URL, XXCANCEL_URL]) {
    const pool = new NitterInstances({ automatic: true, baseUrl, discover: async () => [first] });
    assert.equal(await pool.select(), first);
    assert.equal(pool.isInstanceUrl(`${XNOTME_URL}/pic/image.jpg`), false);
    assert.equal(pool.isInstanceUrl(`${XXCANCEL_URL}/pic/image.jpg`), false);
    assert.equal(pool.isInstanceUrl('https://nitter.click/pic/image.jpg'), true);
  }
});

test('new and legacy dispatcher configuration enable automatic mode and canonical share links', () => {
  const originalBase = process.env.NITTER_BASE_URL;
  const originalAuto = process.env.NITTER_AUTO_INSTANCE;
  try {
    process.env.NITTER_AUTO_INSTANCE = 'false';
    for (const base of [XNOTME_URL, XXCANCEL_URL]) {
      process.env.NITTER_BASE_URL = base + '/';
      assert.equal(automaticInstances(), true);
      assert.equal(shareBaseUrl(), XNOTME_URL);
    }
    process.env.NITTER_BASE_URL = fallback;
    assert.equal(automaticInstances(), false);
    assert.equal(shareBaseUrl(), fallback);
  } finally {
    if (originalBase === undefined) delete process.env.NITTER_BASE_URL;
    else process.env.NITTER_BASE_URL = originalBase;
    if (originalAuto === undefined) delete process.env.NITTER_AUTO_INSTANCE;
    else process.env.NITTER_AUTO_INSTANCE = originalAuto;
  }
});

test('discovery network warnings retain known instances and expose the sanitized underlying cause', async () => {
  const watermark = getLogs().latest;
  const error = new TypeError('fetch failed', {
    cause: Object.assign(new Error('getaddrinfo ENOTFOUND xnotme.com\nCall log:\n  - cookie: secret-cookie'), { code: 'ENOTFOUND' }),
  });
  const pool = new NitterInstances({ automatic: true, baseUrl: fallback, discover: async () => { throw error; } });
  assert.equal(await pool.select(), fallback);
  const entry = getLogs({ after: watermark }).entries.find(entry => entry.scope === 'instances' && entry.level === 'warn');
  assert.ok(entry?.message.includes('ENOTFOUND'));
  assert.ok(entry?.message.includes(XNOTME_URL));
  assert.ok(!entry?.message.includes('secret-cookie'));
  assert.ok(!entry?.message.includes('Call log:'));
});

test('bounded media history always retains the active, fallback, and current candidate origins', async () => {
  let now = 0;
  let generation = 0;
  const pool = new NitterInstances({ automatic: true, baseUrl: fallback, now: () => now, discover: async () =>
    Array.from({ length: 20 }, (_, index) => `https://instance-${generation}-${index}.example`) });
  const active = await pool.select();
  for (generation = 1; generation <= 5; generation++) {
    now += 15 * 60_000;
    assert.equal(await pool.select(), active);
    assert.ok(pool.baseUrls.length <= 64);
    assert.ok(pool.baseUrls.includes(fallback));
    assert.ok(pool.baseUrls.includes(`https://instance-${generation}-19.example`));
  }
});
