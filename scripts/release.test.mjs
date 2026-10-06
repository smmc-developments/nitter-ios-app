import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ensureGithubRelease, failedNotesTag, githubApi, publishRelease, releaseTarget } from './release.mjs';

const tag = 'v1.9.1';
const published = { tag_name: tag, draft: false, prerelease: false };
const notesError = { command: `git push https://github.com/owner/repo refs/notes/semantic-release-${tag}`, exitCode: 1 };

function repository(t, { annotated = false, pushTag = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'nitter-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'work');
  const origin = join(root, 'origin.git');
  mkdirSync(cwd);
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--bare', origin);
  git('init', '-b', 'main');
  git('config', 'user.name', 'Release Tests');
  git('config', 'user.email', 'release-tests@example.com');
  git('remote', 'add', 'origin', origin);
  const commit = message => git('commit', '--allow-empty', '-m', message);
  const push = () => git('push', 'origin', 'main', '--tags');
  commit('feat: initial');
  git('tag', 'v1.9.0');
  push();
  commit('fix: media');
  git('push', 'origin', 'main');
  git('tag', ...(annotated ? ['-a', '-m', 'Release'] : []), tag);
  if (pushTag) push();
  const sha = git('rev-parse', 'HEAD');
  return { cwd, git, commit, push, sha };
}

function apiFixture({ existing = null } = {}) {
  const calls = [];
  const api = async (method, endpoint, body) => {
    calls.push({ method, endpoint, body });
    if (method === 'GET') return existing;
    if (endpoint === '/releases/generate-notes') return { body: 'Recovered release notes' };
    if (endpoint === '/releases') return published;
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };
  return { api, calls };
}

test('only a failed stable-release Git-notes push is eligible for automatic recovery', () => {
  assert.equal(failedNotesTag(notesError), tag);
  for (const error of [
    new Error('GitHub unavailable'),
    { ...notesError, exitCode: 0 },
    { ...notesError, command: 'git push https://github.com/owner/repo --tags' },
    { ...notesError, command: 'git push https://github.com/owner/repo refs/heads/main' },
    { ...notesError, command: 'git push https://github.com/owner/repo refs/notes/semantic-release-v2.0.0-beta.1' },
    { ...notesError, command: 'git push https://github.com/owner/repo refs/notes/unrelated' },
  ]) assert.equal(failedNotesTag(error), undefined);
});

test('recovery resolves the exact remotely-pushed release commit and previous version', t => {
  const { cwd, sha } = repository(t);
  assert.deepEqual(releaseTarget(cwd, tag), { tag, sha, version: '1.9.1', previousTag: 'v1.9.0' });
});

test('annotated tags are verified against their peeled remote commit', t => {
  const { cwd, sha } = repository(t, { annotated: true });
  assert.equal(releaseTarget(cwd, tag).sha, sha);
});

test('a local-only tag cannot be recovered as a published release', t => {
  const { cwd } = repository(t, { pushTag: false });
  assert.throws(() => releaseTarget(cwd, tag), /Remote tag .* is missing/);
});

test('a mismatched remote tag is rejected rather than moved', t => {
  const { cwd, git } = repository(t, { pushTag: false });
  git('push', 'origin', `refs/tags/v1.9.0:refs/tags/${tag}`);
  assert.throws(() => releaseTarget(cwd, tag), /does not match/);
});

test('older stable releases cannot overwrite latest or major/minor image aliases', t => {
  const { cwd } = repository(t);
  assert.throws(() => releaseTarget(cwd, 'v1.9.0'), /not the latest stable tag/);
});

test('invalid, prerelease, and non-main tags cannot be recovered', t => {
  const { cwd, git, commit } = repository(t);
  for (const value of ['main', '--all', 'v01.9.1', 'v2.0.0-beta.1', 'v1.9.1\npublished=true']) {
    assert.throws(() => releaseTarget(cwd, value), /stable version tag/);
  }
  git('switch', '-c', 'unmerged');
  commit('feat: unmerged');
  git('tag', 'v2.0.0');
  git('push', 'origin', 'refs/tags/v2.0.0');
  assert.throws(() => releaseTarget(cwd, 'v2.0.0'));
});

test('automatic recovery must match HEAD; explicit recovery can target an earlier release commit', t => {
  const { cwd, commit, push, sha } = repository(t);
  commit('ci: fix release recovery');
  push();
  assert.throws(() => releaseTarget(cwd, tag, { requireHead: true }), /not at the workflow commit/);
  assert.equal(releaseTarget(cwd, tag).sha, sha);
});

test('missing GitHub releases use the verified existing tag without a redundant historical target SHA', async () => {
  const { api, calls } = apiFixture();
  await ensureGithubRelease({ tag, sha: 'release-sha', previousTag: 'v1.9.0' }, api);
  assert.deepEqual(calls, [
    { method: 'GET', endpoint: `/releases/tags/${tag}`, body: undefined },
    { method: 'POST', endpoint: '/releases/generate-notes', body: {
      tag_name: tag, previous_tag_name: 'v1.9.0',
    } },
    { method: 'POST', endpoint: '/releases', body: {
      tag_name: tag, name: tag, body: 'Recovered release notes',
      draft: false, prerelease: false, make_latest: 'true',
    } },
  ]);
});

test('existing published releases are reused without changing their release notes', async () => {
  const { api, calls } = apiFixture({ existing: { ...published, body: 'Original notes' } });
  const release = await ensureGithubRelease({ tag }, api);
  assert.equal(release.body, 'Original notes');
  assert.equal(calls.length, 1);
});

test('draft, prerelease, or mismatched GitHub releases cannot authorize Docker publication', async () => {
  for (const existing of [{ ...published, draft: true }, { ...published, prerelease: true }, { ...published, tag_name: 'v1.9.0' }]) {
    const { api, calls } = apiFixture({ existing });
    await assert.rejects(ensureGithubRelease({ tag }, api), /not a published stable GitHub release/);
    assert.equal(calls.length, 1);
  }
});

test('a normal successful semantic release publishes Docker from its exact commit', async t => {
  const { cwd, sha } = repository(t);
  const { api } = apiFixture({ existing: published });
  const result = await publishRelease({ cwd, api, log: () => {}, runSemantic: async () => ({ nextRelease: { gitTag: tag } }) });
  assert.deepEqual(result, { published: true, version: '1.9.1', sha });
});

test('a Git-notes push failure finishes the already-tagged release without deleting tags', async t => {
  const { cwd, sha, git } = repository(t);
  const { api } = apiFixture();
  const result = await publishRelease({ cwd, api, log: () => {}, runSemantic: async () => { throw notesError; } });
  assert.deepEqual(result, { published: true, version: '1.9.1', sha });
  assert.equal(git('rev-parse', `refs/tags/${tag}`), sha);
});

test('unrelated semantic-release errors remain failures even when a tag exists', async t => {
  const { cwd } = repository(t);
  const { api, calls } = apiFixture();
  const error = new Error('GitHub publish permission denied');
  await assert.rejects(publishRelease({ cwd, api, runSemantic: async () => { throw error; } }), value => value === error);
  assert.equal(calls.length, 0);
});

test('a tag moved during release creation cannot authorize Docker publication', async t => {
  const { cwd, git } = repository(t);
  await assert.rejects(publishRelease({ cwd, recoverTag: tag, api: async () => {
    git('push', '--force', 'origin', `refs/tags/v1.9.0:refs/tags/${tag}`);
    return published;
  } }), /does not match/);
});

test('rerunning a tagged commit recovers a missing release and retries existing Docker publications', async t => {
  const { cwd, sha } = repository(t);
  for (const existing of [null, published]) {
    const { api } = apiFixture({ existing });
    const result = await publishRelease({ cwd, api, log: () => {}, runSemantic: async () => false });
    assert.deepEqual(result, { published: true, version: '1.9.1', sha });
  }
});

test('non-release commits do not silently republish an older release', async t => {
  const { cwd, commit, push } = repository(t);
  commit('docs: update deployment');
  push();
  const { api, calls } = apiFixture();
  assert.deepEqual(await publishRelease({ cwd, api, runSemantic: async () => false }), { published: false });
  assert.equal(calls.length, 0);
});

test('explicit recovery after main moves skips semantic-release and retains the original image commit', async t => {
  const { cwd, commit, push, sha } = repository(t);
  commit('ci: recover releases');
  push();
  const { api } = apiFixture();
  const result = await publishRelease({ cwd, recoverTag: tag, api, log: () => {}, runSemantic: async () => { assert.fail('Must not analyze newer commits'); } });
  assert.deepEqual(result, { published: true, version: '1.9.1', sha });
});

test('the GitHub client distinguishes missing releases from authentication and server errors', async () => {
  for (const status of [401, 403, 429, 500]) {
    const api = githubApi({ repository: 'owner/repo', token: 'test-token', fetchImpl: async () => new Response('', { status }) });
    await assert.rejects(api('GET', `/releases/tags/${tag}`), new RegExp(`HTTP ${status}`));
  }
  const missing = githubApi({ repository: 'owner/repo', token: 'test-token', fetchImpl: async () => new Response('', { status: 404 }) });
  assert.equal(await missing('GET', `/releases/tags/${tag}`), null);
  await assert.rejects(missing('POST', '/releases'), /HTTP 404/);
  const denied = githubApi({ repository: 'owner/repo', token: 'test-token', fetchImpl: async () =>
    Response.json({ message: 'Resource not accessible by integration' }, { status: 403 }) });
  await assert.rejects(denied('POST', '/releases'), /HTTP 403 — Resource not accessible by integration/);
});

test('the GitHub client sends authenticated JSON requests with a timeout', async () => {
  const api = githubApi({ repository: 'owner/repo', token: 'test-token', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/owner/repo/releases');
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), { tag_name: tag });
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json(published, { status: 201 });
  } });
  assert.deepEqual(await api('POST', '/releases', { tag_name: tag }), published);
  assert.throws(() => githubApi({ repository: 'owner/repo' }), /GITHUB_TOKEN/);
  assert.throws(() => githubApi({ repository: '../outside', token: 'test-token' }), /GITHUB_REPOSITORY/);
});
