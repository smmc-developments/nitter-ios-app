export interface SchedulableAccount {
  last_fetched_at: string | null;
  last_tweet_at: string | null;
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
      const due = lastFetch === null || now - lastFetch >= interval;
      const priority = lastFetch === null ? 0 : tweetAge < 24 * 60 * 60_000 ? 1 : tweetAge < 7 * 24 * 60 * 60_000 ? 2 : 3;
      return { account, due, priority, lastFetch: lastFetch ?? 0 };
    })
    .filter(item => item.due)
    .sort((a, b) => a.priority - b.priority || a.lastFetch - b.lastFetch)
    .slice(0, limit)
    .map(item => item.account);
}

function parseSqlDate(value: string | null): number | null {
  if (!value) return null;
  const normalized = value.includes('T') ? value : value.replace(' ', 'T') + 'Z';
  const timestamp = Date.parse(normalized);
  return Number.isNaN(timestamp) ? null : timestamp;
}

export function cursorPath(basePath: string, cursor: string | null): string | null {
  if (!cursor || !cursor.startsWith('?cursor=')) return null;
  return basePath + cursor;
}
