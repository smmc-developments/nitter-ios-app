import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import express from 'express';
import type { Fetcher } from '../src/fetcher.js';
import type { ImageCache } from '../src/image-cache.js';

const dataDir = mkdtempSync(join(tmpdir(), 'nitter-tweet-route-'));
process.env.DATA_DIR = dataDir;
process.env.NITTER_BASE_URL = 'https://nitter.example/nitter/';

const { createRouter } = await import('../src/routes.js');
const database = await import('../src/db.js');

test.after(() => {
  database.default.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function setup() {
  const fetchedPaths: string[] = [];
  const fetcher = {
    fetchPage: async (path: string) => {
      fetchedPaths.push(path);
      return `
        <div class="conversation">
          <div class="before-tweet">
            <div class="timeline-item" data-username="parentuser">
              <a class="tweet-link" href="/parentuser/status/1234567889"></a>
              <div class="tweet-body">
                <div class="tweet-header">
                  <a class="fullname">Parent User</a><a class="username">@parentuser</a>
                </div>
                <div class="tweet-content">Parent</div>
              </div>
            </div>
          </div>
          <div class="main-tweet">
            <div class="timeline-item" data-username="nasa">
              <a class="tweet-link" href="/nasa/status/1234567890"></a>
              <div class="tweet-body">
                <div class="tweet-header">
                  <a class="fullname">NASA</a><a class="username">@nasa</a>
                </div>
                <div class="tweet-content">Hello</div>
              </div>
            </div>
          </div>
          <div class="replies">
            <div class="timeline-item" data-username="replyuser">
              <a class="tweet-link" href="/replyuser/status/1234567891"></a>
              <div class="tweet-body">
                <div class="tweet-header">
                  <a class="fullname">Reply User</a><a class="username">@replyuser</a>
                </div>
                <div class="tweet-content">Reply</div>
              </div>
            </div>
          </div>
        </div>`;
    },
  } as unknown as Fetcher;
  const scheduler = { isRunning: false, run: async () => {} };
  const imageCache = {} as ImageCache;
  const app = express();
  app.use('/api', createRouter(fetcher, scheduler, imageCache, 'test-secret'));
  return { app, fetchedPaths };
}

async function withServer<T>(app: express.Express, run: (base: string) => Promise<T>): Promise<T> {
  const server = app.listen(0);
  try {
    const address = server.address();
    assert(address && typeof address !== 'string');
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
  }
}

test('tweet route fetches the tweet and its replies for valid params', async () => {
  const { app, fetchedPaths } = setup();
  await withServer(app, async base => {
    const response = await fetch(`${base}/api/tweet/NASA/1234567890`);
    assert.equal(response.status, 200);
    assert.deepEqual(fetchedPaths, ['/nasa/status/1234567890']);
    const body = await response.json() as {
      tweet: { id: string; statusURL: string } | null;
      replies: Array<{ id: string; authorHandle: string; statusURL: string }>;
    };
    assert.equal(body.tweet?.id, '1234567890');
    assert.equal(body.replies.length, 1);
    assert.equal(body.replies[0].id, '1234567891');
    assert.equal(body.replies[0].authorHandle, 'replyuser');
    assert.equal(body.tweet?.statusURL, 'https://nitter.example/nitter/nasa/status/1234567890');
    assert.equal(body.replies[0].statusURL, 'https://nitter.example/nitter/replyuser/status/1234567891');
  });
});

test('feed and timeline links use the current instance for cached reposts and missing URLs', async () => {
  database.addAccount('resharer');
  const cachedTweet = {
    id: '1234567893',
    account_username: 'resharer',
    author_name: 'Original Author',
    author_handle: '@original',
    avatar_url: null,
    date: '2026-09-29T12:00:00Z',
    text_content: 'Cached post',
    status_url: 'https://old-instance.example/original/status/1234567893#summary',
    reply_count: 0,
    retweet_count: 0,
    like_count: 0,
    view_count: 0,
    photo_urls: null,
    video_poster_url: null,
    video_url: null,
    retweeted_by: 'Resharer',
    is_pinned: 0,
    quoted_text: null,
    quoted_handle: null,
  };
  database.upsertTweet(cachedTweet);
  database.upsertTweet({ ...cachedTweet, id: '1234567894', status_url: null });
  database.upsertTweet({ ...cachedTweet, id: '1234567895', author_handle: null, status_url: 'https://old-instance.example/original/status/1234567895' });

  const { app } = setup();
  await withServer(app, async base => {
    for (const path of ['/api/feed', '/api/timeline/resharer']) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 200);
      const body = await response.json() as { tweets: Array<{ id: string; statusURL: string }> };
      for (const id of ['1234567893', '1234567894', '1234567895']) {
        assert.equal(body.tweets.find(tweet => tweet.id === id)?.statusURL, `https://nitter.example/nitter/original/status/${id}`);
      }
    }
  });
});

test('post links use the default Nitter instance when none is configured', async () => {
  const configuredBaseUrl = process.env.NITTER_BASE_URL;
  delete process.env.NITTER_BASE_URL;
  try {
    const { app } = setup();
    await withServer(app, async base => {
      const response = await fetch(`${base}/api/tweet/nasa/1234567890`);
      const body = await response.json() as { tweet: { statusURL: string } };
      assert.equal(body.tweet.statusURL, 'https://nitter.click/nasa/status/1234567890');
    });
  } finally {
    process.env.NITTER_BASE_URL = configuredBaseUrl;
  }
});

test('timeline route emits decodable defaults for malformed legacy rows', async () => {
  database.addAccount('legacy');
  database.upsertTweet({
    id: '1234567892',
    account_username: 'legacy',
    author_name: null,
    author_handle: null,
    avatar_url: null,
    date: null,
    text_content: null,
    status_url: null,
    reply_count: 0,
    retweet_count: 0,
    like_count: 0,
    view_count: 0,
    photo_urls: null,
    video_poster_url: null,
    video_url: null,
    retweeted_by: null,
    is_pinned: 0,
    quoted_text: null,
    quoted_handle: null,
  });
  database.default.prepare(`
    UPDATE tweets SET photo_urls = 'not-json', reply_count = NULL WHERE id = ?
  `).run('1234567892');

  const { app } = setup();
  await withServer(app, async base => {
    const response = await fetch(`${base}/api/timeline/legacy`);
    assert.equal(response.status, 200);
    const body = await response.json() as { tweets: Array<Record<string, unknown>> };
    assert.deepEqual(body.tweets, [{
      id: '1234567892',
      authorName: '',
      authorHandle: '',
      avatarURL: null,
      date: null,
      text: '',
      statusURL: null,
      replyCount: 0,
      retweetCount: 0,
      likeCount: 0,
      viewCount: 0,
      photoURLs: [],
      videoPosterURL: null,
      videoURL: null,
      retweetedBy: null,
      isPinned: false,
      quotedText: null,
      quotedHandle: null,
      parent: null,
    }]);
  });
});

test('tweet route rejects encoded traversal in username', async () => {
  const { app, fetchedPaths } = setup();
  await withServer(app, async base => {
    const response = await fetch(`${base}/api/tweet/..%2F..%2Fsearch/123`);
    assert.equal(response.status, 400);
    assert.deepEqual(fetchedPaths, []);
  });
});

test('tweet route rejects encoded slashes and non-numeric tweet IDs', async () => {
  const { app, fetchedPaths } = setup();
  await withServer(app, async base => {
    for (const path of ['/api/tweet/nasa/12%2F34', '/api/tweet/nasa/abc', '/api/tweet/nasa/123%3Ffoo']) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 400, path);
    }
    assert.deepEqual(fetchedPaths, []);
  });
});
