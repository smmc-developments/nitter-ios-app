import assert from 'node:assert/strict';
import test from 'node:test';
import { cursorPath, selectAccountsForCycle } from '../src/scheduling.js';

const now = Date.parse('2026-07-21T00:00:00.000Z');

function account(
  username: string,
  lastFetched: string | null,
  lastTweet: string | null,
): TestAccount {
  return {
    username,
    display_name: null,
    avatar_url: null,
    last_fetched_at: lastFetched,
    fetch_error: null,
    last_tweet_at: lastTweet,
  };
}

interface TestAccount {
  username: string;
  display_name: null;
  avatar_url: null;
  last_fetched_at: string | null;
  fetch_error: null;
  last_tweet_at: string | null;
}

test('automatic cycle selects due accounts and prioritizes new then active accounts', () => {
  const selected = selectAccountsForCycle([
    account('warm-not-due', '2026-07-20 23:30:00', '2026-07-19T00:00:00.000Z'),
    account('dormant', '2026-07-20 16:00:00', '2026-06-01T00:00:00.000Z'),
    account('active', '2026-07-20 23:30:00', '2026-07-20T23:00:00.000Z'),
    account('never-fetched', null, null),
  ], 15 * 60_000, 2, now);

  assert.deepEqual(selected.map(a => a.username), ['never-fetched', 'active']);
});

test('dormant accounts use a six-hour interval', () => {
  const selected = selectAccountsForCycle([
    account('not-due', '2026-07-20 19:00:00', '2026-06-01T00:00:00.000Z'),
    account('due', '2026-07-20 17:00:00', '2026-06-01T00:00:00.000Z'),
  ], 15 * 60_000, 10, now);

  assert.deepEqual(selected.map(a => a.username), ['due']);
});

test('cursor links stay on the requested account timeline', () => {
  assert.equal(
    cursorPath('/alice/with_replies', '?cursor=abc123'),
    '/alice/with_replies?cursor=abc123',
  );
  assert.equal(cursorPath('/alice', 'https://example.com/'), null);
});
