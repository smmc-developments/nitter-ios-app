import assert from 'node:assert/strict';
import test from 'node:test';
import { selectAccountsForCycle } from '../src/scheduling.js';

const now = Date.parse('2026-07-21T00:00:00.000Z');

function account(
  username: string,
  lastFetched: string | null,
  lastTweet: string | null,
  consecutiveFailures = 0,
): TestAccount {
  return {
    username,
    display_name: null,
    avatar_url: null,
    last_fetched_at: lastFetched,
    fetch_error: null,
    last_tweet_at: lastTweet,
    consecutive_failures: consecutiveFailures,
  };
}

interface TestAccount {
  username: string;
  display_name: null;
  avatar_url: null;
  last_fetched_at: string | null;
  fetch_error: null;
  last_tweet_at: string | null;
  consecutive_failures: number;
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

test('first failure still retries on the normal schedule', () => {
  const selected = selectAccountsForCycle([
    account('failing', '2026-07-20 23:59:30.000Z', '2026-07-20T23:00:00.000Z', 1),
  ], 15 * 60_000, 10, now);
  assert.deepEqual(selected.map(a => a.username), ['failing']);
});

test('repeated failures back off to hourly, then six-hourly, then daily', () => {
  // Fetched 30 minutes ago (due on the normal 15m schedule) with 3 failures → hourly backoff.
  assert.deepEqual(selectAccountsForCycle(
    [account('three', '2026-07-20 23:30:00', '2026-07-20T23:00:00.000Z', 3)],
    15 * 60_000, 10, now,
  ).map(a => a.username), []);

  // Fetched 2 hours ago with 5 failures → six-hour backoff still blocks.
  assert.deepEqual(selectAccountsForCycle(
    [account('five', '2026-07-20 22:00:00', '2026-07-20T21:00:00.000Z', 5)],
    15 * 60_000, 10, now,
  ).map(a => a.username), []);

  // Fetched 2 hours ago with 10 failures → daily backoff blocks.
  assert.deepEqual(selectAccountsForCycle(
    [account('ten', '2026-07-20 22:00:00', '2026-07-20T21:00:00.000Z', 10)],
    15 * 60_000, 10, now,
  ).map(a => a.username), []);

  // Fetched 7 hours ago with 5 failures → six-hour backoff has elapsed.
  assert.deepEqual(selectAccountsForCycle(
    [account('five-old', '2026-07-20 17:00:00', '2026-07-20T16:00:00.000Z', 5)],
    15 * 60_000, 10, now,
  ).map(a => a.username), ['five-old']);
});
