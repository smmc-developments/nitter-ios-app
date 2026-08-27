export interface SchedulableAccount {
  last_fetched_at: string | null;
  last_tweet_at: string | null;
  consecutive_failures?: number;
}

export function selectAccountsForCycle<T extends SchedulableAccount>(
  accounts: T[],
  baseIntervalMs: number,
  limit: number,
  now = Date.now(),
): T[] {
  return accounts
    .map(account => {
      const lastTweet = parseSqlDate(account.last_tweet_at);
      const lastFetch = parseSqlDate(account.last_fetched_at);
      const tweetAge = lastTweet === null ? Infinity : now - lastTweet;
      const interval = tweetAge < 24 * 60 * 60_000
        ? baseIntervalMs
        : tweetAge < 7 * 24 * 60 * 60_000
          ? Math.max(baseIntervalMs, 60 * 60_000)
          : Math.max(baseIntervalMs, 6 * 60 * 60_000);
      // Accounts failing upstream (deleted, suspended, API errors) back off
      // exponentially-ish so a handful of dead handles cannot dominate every
      // cycle or spam the logs.
      const failureBackoffMs = failureBackoff(account.consecutive_failures ?? 0);
      const due = lastFetch === null || now - lastFetch >= Math.max(interval, failureBackoffMs);
      const priority = lastFetch === null ? 0 : tweetAge < 24 * 60 * 60_000 ? 1 : tweetAge < 7 * 24 * 60 * 60_000 ? 2 : 3;
      return { account, due, priority, lastFetch: lastFetch ?? 0 };
    })
    .filter(item => item.due)
    .sort((a, b) => a.priority - b.priority || a.lastFetch - b.lastFetch)
    .slice(0, limit)
    .map(item => item.account);
}

function failureBackoff(consecutiveFailures: number): number {
  if (consecutiveFailures <= 1) return 0;
  if (consecutiveFailures <= 3) return 60 * 60_000;          // 1 hour
  if (consecutiveFailures <= 8) return 6 * 60 * 60_000;      // 6 hours
  return 24 * 60 * 60_000;                                    // 1 day
}

function parseSqlDate(value: string | null): number | null {
  if (!value) return null;
  const normalized = value.includes('T') ? value : value.replace(' ', 'T') + 'Z';
  const timestamp = Date.parse(normalized);
  return Number.isNaN(timestamp) ? null : timestamp;
}
