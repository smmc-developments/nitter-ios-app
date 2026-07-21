import { Fetcher } from './fetcher.js';
import { parseParentTweet, parseTimeline } from './parser.js';
import {
  listAccounts, updateAccountFetch,
  upsertTweet, pruneOldTweets, updateAccountBackfill,
  hasTimelineTweet, type AccountRow,
  needsParentEnrichment, storeParentTweet,
} from './db.js';
import { cursorPath, selectAccountsForCycle } from './scheduling.js';
import type { ImageCache } from './image-cache.js';

const CONCURRENCY = parsePositiveInt(process.env.FETCH_CONCURRENCY, 2);
const REQUEST_START_INTERVAL_MS = parsePositiveInt(process.env.FETCH_START_INTERVAL_MS, 1_000);
const MAX_ACCOUNTS_PER_CYCLE = parsePositiveInt(process.env.MAX_ACCOUNTS_PER_CYCLE, 40);
const MAX_PAGES_PER_ACCOUNT = parsePositiveInt(process.env.MAX_PAGES_PER_ACCOUNT, 5);
const INCLUDE_REPLIES = process.env.INCLUDE_REPLIES !== 'false';
const MAX_PARENT_ENRICHMENTS = parsePositiveInt(process.env.MAX_PARENT_ENRICHMENTS, 20);

function log(msg: string) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [scheduler] ${msg}`);
}

export class Scheduler {
  private fetcher: Fetcher;
  private imageCache: ImageCache;
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private nextRequestAt = 0;
  private rateLimitedUntil = 0;

  constructor(fetcher: Fetcher, imageCache: ImageCache, intervalMinutes = 15) {
    this.fetcher = fetcher;
    this.imageCache = imageCache;
    this.intervalMs = intervalMinutes * 60_000;
    log(`Initialized — interval: ${intervalMinutes}m (${this.intervalMs}ms)`);
  }

  start() {
    log('Starting scheduler...');
    void this.run().catch(err => log(`Initial cycle failed: ${String(err)}`));
    this.timer = setInterval(() => {
      void this.run().catch(err => log(`Scheduled cycle failed: ${String(err)}`));
    }, this.intervalMs);
    log(`Timer set — next run in ${this.intervalMs / 1000}s`);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      log('Timer cleared');
    }
    this.timer = null;
  }

  get isRunning() {
    return this.running;
  }

  async run(fullRefresh = false) {
    if (this.running) {
      log('Already running — skipping');
      return;
    }
    this.running = true;
    const cycleStart = Date.now();
    try {
      const allAccounts = listAccounts();
      const accounts = fullRefresh
        ? allAccounts
        : selectAccountsForCycle(allAccounts, this.intervalMs, MAX_ACCOUNTS_PER_CYCLE);
      log(`Cycle starting — ${accounts.length}/${allAccounts.length} account(s) selected${fullRefresh ? ' (full refresh)' : ''}`);

    if (accounts.length === 0) {
      log('No accounts configured — nothing to fetch');
      return;
    }

    const parentBudget = { remaining: MAX_PARENT_ENRICHMENTS };
    const results = await this.runWorkers(accounts, async (account, index) => {
      const basePath = '/' + account.username + (INCLUDE_REPLIES ? '/with_replies' : '');
      log(`Account ${index + 1}/${accounts.length}: @${account.username}`);
      try {
        let path = basePath;
        let parsed = 0;
        let page = 0;
        let profile: ReturnType<typeof parseTimeline>['account'] = null;
        let backfillComplete = account.backfill_complete === 1;
        const seenPaths = new Set<string>();

        while (path && page < MAX_PAGES_PER_ACCOUNT && !seenPaths.has(path)) {
          seenPaths.add(path);
          const html = await this.fetchPageWithRetry(path, account.username);
          const result = parseTimeline(html, account.username);
          if (page === 0) profile = result.account;
          const knownBeforeFetch = result.tweets.some(tweet => hasTimelineTweet(account.username, tweet.id));

          for (const tweet of result.tweets) {
            tweet.account_username = account.username;
            upsertTweet(tweet);
            parsed++;
          }
          this.imageCache.prefetch(mediaUrls(result));
          for (const tweet of result.tweets) {
            if (!tweet.reply_to_handles?.length || parentBudget.remaining <= 0) continue;
            if (!needsParentEnrichment(tweet.id)) continue;
            parentBudget.remaining--;
            await this.enrichParent(tweet.id, tweet.status_url, account.username);
          }

          page++;
          const pageCursor = cursorPath(basePath, result.nextCursor);
          if (backfillComplete && knownBeforeFetch) {
            path = '';
          } else if (page === 1 && !backfillComplete && account.backfill_cursor) {
            path = cursorPath(basePath, account.backfill_cursor) ?? pageCursor ?? '';
          } else {
            path = pageCursor ?? '';
          }

          if (!path) {
            backfillComplete = true;
            updateAccountBackfill(account.username, null, true);
          } else if (page === MAX_PAGES_PER_ACCOUNT) {
            backfillComplete = false;
            updateAccountBackfill(account.username, result.nextCursor, false);
          }
        }

        updateAccountFetch(account.username, {
          displayName: profile?.name,
          avatarUrl: profile?.avatarUrl ?? undefined,
        });
        log(`@${account.username}: ${parsed} tweet(s) across ${page} page(s)`);
        return { parsed, inserted: parsed };
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        console.error(`[${new Date().toISOString()}] [scheduler] @${account.username} FAILED: ${msg}`);
        updateAccountFetch(account.username, { error: msg });
        return { parsed: 0, inserted: 0 };
      }
    });

    const totalTweets = results.reduce((sum, result) => sum + result.parsed, 0);
    const totalInserted = results.reduce((sum, result) => sum + result.inserted, 0);

    pruneOldTweets(30);
    const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(1);
    log(`Cycle complete — ${totalTweets} tweet(s) parsed, ${totalInserted} upserted (${elapsed}s)`);
    } finally {
      this.running = false;
    }
  }

  private async fetchPageWithRetry(path: string, username: string): Promise<string> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      await this.waitForStartSlot();
      try {
        return await this.fetcher.fetchPage(path);
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        const rateLimited = msg.includes('429') || msg.toLowerCase().includes('rate');
        if (!rateLimited || attempt === 3) throw err;
        const delay = 30_000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 5_000);
        this.rateLimitedUntil = Math.max(this.rateLimitedUntil, Date.now() + delay);
        log(`@${username} rate limited; retry ${attempt}/3 in ${delay / 1000}s`);
      }
    }
    throw new Error(`@${username} returned no HTML`);
  }

  private async enrichParent(replyId: string, statusUrl: string | null, username: string) {
    if (!statusUrl) {
      storeParentTweet(replyId, null, 'unavailable');
      return;
    }
    try {
      const path = new URL(statusUrl).pathname;
      const html = await this.fetchPageWithRetry(path, username);
      const parent = parseParentTweet(html);
      storeParentTweet(replyId, parent, parent ? 'found' : 'unavailable');
      if (parent?.avatarUrl) this.imageCache.prefetch([parent.avatarUrl]);
      log(`@${username}: parent context ${parent ? 'found' : 'unavailable'} for ${replyId}`);
    } catch (err) {
      storeParentTweet(replyId, null, 'failed');
      log(`@${username}: parent context failed for ${replyId}: ${String(err)}`);
    }
  }

  private async waitForStartSlot() {
    const now = Date.now();
    const startAt = Math.max(now, this.nextRequestAt, this.rateLimitedUntil);
    this.nextRequestAt = startAt + REQUEST_START_INTERVAL_MS;
    if (startAt > now) await sleep(startAt - now);
  }

  private async runWorkers<T>(
    accounts: AccountRow[],
    work: (account: AccountRow, index: number) => Promise<T>,
  ): Promise<T[]> {
    const results = new Array<T>(accounts.length);
    let nextIndex = 0;
    const worker = async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= accounts.length) return;
        results[index] = await work(accounts[index], index);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, accounts.length) }, worker));
    return results;
  }
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function mediaUrls(result: ReturnType<typeof parseTimeline>): Array<string | null> {
  const urls: Array<string | null> = [result.account?.avatarUrl ?? null];
  for (const tweet of result.tweets) {
    urls.push(tweet.avatar_url, tweet.video_poster_url);
    if (tweet.photo_urls) {
      try {
        urls.push(...JSON.parse(tweet.photo_urls) as string[]);
      } catch {
        // Ignore malformed media metadata; tweet ingestion should still succeed.
      }
    }
  }
  return urls;
}
