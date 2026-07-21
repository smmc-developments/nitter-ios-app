import { Router } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { pipeline, Readable } from 'stream';
import {
  listAccounts, addAccount, getAccount, removeAccount,
  getFeed, getTimeline, type TweetRow,
} from './db.js';
import { parseTimeline } from './parser.js';
import type { Fetcher } from './fetcher.js';
import { isAllowedImageUrl, isAllowedVideoUrl, type ImageCache } from './image-cache.js';

interface FetchScheduler {
  readonly isRunning: boolean;
  run(fullRefresh?: boolean): Promise<void>;
}

function log(msg: string) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [routes] ${msg}`);
}

export function createRouter(
  fetcher: Fetcher,
  scheduler: FetchScheduler,
  imageCache: ImageCache,
  proxySecret: string,
) {
const router = Router();

router.post('/fetch', (_req, res) => {
  if (scheduler.isRunning) {
    return res.status(409).json({ error: 'Fetch already in progress' });
  }
  void scheduler.run(true).catch(err => log(`Client-triggered fetch failed: ${String(err)}`));
  res.json({ ok: true, message: 'Fetch started' });
});

// ---------- accounts ----------

router.get('/accounts', (req, res) => {
  const accounts = listAccounts();
  log(`GET /accounts — returning ${accounts.length} account(s)`);
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.json(accounts.map(a => ({
    ...a,
    avatar_url: a.avatar_url ? proxyUrl(baseUrl, a.avatar_url, proxySecret) : null,
  })));
});

router.post('/accounts', (req, res) => {
  const raw = req.body?.username;
  log(`POST /accounts — username: "${raw}"`);
  const username = (raw as string)?.trim().replace(/^@/, '');
  if (!username || !/^[A-Za-z0-9_]{1,15}$/.test(username)) {
    log(`POST /accounts — invalid username: "${username}"`);
    return res.status(400).json({ error: 'Invalid username' });
  }
  const lower = username.toLowerCase();
  if (getAccount(lower)) {
    log(`POST /accounts — @${lower} already exists (409)`);
    return res.status(409).json({ error: 'Account already exists' });
  }
  const account = addAccount(lower);
  log(`POST /accounts — @${lower} created`);
  res.status(201).json(account);
});

router.delete('/accounts/:username', (req, res) => {
  const username = req.params.username.toLowerCase();
  log(`DELETE /accounts/${username}`);
  const removed = removeAccount(username);
  log(`DELETE /accounts/${username} — removed: ${removed}`);
  res.json({ ok: removed });
});

// ---------- feed ----------

router.get('/feed', (req, res) => {
  const limit = parseLimit(req.query.limit, 100, 1_000);
  const before = req.query.before as string | undefined;
  log(`GET /feed — limit: ${limit}, before: ${before ?? 'none'}`);
  const tweets = getFeed(limit, before);
  log(`GET /feed — returning ${tweets.length} tweet(s)`);
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.json({ tweets: tweets.map(t => formatTweet(t, baseUrl)) });
});

router.get('/timeline/:username', (req, res) => {
  const username = req.params.username.toLowerCase();
  const limit = parseLimit(req.query.limit, 20, 100);
  const before = req.query.before as string | undefined;
  log(`GET /timeline/${username} — limit: ${limit}, before: ${before ?? 'none'}`);
  const tweets = getTimeline(username, limit, before);
  log(`GET /timeline/${username} — returning ${tweets.length} tweet(s)`);
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.json({ tweets: tweets.map(t => formatTweet(t, baseUrl)) });
});

// ---------- tweet detail ----------

router.get('/tweet/:username/:id', async (req, res) => {
  const username = req.params.username.toLowerCase();
  const tweetId = req.params.id;
  log(`GET /tweet/${username}/${tweetId}`);
  try {
    const html = await fetcher.fetchPage(`/${username}/status/${tweetId}`);
    const result = parseTimeline(html, username);
    const mainTweet = result.tweets.find(t => t.id === tweetId);
    const replies = result.tweets.filter(t => t.id !== tweetId);
    log(`GET /tweet/${username}/${tweetId} — main: ${mainTweet ? 'found' : 'missing'}, replies: ${replies.length}`);
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json({
      tweet: mainTweet ? formatTweet(mainTweet, baseUrl) : null,
      replies: replies.map(t => formatTweet(t, baseUrl)),
    });
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    console.error(`[${new Date().toISOString()}] [routes] GET /tweet/${username}/${tweetId} FAILED: ${msg}`);
    res.status(502).json({ error: msg });
  }
});

// ---------- image proxy ----------

router.get('/proxy', async (req, res) => {
  const url = req.query.url as string;
  const expires = req.query.expires as string;
  const signature = req.query.sig as string;
  if (!url || !expires || !signature || !isValidProxySignature(url, expires, signature, proxySecret)) {
    log('GET /proxy — rejected invalid or expired signature');
    return res.status(403).json({ error: 'Invalid or expired image URL' });
  }
  if (!isAllowedImageUrl(url) && !isAllowedVideoUrl(url)) {
    log(`GET /proxy — rejected upstream URL ${url.slice(0, 160)}`);
    return res.status(400).json({ error: 'Missing or invalid url param' });
  }
  try {
    if (isAllowedVideoUrl(url)) {
      const abort = new AbortController();
      req.on('aborted', () => abort.abort());
      res.on('close', () => {
        if (!res.writableEnded) abort.abort();
      });
      const requestHeaders: Record<string, string> = {};
      if (req.headers.range) requestHeaders.range = req.headers.range;
      const ifRange = req.headers['if-range'];
      if (ifRange) requestHeaders['if-range'] = Array.isArray(ifRange) ? ifRange[0] : ifRange;
      const method = req.method === 'HEAD' ? 'HEAD' : 'GET';
      const upstream = await fetcher.fetchMedia(url, requestHeaders, abort.signal, method);
      for (const name of [
        'content-type', 'content-length', 'content-range', 'accept-ranges',
        'etag', 'last-modified',
      ]) {
        const value = upstream.headers.get(name);
        if (value) res.setHeader(name, value);
      }
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.status(upstream.status);
      if (req.method === 'HEAD' || !upstream.body) return res.end();
      pipeline(Readable.fromWeb(upstream.body as any), res, err => {
        if (err && err.name !== 'AbortError' && (err as NodeJS.ErrnoException).code !== 'ERR_STREAM_PREMATURE_CLOSE') {
          log(`GET /proxy — video stream failed: ${err.message}`);
        }
      });
      return;
    }
    log(`GET /proxy — cache lookup ${url.slice(0, 120)}`);
    const image = await imageCache.get(url);
    const cacheControl = 'public, max-age=86400';
    res.setHeader('Content-Type', image.contentType);
    res.setHeader('Cache-Control', cacheControl);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.status(200).send(image.body);
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    console.error(`[${new Date().toISOString()}] [routes] GET /proxy FAILED: ${msg}`);
    res.status(502).json({ error: msg });
  }
});

// ---------- helpers ----------

function formatTweet(row: TweetRow, baseUrl?: string) {
  const proxy = baseUrl ? (url: string | null) => url ? proxyUrl(baseUrl, url, proxySecret) : null : (url: string | null) => url;
  const proxyArr = baseUrl ? (urls: string[]) => urls.map(u => proxyUrl(baseUrl, u, proxySecret)) : (urls: string[]) => urls;
  return {
    id: row.id,
    authorName: row.author_name,
    authorHandle: row.author_handle,
    avatarURL: proxy(row.avatar_url),
    date: row.date,
    text: row.text_content,
    statusURL: row.status_url,
    replyCount: row.reply_count,
    retweetCount: row.retweet_count,
    likeCount: row.like_count,
    viewCount: row.view_count,
    photoURLs: proxyArr(row.photo_urls ? JSON.parse(row.photo_urls) : []),
    videoPosterURL: proxy(row.video_poster_url),
    videoURL: proxy(row.video_url),
    retweetedBy: row.retweeted_by,
    isPinned: row.is_pinned === 1,
    quotedText: row.quoted_text,
    quotedHandle: row.quoted_handle,
    parent: row.parent_id ? {
      id: row.parent_id,
      statusURL: row.parent_status_url,
      authorName: row.parent_author_name ?? '',
      authorHandle: row.parent_author_handle ?? '',
      avatarURL: proxy(row.parent_avatar_url ?? null),
      date: row.parent_date,
      text: row.parent_text ?? '',
    } : null,
  };
}

return router;
}

function parseLimit(value: unknown, fallback: number, maximum: number): number {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : fallback;
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), maximum) : fallback;
}

function proxyUrl(baseUrl: string, url: string, secret: string): string {
  // Stable for a full UTC day so client caches are not invalidated on every feed request.
  const day = 24 * 60 * 60;
  const expires = String((Math.floor(Date.now() / 1000 / day) + 2) * day);
  const sig = createHmac('sha256', secret).update(`${expires}\n${url}`).digest('hex');
  return `${baseUrl}/api/proxy?url=${encodeURIComponent(url)}&expires=${expires}&sig=${sig}`;
}

function isValidProxySignature(url: string, expires: string, signature: string, secret: string): boolean {
  const expiry = Number(expires);
  if (!Number.isInteger(expiry) || expiry < Date.now() / 1000 || expiry > Date.now() / 1000 + 49 * 60 * 60) {
    return false;
  }
  const expected = createHmac('sha256', secret).update(`${expires}\n${url}`).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
