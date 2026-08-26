import assert from 'node:assert/strict';
import test from 'node:test';
import { mapTimeline, mapTweet, mapUser, type TwvTweet } from '../src/twv.js';
import { parseTwitterDate } from '../src/dates.js';

const author = {
  username: 'original',
  displayName: 'Original Author',
  avatar: 'https://pbs.twimg.com/profile_images/1/orig.jpg',
  verified: true,
};

const retweet: TwvTweet = {
  id: '1234567890',
  author,
  content: 'Shared post https://example.com/full/path',
  createdAt: 'Tue Aug 25 16:47:24 +0000 2026',
  stats: { likes: 10, retweets: 20, replies: 5, views: 100 },
  media: [{
    type: 'video',
    url: 'https://pbs.twimg.com/amplify_video_thumb/1/img/poster.jpg',
    thumbnail: 'https://pbs.twimg.com/amplify_video_thumb/1/img/poster.jpg',
    videoUrl: 'https://video.twimg.com/amplify_video/1/vid/avc1/3840x2160/huge.mp4?tag=29',
    variants: [
      { url: 'https://video.twimg.com/amplify_video/1/vid/avc1/3840x2160/huge.mp4?tag=29', bitrate: 25_128_000, width: 3840, height: 2160 },
      { url: 'https://video.twimg.com/amplify_video/1/vid/avc1/1280x720/mid.mp4?tag=29', bitrate: 2_176_000, width: 1280, height: 720 },
      { url: 'https://video.twimg.com/amplify_video/1/vid/avc1/480x270/small.mp4?tag=29', bitrate: 256_000, width: 480, height: 270 },
    ],
  }],
  isRetweet: true,
  retweetedBy: { username: 'alice', displayName: 'Alice' },
  originalTweetId: '111',
};

test('retweet keeps requested timeline owner separate from original author', () => {
  const row = mapTweet(retweet);
  assert.equal(row.account_username, 'original');
  assert.equal(row.author_handle, 'original');
  assert.equal(row.retweeted_by, 'alice');
  assert.equal(row.date, '2026-08-25T16:47:24.000Z');
  assert.equal(row.reply_count, 5);
  assert.equal(row.retweet_count, 20);
  assert.equal(row.view_count, 100);
  // Prefers a mobile-friendly bitrate over the 4K Rendition.
  assert.equal(row.video_url, 'https://video.twimg.com/amplify_video/1/vid/avc1/1280x720/mid.mp4?tag=29');
  assert.equal(row.video_poster_url, 'https://pbs.twimg.com/amplify_video_thumb/1/img/poster.jpg');
  assert.equal(row.status_url, 'https://x.com/original/status/1234567890');
});

test('mapTimeline returns tweets, cursor, and quoted metadata', () => {
  const withQuote: TwvTweet = {
    ...retweet,
    isRetweet: false,
    retweetedBy: null,
    media: [{ type: 'image', url: 'https://pbs.twimg.com/media/abc.jpg' }],
    quotedTweet: {
      id: '999',
      author: { username: 'quoter', displayName: 'Quoter', avatar: null },
      content: 'Quoted text',
      createdAt: 'Mon Aug 24 10:00:00 +0000 2026',
    },
  };
  const result = mapTimeline({
    success: true,
    data: { tweets: [withQuote], nextCursor: 'cur123', hasNextPage: true },
  }, 'alice');
  assert.equal(result.tweets.length, 1);
  assert.equal(result.nextCursor, 'cur123');
  assert.equal(result.tweets[0].quoted_text, 'Quoted text');
  assert.equal(result.tweets[0].quoted_handle, 'quoter');
  assert.deepEqual(JSON.parse(result.tweets[0].photo_urls ?? '[]'), ['https://pbs.twimg.com/media/abc.jpg']);
});

test('mapUser extracts profile identity', () => {
  const account = mapUser({
    id: '44196397',
    username: 'elonmusk',
    displayName: 'Elon Musk',
    avatar: 'https://pbs.twimg.com/profile_images/1/a.jpg',
  });
  assert.deepEqual(account, {
    handle: 'elonmusk',
    name: 'Elon Musk',
    avatarUrl: 'https://pbs.twimg.com/profile_images/1/a.jpg',
  });
});

test('parseTwitterDate handles both API date formats', () => {
  assert.equal(parseTwitterDate('Tue Aug 25 16:47:24 +0000 2026'), '2026-08-25T16:47:24.000Z');
  assert.equal(parseTwitterDate('2026-08-25T16:47:24.000Z'), '2026-08-25T16:47:24.000Z');
  assert.equal(parseTwitterDate(null), null);
  assert.equal(parseTwitterDate('garbage'), null);
});
