import assert from 'node:assert/strict';
import test from 'node:test';
import { parseParentTweet, parseTimeline } from '../src/parser.js';

test('retweet keeps requested timeline owner separate from original author', () => {
  const html = `
    <div class="profile-card">
      <span class="profile-card-username">@alice</span>
      <span class="profile-card-fullname">Alice</span>
    </div>
    <div class="timeline-item" data-username="original">
      <a class="tweet-link" href="/original/status/1234567890"></a>
      <div class="tweet-body">
        <div class="retweet-header">Alice retweeted</div>
        <div class="replying-to">Replying to <a href="/parent">@parent</a></div>
        <div class="tweet-header">
          <a class="fullname">Original Author</a>
          <a class="username">@original</a>
          <span class="tweet-date"><a title="Jul 20, 2026 · 8:33 PM UTC"></a></span>
        </div>
        <div class="tweet-content">Shared post <a href="https://example.com/full/path">example.com/full…</a></div>
        <div class="attachments"><div class="attachment"><video poster="/pic/poster.jpg">
          <source src="/video/vid.twimg.com%2Fclip.mp4" type="video/mp4">
        </video></div></div>
      </div>
    </div>
    <div class="show-more"><a href="?cursor=abc123">Load more</a></div>`;

  const parsed = parseTimeline(html, 'alice');
  assert.equal(parsed.tweets.length, 1);
  assert.equal(parsed.tweets[0].account_username, 'alice');
  assert.equal(parsed.tweets[0].author_handle, 'original');
  assert.equal(parsed.tweets[0].retweeted_by, 'Alice');
  assert.deepEqual(parsed.tweets[0].reply_to_handles, ['parent']);
  assert.equal(parsed.tweets[0].text_content, 'Shared post https://example.com/full/path');
  assert.equal(parsed.tweets[0].video_url, 'https://nitter.poast.org/video/vid.twimg.com%2Fclip.mp4');
  assert.equal(parsed.nextCursor, '?cursor=abc123');
});

test('parses the immediate parent from a reply conversation', () => {
  const html = `
    <div class="before-tweet">
      <div class="timeline-item" data-username="parent">
        <a class="tweet-link" href="/parent/status/111"></a>
        <div class="tweet-body">
          <div class="tweet-header">
            <a class="fullname">Parent Author</a><a class="username">@parent</a>
            <span class="tweet-date"><a title="Jul 20, 2026 · 7:00 PM UTC"></a></span>
          </div>
          <div class="tweet-content">Parent text</div>
        </div>
      </div>
    </div>`;
  const parent = parseParentTweet(html);
  assert.equal(parent?.id, '111');
  assert.equal(parent?.authorHandle, 'parent');
  assert.equal(parent?.text, 'Parent text');
});
