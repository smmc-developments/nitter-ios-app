import * as cheerio from 'cheerio';
import type { TweetRow } from './db.js';
import { normalizeTweetDate } from './dates.js';
import { createLogger } from './logger.js';

// Port of Nitter/TimelineParser.swift selectors to Cheerio.
// Selectors follow upstream Nitter templates (views/tweet.nim, views/timeline.nim).

const NITTER_BASE_URL = process.env.NITTER_BASE_URL || 'https://nitter.click';

const log = createLogger('parser', 'debug');

export interface ParseResult {
  tweets: TweetRow[];
  account: { handle: string; name: string; avatarUrl: string | null } | null;
  nextCursor: string | null;
}

export interface ConversationResult {
  tweet: TweetRow | null;
  replies: TweetRow[];
}

export function parseTimeline(html: string, accountUsername: string): ParseResult {
  log(`Parsing HTML for @${accountUsername} (${html.length} bytes)`);
  const $ = cheerio.load(html);
  const tweets: TweetRow[] = [];
  let account: ParseResult['account'] = null;

  // Prefer profile card for account identity (first tweet is often a retweet).
  const card = $('.profile-card').first();
  if (card.length) {
    const handle = card.find('.profile-card-username').first().text().replace('@', '').trim();
    const name = card.find('.profile-card-fullname').first().text().trim();
    const avatar = card.find('.profile-card-avatar img').first().attr('src') ?? null;
    if (handle) {
      account = { handle, name: name || handle, avatarUrl: avatar ? resolveUrl(avatar) : null };
      log(`Profile card found: @${handle} (${name}), avatar: ${avatar ? 'yes' : 'no'}`);
    }
  } else {
    log('No .profile-card found in HTML');
  }

  const timelineItems = $('.timeline-item');
  log(`Found ${timelineItems.length} .timeline-item element(s)`);

  let skippedNoBody = 0;
  let skippedNoContent = 0;

  timelineItems.each((_, item) => {
    const el = $(item);
    const body = el.find('div.tweet-body').first();
    if (!body.length) {
      skippedNoBody++;
      return; // skip show-more, more-replies, etc.
    }

    const content = body.find('div.tweet-content').first();
    if (!content.length) {
      skippedNoContent++;
      return; // unavailable tweet
    }

    // Author info from header.
    const header = body.find('div.tweet-header').first();
    const name = header.find('a.fullname').first().text().trim() || el.attr('data-username') || '';
    const handle = (header.find('a.username').first().text().trim() || el.attr('data-username') || '').replace('@', '');

    // Fallback account info from first tweet.
    if (!account && handle) {
      const avatar = header.find('.tweet-avatar img').first().attr('src') ?? null;
      account = { handle, name, avatarUrl: avatar ? resolveUrl(avatar) : null };
      log(`Fallback account from first tweet: @${handle} (${name})`);
    }

    // Status link + ID.
    const tweetLink = el.find('a.tweet-link').first().attr('href')
      ?? header.find('.tweet-date a').first().attr('href')
      ?? '';
    const idMatch = tweetLink.match(/\/status\/(\d+)/);
    if (!idMatch) {
      skippedNoContent++;
      return;
    }
    const id = idMatch[1];

    // Date from title attribute (e.g. "Jul 18, 2026 · 3:04 PM UTC").
    const dateStr = header.find('.tweet-date a').first().attr('title') ?? '';
    const date = normalizeTweetDate(dateStr);

    // Text (preserve newlines from <br>).
    const text = normalizedText($, content);

    // Retweet header.
    const rtHeader = body.find('.retweet-header').first();
    const retweetedBy = rtHeader.length ? rtHeader.text().replace('retweeted', '').trim() : null;

    const explicitReplyHandles = body.find('.replying-to a').map((_, link) =>
      $(link).text().replace('@', '').trim()
    ).get().filter(Boolean);
    const replyToHandles = explicitReplyHandles.length
      ? explicitReplyHandles
      : derivedReplyHandles($, el);

    // Pinned.
    const isPinned = body.find('.pinned').length > 0 ? 1 : 0;

    // Photos (top-level only, not inside quotes).
    const photoUrls: string[] = [];
    body.children('.attachments').find('.attachment a.still-image img').each((_, img) => {
      const src = $(img).attr('src');
      if (src) photoUrls.push(resolveUrl(src));
    });

    // Video poster and source. Current Nitter uses a download link with an
    // image poster; older instances render a video/source element directly.
    const videoAttachment = body.children('.attachments').find('.attachment').filter((_, attachment) =>
      $(attachment).find('video, a.video-download').length > 0
    ).first();
    const rawPoster = videoAttachment.find('video').first().attr('poster')
      ?? videoAttachment.find('img').first().attr('src')
      ?? null;
    const videoPoster = rawPoster ? resolveUrl(rawPoster) : null;
    const video = videoAttachment.find('video').first();
    const rawVideo = video.find('source[type="video/mp4"]').first().attr('src')
      ?? video.find('source').first().attr('src')
      ?? video.attr('src')
      ?? videoAttachment.find('a.video-download').first().attr('href')
      ?? null;
    const videoUrl = rawVideo ? resolveVideoUrl(rawVideo) : null;

    // Quote.
    const quoteText = body.find('.quote .quote-text').first().text().trim() || null;
    const quoteHandle = body.find('.quote a.username').first().text().replace('@', '').trim() || null;

    // Stats.
    const stats = { replies: 0, retweets: 0, likes: 0, views: 0 };
    body.find('.tweet-stats .tweet-stat').each((_, stat) => {
      const raw = $(stat).text().replace(/,/g, '').trim();
      const num = parseInt(raw) || 0;
      if ($(stat).find('.icon-comment').length) stats.replies = num;
      else if ($(stat).find('.icon-retweet').length) stats.retweets = num;
      else if ($(stat).find('.icon-heart').length) stats.likes = num;
      else if ($(stat).find('.icon-views').length) stats.views = num;
    });

    // Avatar.
    const rawAvatar = header.find('.tweet-avatar img').first().attr('src') ?? null;
    const avatarUrl = rawAvatar ? resolveUrl(rawAvatar) : null;

    // Status URL.
    const statusUrl = tweetLink ? NITTER_BASE_URL + tweetLink.split('#')[0] : null;

    // For multi-user pages (comma-separated accountUsername), set account_username
    // to the actual author handle (lowercased) so FK constraint is satisfied.
    const isMulti = accountUsername.includes(',');
    const tweetAccount = isMulti ? handle.toLowerCase() : accountUsername;

    tweets.push({
      id,
      account_username: tweetAccount,
      author_name: name,
      author_handle: handle,
      avatar_url: avatarUrl,
      date,
      text_content: text,
      status_url: statusUrl,
      reply_count: stats.replies,
      retweet_count: stats.retweets,
      like_count: stats.likes,
      view_count: stats.views,
      photo_urls: photoUrls.length ? JSON.stringify(photoUrls) : null,
      video_poster_url: videoPoster,
      video_url: videoUrl,
      retweeted_by: retweetedBy,
      is_pinned: isPinned,
      quoted_text: quoteText,
      quoted_handle: quoteHandle,
      reply_to_handles: replyToHandles,
    });
  });

  log(`Parsed ${tweets.length} tweet(s) (skipped: ${skippedNoBody} no-body, ${skippedNoContent} no-content)`);

  if (tweets.length > 0) {
    const first = tweets[0];
    const last = tweets[tweets.length - 1];
    log(`Date range: ${first.date ?? 'unknown'} → ${last.date ?? 'unknown'}`);
  }

  const nextCursor = $('.show-more a[href*="cursor="]').last().attr('href') ?? null;
  return { tweets, account, nextCursor };
}

export function parseConversation(
  html: string,
  accountUsername: string,
  tweetId: string,
): ConversationResult {
  const parsed = parseTimeline(html, accountUsername);
  const $ = cheerio.load(html);
  const replyIds = new Set<string>();

  $('.replies .timeline-item, .after-tweet .timeline-item').each((_, item) => {
    const el = $(item);
    const link = el.find('a.tweet-link').first().attr('href')
      ?? el.find('.tweet-date a').first().attr('href')
      ?? '';
    const id = link.match(/\/status\/(\d+)/)?.[1];
    if (id) replyIds.add(id);
  });

  return {
    tweet: parsed.tweets.find(tweet => tweet.id === tweetId) ?? null,
    replies: parsed.tweets.filter(tweet => replyIds.has(tweet.id)),
  };
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

export function parseParentTweet(html: string): ParentTweetSnapshot | null {
  const $ = cheerio.load(html);
  const item = $('.before-tweet .timeline-item').filter((_, element) =>
    $(element).find('.tweet-body .tweet-content').length > 0
  ).last();
  if (!item.length) return null;

  const body = item.find('.tweet-body').first();
  const header = body.find('.tweet-header').first();
  const link = item.find('a.tweet-link').first().attr('href')
    ?? header.find('.tweet-date a').first().attr('href')
    ?? '';
  const id = link.match(/\/status\/(\d+)/)?.[1];
  if (!id) return null;

  const authorHandle = header.find('a.username').first().text().replace('@', '').trim()
    || item.attr('data-username') || '';
  const authorName = header.find('a.fullname').first().text().trim() || authorHandle;
  const avatar = header.find('.tweet-avatar img').first().attr('src') ?? null;
  const dateString = header.find('.tweet-date a').first().attr('title') ?? '';
  return {
    id,
    statusUrl: resolveUrl(link.split('#')[0]),
    authorName,
    authorHandle,
    avatarUrl: avatar ? resolveUrl(avatar) : null,
    date: normalizeTweetDate(dateString),
    text: normalizedText($, body.find('.tweet-content').first()),
  };
}

export function belongsToTimeline(tweet: TweetRow, accountUsername: string): boolean {
  if (tweet.is_pinned === 1 || tweet.retweeted_by) return true;
  const handle = (tweet.author_handle ?? '').trim().replace(/^@/, '').toLowerCase();
  return handle !== '' && handle === accountUsername.toLowerCase();
}

// Nitter omits `.replying-to` from thread continuations, but the parent tweet
// is the previous item in the same `.thread-line`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function derivedReplyHandles($: any, el: any): string[] {
  if (!el.parent().hasClass('thread-line')) return [];
  const previous = el.prev('.timeline-item');
  if (!previous.length) return [];
  const handle = previous.find('div.tweet-header a.username').first().text().replace('@', '').trim()
    || previous.attr('data-username') || '';
  return handle ? [handle] : [];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizedText($: any, el: any): string {
  return innerText($, el)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function innerText($: any, el: any): string {
  let result = '';
  el.contents().each((_: number, child: any) => {
    if (child.type === 'text') {
      result += child.data ?? '';
    } else if (child.type === 'tag' && child.tagName === 'br') {
      result += '\n';
    } else if (child.type === 'tag') {
      const element = $(child);
      const label = innerText($, element);
      result += child.tagName === 'a' ? expandedLinkText(element.attr('href'), label) : label;
    }
  });
  return result;
}

function expandedLinkText(href: string | undefined, label: string): string {
  if (!href || (!label.includes('.') && !label.includes('…') && !label.includes('...'))) {
    return label;
  }
  try {
    const url = new URL(href, NITTER_BASE_URL);
    if (url.origin !== new URL(NITTER_BASE_URL).origin) return url.href;
    const redirected = url.pathname === '/redirect' ? url.searchParams.get('url') : null;
    return redirected ? new URL(redirected).href : label;
  } catch {
    return label;
  }
}

function resolveUrl(url: string): string {
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  return NITTER_BASE_URL + (url.startsWith('/') ? url : '/' + url);
}

function resolveVideoUrl(value: string): string {
  const resolved = resolveUrl(value);
  try {
    const path = new URL(resolved).pathname;
    const encodedDirectUrl = path.match(/^\/video\/[^/]+\/(.+)$/)?.[1];
    if (!encodedDirectUrl) return resolved;
    const directUrl = new URL(decodeURIComponent(encodedDirectUrl));
    if (directUrl.protocol === 'https:' && directUrl.hostname === 'video.twimg.com'
      && !directUrl.port && !directUrl.username && !directUrl.password) {
      return directUrl.href;
    }
  } catch {
    // Keep the instance URL when it does not contain a valid Twitter CDN URL.
  }
  return resolved;
}
