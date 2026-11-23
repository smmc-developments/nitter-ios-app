import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectNitterPage } from '../src/nitter-page.js';

test('browser challenges with empty titles are recognized from their visible body', () => {
  const state = inspectNitterPage('<html><head><title></title></head><body><h1>Checking your browser</h1><p>Challenge timed out. Please try refreshing.</p></body></html>');
  assert.equal(state.challenge, true);
  assert.equal(state.content, false);
});

test('challenge phrases in actual tweets do not cause false session expiry', () => {
  const state = inspectNitterPage('<div class="timeline"><div class="timeline-item">Making sure you know: too many requests; checking your browser</div></div>');
  assert.equal(state.content, true);
  assert.equal(state.challenge, false);
  assert.equal(state.blocked, false);
});

test('Nitter conversation pages and reordered class attributes are valid content', () => {
  for (const html of ["<div class='extra timeline'>Posts</div>", '<section class="conversation"><div class="main-tweet">Post</div></section>']) {
    assert.equal(inspectNitterPage(html).content, true);
  }
});

test('explicit Gandalf denials are blocks, not solved or solvable browser challenges', () => {
  const state = inspectNitterPage('<title>Gandalf - You shall not pass!</title><body>You have been blocked by Gandalf.</body>');
  assert.equal(state.blocked, true);
  assert.equal(state.challenge, false);
  assert.equal(state.content, false);
});

test('unknown pages and script text are not accepted as Nitter content or a challenge', () => {
  const state = inspectNitterPage('<title>Unrelated site</title><body><script>const message = "Checking your browser";</script>Unavailable</body>');
  assert.equal(state.content, false);
  assert.equal(state.challenge, false);
});

test('a real Nitter home/search page is recognized for initial session bootstrap', () => {
  const state = inspectNitterPage('<title>Nitter</title><nav class="navbar"></nav><form action="/search"><input name="q"></form>');
  assert.equal(state.home, true);
  assert.equal(state.challenge, false);
});
