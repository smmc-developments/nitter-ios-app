import type { TweetRow } from './db.js';
import { parseTwitterDate } from './dates.js';
import { createLogger } from './logger.js';

// Mapper for the twitterwebviewer.com JSON API (https://api.twitterwebviewer.com).
// Endpoint map:
//   GET /api/user/{username}                  - profile (id, displayName, avatar, ...)
//   GET /api/tweets/{username}?uid={id}       - timeline page (~20 tweets + pinned)
//       &cursor={nextCursor}                  - pagination
//   GET /api/tweet/{id}                       - single tweet
//   GET /api/tweet/{id}/replies               - reply page
// Media URLs point directly at pbs.twimg.com / video.twimg.com.

const log = createLogger('twv', 'debug');

export interface TwvAuthor {
  username: string;
  displayName: string;
  avatar: string | null;
  verified?: boolean;
}

export interface TwvVariant {
  url: string;
  bitrate?: number;
  width?: number;
  height?: number;
}

export interface TwvMedia {
  type: 'image' | 'video' | 'animated_gif' | string;
  url: string | null;
  thumbnail?: string | null;
  videoUrl?: string | null;
  variants?: TwvVariant[];
}

export interface TwvStats {
  likes?: number;
  retweets?: number;
  replies?: number;
  views?: number;
}

export interface TwvTweet {
  id: string;
  author: TwvAuthor;
  content: string;
  createdAt: string;
  timelineAt?: string;
  stats?: TwvStats;
  quotedTweet?: TwvTweet | null;
  media?: TwvMedia[];
  isPinned?: boolean;
  isRetweet?: boolean;
  retweetedBy?: { username: string; displayName: string } | null;
  originalTweetId?: string;
}

export interface TwvUser {
  id: string;
  username: string;
  displayName: string;
  bio?: string;
  avatar: string | null;
  banner?: string | null;
  followers?: number;
  following?: number;
  tweets?: number;
  isProtected?: boolean;
  verified?: boolean;
}

export interface TwvUserResponse {
  success: boolean;
  data?: TwvUser;
  error?: string;
}

export interface TwvTimelineResponse {
  success: boolean;
  data?: {
    tweets?: TwvTweet[];
    nextCursor?: string | null;
    hasNextPage?: boolean;
  };
  error?: string;
}

export interface TwvTweetResponse {
  success: boolean;
  data?: TwvTweet;
  error?: string;
}

export interface TwvRepliesResponse {
  success: boolean;
  data?: {
    replies?: TwvTweet[];
    nextCursor?: string | null;
    hasNextPage?: boolean;
  };
  error?: string;
}

export interface TwvAccount {
  handle: string;
  name: string;
  avatarUrl: string | null;
}

export interface ParseResult {
  tweets: Array<Omit<TweetRow, 'fetched_at'>>;
  account: TwvAccount | null;
  nextCursor: string | null;
}

export function mapUser(data: TwvUser): TwvAccount {
  return {
    handle: data.username,
    name: data.displayName || data.username,
    avatarUrl: data.avatar ?? null,
  };
}

export function mapTimeline(
  response: TwvTimelineResponse,
  accountUsername: string,
): ParseResult {
  const tweets = (response.data?.tweets ?? []).map(tweet => mapTweet(tweet));
  log(`Mapped ${tweets.length} tweet(s) for @${accountUsername}`);
  return {
    tweets,
    account: null,
    nextCursor: response.data?.nextCursor ?? null,
  };
}

// Bitrate ceiling for the default video variant. The API lists every rendition
// up to 4K/25Mbps; mobile playback should prefer something closer to 720p.
const PREFERRED_MAX_BITRATE = 2_500_000;

export function mapTweet(tweet: TwvTweet): Omit<TweetRow, 'fetched_at'> {
  const handle = tweet.author.username;
  const photos: string[] = [];
  let videoUrl: string | null = null;
  let videoPoster: string | null = null;

  for (const item of tweet.media ?? []) {
    if (item.type === 'image') {
      if (item.url) photos.push(item.url);
    } else if (item.type === 'video' || item.type === 'animated_gif') {
      videoUrl = pickVideoVariant(item) ?? videoUrl;
      videoPoster = videoPoster ?? item.thumbnail ?? item.url ?? null;
    }
  }

  const stats = tweet.stats ?? {};

  return {
    id: tweet.id,
    // Author handle (lowercased) keeps the FK valid on shared multi-account content.
    account_username: handle.toLowerCase(),
    author_name: tweet.author.displayName || handle,
    author_handle: handle,
    avatar_url: tweet.author.avatar ?? null,
    date: parseTwitterDate(tweet.createdAt),
    text_content: tweet.content?.trim() || null,
    status_url: `https://x.com/${handle}/status/${tweet.id}`,
    reply_count: stats.replies ?? 0,
    retweet_count: stats.retweets ?? 0,
    like_count: stats.likes ?? 0,
    view_count: stats.views ?? 0,
    photo_urls: photos.length ? JSON.stringify(photos) : null,
    video_poster_url: videoPoster,
    video_url: videoUrl,
    retweeted_by: tweet.retweetedBy?.username ?? null,
    is_pinned: tweet.isPinned ? 1 : 0,
    quoted_text: tweet.quotedTweet?.content?.trim() || null,
    quoted_handle: tweet.quotedTweet?.author?.username ?? null,
    reply_to_handles: [],
  };
}

function pickVideoVariant(item: TwvMedia): string | null {
  const variants = item.variants ?? [];
  if (!variants.length) return item.videoUrl ?? null;
  const withBitrate = variants.filter(v => typeof v.bitrate === 'number');
  if (!withBitrate.length) return variants[0].url ?? item.videoUrl ?? null;
  const acceptable = withBitrate.filter(v => (v.bitrate ?? 0) <= PREFERRED_MAX_BITRATE);
  const pool = acceptable.length ? acceptable : withBitrate;
  pool.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
  return pool[0].url ?? item.videoUrl ?? null;
}
