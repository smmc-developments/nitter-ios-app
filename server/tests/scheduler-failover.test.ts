import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ImageCache } from '../src/image-cache.js';

const dataDir = mkdtempSync(join(tmpdir(), 'nitter-scheduler-failover-'));
process.env.DATA_DIR = dataDir;
process.env.FETCH_START_INTERVAL_MS = '1';
const { Fetcher } = await import('../src/fetcher.js');
const { NitterInstances } = await import('../src/instances.js');
const { selectAccountsForCycle } = await import('../src/scheduling.js');
const database = await import('../src/db.js');
assert.equal(database.default.name, join(dataDir, 'nitter.db'));
const { Scheduler } = await import('../src/scheduler.js');

test.after(() => {
  database.default.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const first = 'https://first.example';
const second = 'https://second.example';
const third = 'https://third.example';

function setup(allBlocked = false) {
  const requested: string[] = [];
  const instances = new NitterInstances({ automatic: true, baseUrl: first, discover: async () => [first, second, third] });
  const fetcher = new Fetcher(instances);
  const state = fetcher as unknown as { ready: boolean; context: unknown; solveChallenge(): Promise<void> };
  state.ready = true;
  state.solveChallenge = async () => {};
  state.context = { request: { fetch: async (url: string) => {
    requested.push(url);
    const blocked = allBlocked || url.startsWith(first);
    const username = new URL(url).pathname.split('/')[1];
    const id = username === 'alice' ? '1234567890' : '1234567891';
    const html = `<div class="timeline"><div class="timeline-item" data-username="${username}">
      <a class="tweet-link" href="/${username}/status/${id}"></a>
      <div class="tweet-body"><div class="tweet-header">
        <a class="fullname">${username}</a><a class="username">@${username}</a>
        <span class="tweet-date"><a title="Oct 18, 2026 · 8:33 PM UTC"></a></span>
      </div><div class="tweet-content">New post from ${username}</div></div>
    </div></div>`;
    return {
      status: () => blocked ? 418 : 200,
      ok: () => !blocked,
      text: async () => blocked ? "I'm a teapot" : html,
      dispose: async () => {},
    };
  } } };
  const imageCache = { prefetch: () => {} } as unknown as ImageCache;
  return { requested, scheduler: new Scheduler(fetcher, imageCache) };
}

test('a normal cycle recovers accounts stuck on daily 418 backoff and ingests new feed posts', async () => {
  for (const username of ['alice', 'bob']) {
    database.addAccount(username);
    database.default.prepare(`UPDATE accounts
      SET last_fetched_at = datetime('now', '-20 hours'), consecutive_failures = 12, fetch_error = ?
      WHERE username = ?`).run(`Nitter returned HTTP 418 for /${username}/with_replies`, username);
  }
  const { requested, scheduler } = setup();
  await scheduler.run(); // Not a forced/manual refresh: normal scheduling must recover too.
  assert.ok(requested.some(url => url.startsWith(first)));
  for (const username of ['alice', 'bob']) {
    assert.ok(requested.includes(`${second}/${username}/with_replies`));
    assert.equal(database.getAccount(username)?.fetch_error, null);
    assert.equal(database.getAccount(username)?.consecutive_failures, 0);
    assert.equal(database.getTimeline(username, 10)[0]?.text_content, `New post from ${username}`);
  }
  assert.equal(database.getFeed(10).length, 2);
});

test('exhausted instance failover records the outage without imposing daily account backoff', async () => {
  database.addAccount('blocked');
  const { requested, scheduler } = setup(true);
  await scheduler.run();
  assert.equal(requested.length, 3);
  const account = database.getAccount('blocked');
  assert.ok(account?.fetch_error?.includes('HTTP 418'));
  assert.equal(account?.consecutive_failures, 0);
  const nextCycle = selectAccountsForCycle(database.listAccounts(), 15 * 60_000, 40, Date.now() + 16 * 60_000);
  assert.ok(nextCycle.some(value => value.username === 'blocked'));
});
