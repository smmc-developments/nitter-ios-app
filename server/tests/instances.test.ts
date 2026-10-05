import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverInstances, isPublicAddress, NitterInstances, parseInstanceOrigins } from '../src/instances.js';

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
    'https://xxcancel.com/nasa', 'javascript:alert(1)',
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
    assert.equal(url, 'https://xxcancel.com/nasa');
    assert.equal(init.redirect, 'error');
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

test('using xxcancel as the base selects real instances rather than fetching the dispatcher as Nitter', async () => {
  const pool = new NitterInstances({ automatic: true, baseUrl: 'https://xxcancel.com', discover: async () => [first] });
  assert.equal(await pool.select(), first);
  assert.equal(pool.isInstanceUrl('https://xxcancel.com/pic/image.jpg'), false);
  assert.equal(pool.isInstanceUrl('https://nitter.click/pic/image.jpg'), true);
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
