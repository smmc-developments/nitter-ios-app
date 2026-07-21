import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'xcancel-db-'));
process.env.DATA_DIR = dataDir;
const database = await import('../src/db.js');

test.after(() => {
  database.default.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function tweet(account: string, retweetedBy: string) {
  return {
    id: '1234567890',
    account_username: account,
    author_name: 'Original Author',
    author_handle: 'original',
    avatar_url: null,
    date: '2026-07-20T20:33:00.000Z',
    text_content: 'Shared post',
    status_url: 'https://nitter.poast.org/original/status/1234567890',
    reply_count: 0,
    retweet_count: 1,
    like_count: 2,
    view_count: 3,
    photo_urls: null,
    video_poster_url: null,
    video_url: null,
    retweeted_by: retweetedBy,
    is_pinned: 0,
    quoted_text: null,
    quoted_handle: null,
  };
}

test('one tweet retains independent membership in multiple timelines', () => {
  database.addAccount('alice');
  database.addAccount('bob');
  database.upsertTweet(tweet('alice', 'Alice'));
  database.upsertTweet(tweet('bob', 'Bob'));

  const alice = database.getTimeline('alice', 20);
  const bob = database.getTimeline('bob', 20);
  const feed = database.getFeed(20);

  assert.equal(alice.length, 1);
  assert.equal(alice[0].account_username, 'alice');
  assert.equal(alice[0].retweeted_by, 'Alice');
  assert.equal(bob.length, 1);
  assert.equal(bob[0].account_username, 'bob');
  assert.equal(bob[0].retweeted_by, 'Bob');
  assert.equal(feed.length, 1, 'merged feed deduplicates shared tweet content');

  assert.equal(database.removeAccount('alice'), true);
  assert.equal(database.getTimeline('bob', 20).length, 1, 'deleting one owner preserves shared content');
});

test('failed attempts do not postpone the next scheduled fetch', () => {
  database.addAccount('charlie');
  database.updateAccountFetch('charlie', { error: 'temporary failure' });
  assert.equal(database.getAccount('charlie')?.last_fetched_at, null);

  database.updateAccountFetch('charlie', {});
  assert.notEqual(database.getAccount('charlie')?.last_fetched_at, null);
});

test('newly observed reposts survive retention even when original post is old', () => {
  database.addAccount('dana');
  const old = { ...tweet('dana', 'Dana'), id: '9876543210', date: '2020-01-01T00:00:00.000Z' };
  database.upsertTweet(old);
  database.pruneOldTweets(30);
  assert.equal(database.getTimeline('dana', 20).length, 1);
});

test('stores parent context with a reply for feed delivery', () => {
  database.addAccount('erin');
  const reply = {
    ...tweet('erin', ''),
    id: '222',
    retweeted_by: null,
    video_url: 'https://nitter.poast.org/video/vid.twimg.com%2Fclip.mp4',
  };
  database.upsertTweet(reply);
  assert.equal(database.needsParentEnrichment('222'), true);
  database.storeParentTweet('222', {
    id: '111',
    statusUrl: 'https://nitter.poast.org/parent/status/111',
    authorName: 'Parent Author',
    authorHandle: 'parent',
    avatarUrl: null,
    date: '2026-07-20T19:00:00.000Z',
    text: 'Parent text',
  }, 'found');
  const stored = database.getTimeline('erin', 20)[0];
  assert.equal(stored.parent_id, '111');
  assert.equal(stored.parent_text, 'Parent text');
  assert.equal(stored.video_url, reply.video_url);
  assert.equal(database.needsParentEnrichment('222'), false);
});
