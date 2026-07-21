import Database from 'better-sqlite3';
import fs from 'fs';
import { normalizeTweetDate } from './dates.js';
import { DATA_DIR } from './paths.js';

function log(msg: string) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [db] ${msg}`);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
log(`Data directory: ${DATA_DIR}`);

const dbPath = `${DATA_DIR}/xcancel.db`;
log(`Opening database: ${dbPath}`);
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
log('Database initialized (WAL mode, foreign keys ON)');

db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    username TEXT PRIMARY KEY,
    display_name TEXT,
    avatar_url TEXT,
    last_fetched_at TEXT,
    fetch_error TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tweets (
    id TEXT PRIMARY KEY,
    account_username TEXT NOT NULL REFERENCES accounts(username) ON DELETE CASCADE,
    author_name TEXT,
    author_handle TEXT,
    avatar_url TEXT,
    date TEXT,
    text_content TEXT,
    status_url TEXT,
    reply_count INTEGER DEFAULT 0,
    retweet_count INTEGER DEFAULT 0,
    like_count INTEGER DEFAULT 0,
    view_count INTEGER DEFAULT 0,
    photo_urls TEXT,
    video_poster_url TEXT,
    video_url TEXT,
    retweeted_by TEXT,
    is_pinned INTEGER DEFAULT 0,
    quoted_text TEXT,
    quoted_handle TEXT,
    fetched_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_tweets_date ON tweets(date DESC);
  CREATE INDEX IF NOT EXISTS idx_tweets_account ON tweets(account_username);

  CREATE TABLE IF NOT EXISTS tweet_timelines (
    account_username TEXT NOT NULL REFERENCES accounts(username) ON DELETE CASCADE,
    tweet_id TEXT NOT NULL REFERENCES tweets(id) ON DELETE CASCADE,
    retweeted_by TEXT,
    is_pinned INTEGER NOT NULL DEFAULT 0,
    fetched_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (account_username, tweet_id)
  );

  CREATE INDEX IF NOT EXISTS idx_tweet_timelines_tweet ON tweet_timelines(tweet_id);

  INSERT OR IGNORE INTO tweet_timelines (
    account_username, tweet_id, retweeted_by, is_pinned, fetched_at
  )
  SELECT account_username, id, retweeted_by, is_pinned, fetched_at FROM tweets;
`);

const accountColumns = new Set(
  (db.prepare('PRAGMA table_info(accounts)').all() as Array<{ name: string }>).map(column => column.name),
);
if (!accountColumns.has('backfill_cursor')) {
  db.exec('ALTER TABLE accounts ADD COLUMN backfill_cursor TEXT');
}
if (!accountColumns.has('backfill_complete')) {
  db.exec('ALTER TABLE accounts ADD COLUMN backfill_complete INTEGER NOT NULL DEFAULT 0');
}

const tweetColumns = new Set(
  (db.prepare('PRAGMA table_info(tweets)').all() as Array<{ name: string }>).map(column => column.name),
);
const parentColumns: Array<[string, string]> = [
  ['parent_state', 'TEXT'],
  ['parent_id', 'TEXT'],
  ['parent_status_url', 'TEXT'],
  ['parent_author_name', 'TEXT'],
  ['parent_author_handle', 'TEXT'],
  ['parent_avatar_url', 'TEXT'],
  ['parent_date', 'TEXT'],
  ['parent_text', 'TEXT'],
  ['parent_fetched_at', 'TEXT'],
];
if (!tweetColumns.has('video_url')) db.exec('ALTER TABLE tweets ADD COLUMN video_url TEXT');
for (const [name, type] of parentColumns) {
  if (!tweetColumns.has(name)) db.exec(`ALTER TABLE tweets ADD COLUMN ${name} ${type}`);
}

const accountCount = db.prepare('SELECT COUNT(*) as n FROM accounts').get() as { n: number };
const tweetCount = db.prepare('SELECT COUNT(*) as n FROM tweets').get() as { n: number };
log(`Loaded ${accountCount.n} account(s), ${tweetCount.n} tweet(s) from database`);

const legacyDates = db.prepare(`
  SELECT id, date FROM tweets WHERE date IS NOT NULL AND date NOT LIKE '____-__-__T%'
`).all() as Array<{ id: string; date: string }>;
const updateLegacyDate = db.prepare('UPDATE tweets SET date = ? WHERE id = ?');
const migrateDates = db.transaction(() => {
  for (const row of legacyDates) {
    const normalized = normalizeTweetDate(row.date);
    if (normalized) updateLegacyDate.run(normalized, row.id);
  }
});
migrateDates();
if (legacyDates.length) log(`Normalized ${legacyDates.length} legacy tweet date(s)`);

// ---------- accounts ----------

export interface AccountRow {
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  last_fetched_at: string | null;
  fetch_error: string | null;
  last_tweet_at: string | null;
  backfill_cursor: string | null;
  backfill_complete: number;
}

export function listAccounts(): AccountRow[] {
  const rows = db.prepare(`
    SELECT a.*,
      (SELECT MAX(t.date)
       FROM tweet_timelines m
       JOIN tweets t ON t.id = m.tweet_id
       WHERE m.account_username = a.username) AS last_tweet_at
    FROM accounts a
    ORDER BY a.created_at
  `).all() as AccountRow[];
  log(`listAccounts() → ${rows.length} row(s)`);
  return rows;
}

export function addAccount(username: string): AccountRow {
  log(`addAccount(@${username})`);
  db.prepare('INSERT OR IGNORE INTO accounts (username) VALUES (?)').run(username);
  return db.prepare('SELECT * FROM accounts WHERE username = ?').get(username) as AccountRow;
}

export function removeAccount(username: string): boolean {
  log(`removeAccount(@${username})`);
  const info = db.transaction(() => {
    // The legacy tweets.account_username FK remains for an in-place migration.
    // Re-home shared content before deleting its current compatibility owner.
    db.prepare(`
      UPDATE tweets
      SET account_username = (
        SELECT m.account_username
        FROM tweet_timelines m
        WHERE m.tweet_id = tweets.id AND m.account_username <> ?
        ORDER BY m.account_username
        LIMIT 1
      )
      WHERE account_username = ?
        AND EXISTS (
          SELECT 1 FROM tweet_timelines m
          WHERE m.tweet_id = tweets.id AND m.account_username <> ?
        )
    `).run(username, username, username);
    return db.prepare('DELETE FROM accounts WHERE username = ?').run(username);
  })();
  log(`removeAccount(@${username}) — changes: ${info.changes}`);
  return info.changes > 0;
}

export function getAccount(username: string): AccountRow | undefined {
  const row = db.prepare('SELECT * FROM accounts WHERE username = ?').get(username) as AccountRow | undefined;
  log(`getAccount(@${username}) → ${row ? 'found' : 'not found'}`);
  return row;
}

export function updateAccountFetch(username: string, info: { displayName?: string; avatarUrl?: string; error?: string }) {
  log(`updateAccountFetch(@${username}) — name: ${info.displayName ?? '-'}, avatar: ${info.avatarUrl ? 'yes' : '-'}, error: ${info.error ?? '-'}`);
  db.prepare(`
    UPDATE accounts
    SET last_fetched_at = CASE WHEN ? IS NULL THEN datetime('now') ELSE last_fetched_at END,
        display_name = COALESCE(?, display_name),
        avatar_url = COALESCE(?, avatar_url),
        fetch_error = ?
    WHERE username = ?
  `).run(
    info.error ?? null,
    info.displayName ?? null,
    info.avatarUrl ?? null,
    info.error ?? null,
    username,
  );
}

export function updateAccountBackfill(username: string, cursor: string | null, complete: boolean) {
  db.prepare(`
    UPDATE accounts SET backfill_cursor = ?, backfill_complete = ? WHERE username = ?
  `).run(cursor, complete ? 1 : 0, username);
}

export function hasTimelineTweet(username: string, tweetId: string): boolean {
  return db.prepare(`
    SELECT 1 FROM tweet_timelines WHERE account_username = ? AND tweet_id = ?
  `).get(username, tweetId) !== undefined;
}

// ---------- tweets ----------

export interface TweetRow {
  id: string;
  account_username: string;
  author_name: string | null;
  author_handle: string | null;
  avatar_url: string | null;
  date: string | null;
  text_content: string | null;
  status_url: string | null;
  reply_count: number;
  retweet_count: number;
  like_count: number;
  view_count: number;
  photo_urls: string | null;
  video_poster_url: string | null;
  video_url: string | null;
  retweeted_by: string | null;
  is_pinned: number;
  quoted_text: string | null;
  quoted_handle: string | null;
  reply_to_handles?: string[];
  parent_state?: string | null;
  parent_id?: string | null;
  parent_status_url?: string | null;
  parent_author_name?: string | null;
  parent_author_handle?: string | null;
  parent_avatar_url?: string | null;
  parent_date?: string | null;
  parent_text?: string | null;
  parent_fetched_at?: string | null;
  fetched_at?: string;
}

export interface ParentTweetSnapshot {
  id: string;
  statusUrl: string;
  authorName: string;
  authorHandle: string;
  avatarUrl: string | null;
  date: string | null;
  text: string;
}

export function needsParentEnrichment(tweetId: string): boolean {
  const row = db.prepare(`
    SELECT parent_state, parent_fetched_at FROM tweets WHERE id = ?
  `).get(tweetId) as { parent_state: string | null; parent_fetched_at: string | null } | undefined;
  if (!row || row.parent_state === 'found' || row.parent_state === 'unavailable') return false;
  if (row.parent_state !== 'failed' || !row.parent_fetched_at) return true;
  const retry = db.prepare(`
    SELECT datetime(?) < datetime('now', '-1 hour') AS retry
  `).get(row.parent_fetched_at) as { retry: number };
  return Boolean(retry.retry);
}

export function storeParentTweet(
  replyId: string,
  parent: ParentTweetSnapshot | null,
  state: 'found' | 'unavailable' | 'failed',
) {
  db.prepare(`
    UPDATE tweets SET
      parent_state = ?, parent_id = ?, parent_status_url = ?,
      parent_author_name = ?, parent_author_handle = ?, parent_avatar_url = ?,
      parent_date = ?, parent_text = ?, parent_fetched_at = datetime('now')
    WHERE id = ?
  `).run(
    state, parent?.id ?? null, parent?.statusUrl ?? null,
    parent?.authorName ?? null, parent?.authorHandle ?? null, parent?.avatarUrl ?? null,
    parent?.date ?? null, parent?.text ?? null, replyId,
  );
}

export function upsertTweet(tweet: Omit<TweetRow, 'fetched_at'>) {
  const upsertContent = db.prepare(`
    INSERT INTO tweets (id, account_username, author_name, author_handle, avatar_url,
      date, text_content, status_url, reply_count, retweet_count, like_count, view_count,
      photo_urls, video_poster_url, video_url, retweeted_by, is_pinned, quoted_text, quoted_handle)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      account_username=excluded.account_username, author_name=excluded.author_name,
      author_handle=excluded.author_handle, avatar_url=excluded.avatar_url,
      date=excluded.date, text_content=excluded.text_content,
      status_url=excluded.status_url, reply_count=excluded.reply_count,
      retweet_count=excluded.retweet_count, like_count=excluded.like_count,
      view_count=excluded.view_count, photo_urls=excluded.photo_urls,
      video_poster_url=excluded.video_poster_url, video_url=excluded.video_url,
      retweeted_by=excluded.retweeted_by,
      is_pinned=excluded.is_pinned, quoted_text=excluded.quoted_text,
      quoted_handle=excluded.quoted_handle, fetched_at=datetime('now')
  `);
  const upsertMembership = db.prepare(`
    INSERT INTO tweet_timelines (account_username, tweet_id, retweeted_by, is_pinned)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(account_username, tweet_id) DO UPDATE SET
      retweeted_by=excluded.retweeted_by,
      is_pinned=excluded.is_pinned,
      fetched_at=datetime('now')
  `);
  db.transaction(() => {
    upsertContent.run(
      tweet.id, tweet.account_username, tweet.author_name, tweet.author_handle,
      tweet.avatar_url, tweet.date, tweet.text_content, tweet.status_url,
      tweet.reply_count, tweet.retweet_count, tweet.like_count, tweet.view_count,
      tweet.photo_urls, tweet.video_poster_url, tweet.video_url, tweet.retweeted_by,
      tweet.is_pinned, tweet.quoted_text, tweet.quoted_handle
    );
    upsertMembership.run(
      tweet.account_username, tweet.id, tweet.retweeted_by, tweet.is_pinned,
    );
  })();
}

export function getFeed(limit: number, before?: string): TweetRow[] {
  log(`getFeed(limit=${limit}, before=${before ?? 'none'})`);
  let rows: TweetRow[];
  if (before) {
    rows = db.prepare(`
      SELECT t.*, m.account_username, m.retweeted_by, m.is_pinned
      FROM tweets t
      JOIN tweet_timelines m ON m.tweet_id = t.id
      WHERE m.rowid = (
        SELECT m2.rowid FROM tweet_timelines m2
        WHERE m2.tweet_id = t.id
        ORDER BY (m2.retweeted_by IS NOT NULL), m2.account_username
        LIMIT 1
      )
        AND (t.date < (SELECT date FROM tweets WHERE id = ?)
          OR (t.date = (SELECT date FROM tweets WHERE id = ?) AND t.id < ?))
      ORDER BY t.date DESC, t.id DESC LIMIT ?
    `).all(before, before, before, limit) as TweetRow[];
  } else {
    rows = db.prepare(`
      SELECT t.*, m.account_username, m.retweeted_by, m.is_pinned
      FROM tweets t
      JOIN tweet_timelines m ON m.tweet_id = t.id
      WHERE m.rowid = (
        SELECT m2.rowid FROM tweet_timelines m2
        WHERE m2.tweet_id = t.id
        ORDER BY (m2.retweeted_by IS NOT NULL), m2.account_username
        LIMIT 1
      )
      ORDER BY t.date DESC, t.id DESC LIMIT ?
    `).all(limit) as TweetRow[];
  }
  log(`getFeed() → ${rows.length} row(s)`);
  return rows;
}

export function getTimeline(username: string, limit: number, before?: string): TweetRow[] {
  log(`getTimeline(@${username}, limit=${limit}, before=${before ?? 'none'})`);
  let rows: TweetRow[];
  if (before) {
    rows = db.prepare(`
      SELECT t.*, m.account_username, m.retweeted_by, m.is_pinned
      FROM tweet_timelines m
      JOIN tweets t ON t.id = m.tweet_id
      WHERE m.account_username = ?
        AND (t.date < (SELECT date FROM tweets WHERE id = ?)
          OR (t.date = (SELECT date FROM tweets WHERE id = ?) AND t.id < ?))
      ORDER BY t.date DESC, t.id DESC LIMIT ?
    `).all(username, before, before, before, limit) as TweetRow[];
  } else {
    rows = db.prepare(`
      SELECT t.*, m.account_username, m.retweeted_by, m.is_pinned
      FROM tweet_timelines m
      JOIN tweets t ON t.id = m.tweet_id
      WHERE m.account_username = ?
      ORDER BY t.date DESC, t.id DESC LIMIT ?
    `)
      .all(username, limit) as TweetRow[];
  }
  log(`getTimeline(@${username}) → ${rows.length} row(s)`);
  return rows;
}

export function pruneOldTweets(maxAgeDays: number = 30) {
  log(`pruneOldTweets(maxAgeDays=${maxAgeDays})`);
  const info = db.prepare(`
    DELETE FROM tweets
    WHERE NOT EXISTS (
      SELECT 1 FROM tweet_timelines m
      WHERE m.tweet_id = tweets.id
        AND datetime(m.fetched_at) >= datetime('now', '-' || ? || ' days')
    )
  `).run(maxAgeDays);
  log(`pruneOldTweets() — deleted ${info.changes} row(s)`);
}

export default db;
