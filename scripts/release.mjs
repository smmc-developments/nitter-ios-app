import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const STABLE_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function stableTags(cwd, ref) {
  return git(cwd, 'tag', '--merged', ref, '--sort=-version:refname').split('\n').filter(tag => STABLE_TAG.test(tag));
}

// Only recover the specific nonessential metadata push that failed AFTER the
// tag push. Authentication, tag pushes, and publish/plugin failures still fail.
export function failedNotesTag(error) {
  const match = error?.command?.match(/^git push \S+ refs\/notes\/semantic-release-(\S+)$/);
  return error?.exitCode && match && STABLE_TAG.test(match[1]) ? match[1] : undefined;
}

export function releaseTarget(cwd, tag, { requireHead = false } = {}) {
  if (!STABLE_TAG.test(tag)) throw new Error('Recovery requires a stable version tag such as v1.9.1');
  const sha = git(cwd, 'rev-parse', '--verify', `refs/tags/${tag}^{commit}`);
  git(cwd, 'merge-base', '--is-ancestor', sha, 'refs/remotes/origin/main');
  if (requireHead && sha !== git(cwd, 'rev-parse', 'HEAD')) {
    throw new Error(`Refusing automatic recovery: ${tag} is not at the workflow commit`);
  }
  if (stableTags(cwd, 'refs/remotes/origin/main')[0] !== tag) {
    throw new Error(`Refusing to republish ${tag}: it is not the latest stable tag on main`);
  }
  // A local tag alone is not proof that semantic-release pushed it successfully.
  const remote = git(cwd, 'ls-remote', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`);
  const refs = new Map(remote.split('\n').filter(Boolean).map(line => {
    const [value, ref] = line.split(/\s+/);
    return [ref, value];
  }));
  if ((refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`)) !== sha) {
    throw new Error(`Remote tag ${tag} is missing or does not match the local release commit`);
  }
  const previousTag = stableTags(cwd, sha).find(value => value !== tag);
  return { tag, version: tag.slice(1), sha, previousTag };
}

export function githubApi({ repository, token, apiUrl = 'https://api.github.com', fetchImpl = fetch }) {
  if (!/^[\w][\w.-]*\/[\w][\w.-]*$/.test(repository ?? '')) throw new Error('GITHUB_REPOSITORY must be owner/repo');
  if (!token) throw new Error('GITHUB_TOKEN is required');
  return async (method, endpoint, body) => {
    const response = await fetchImpl(`${apiUrl}/repos/${repository}${endpoint}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (method === 'GET' && response.status === 404) return null;
    if (!response.ok) {
      const details = await response.json().catch(() => null);
      const message = typeof details?.message === 'string' ? ` — ${details.message}` : '';
      throw new Error(`GitHub ${method} ${endpoint} failed: HTTP ${response.status}${message}`);
    }
    return response.json();
  };
}

export async function ensureGithubRelease(target, api) {
  let release = await api('GET', `/releases/tags/${target.tag}`);
  if (!release) {
    // GitHub-generated notes make recovery independent of semantic-release's
    // failed Git-notes transport. Never remove or retarget an existing tag.
    const notes = await api('POST', '/releases/generate-notes', {
      tag_name: target.tag,
      ...(target.previousTag ? { previous_tag_name: target.previousTag } : {}),
    });
    // target_commitish is unused for an existing tag, but supplying an old SHA
    // can still trigger GitHub's workflows-write check. Use the verified tag.
    release = await api('POST', '/releases', {
      tag_name: target.tag,
      name: target.tag,
      body: notes.body,
      draft: false,
      prerelease: false,
      make_latest: 'true',
    });
  }
  if (release.tag_name !== target.tag || release.draft || release.prerelease) {
    throw new Error(`Refusing Docker publication: ${target.tag} is not a published stable GitHub release`);
  }
  return release;
}

export async function publishRelease({ cwd = process.cwd(), recoverTag, runSemantic, api, log = console.log }) {
  let target;
  if (recoverTag) {
    target = releaseTarget(cwd, recoverTag);
  } else {
    let result;
    try {
      result = await runSemantic();
    } catch (error) {
      const tag = failedNotesTag(error);
      if (!tag) throw error;
      log(`Git-notes push failed; checking the already-pushed ${tag} for recovery.`);
      target = releaseTarget(cwd, tag, { requireHead: true });
    }
    if (!target) {
      const tag = result?.nextRelease?.gitTag ?? stableTags(cwd, 'HEAD').find(value =>
        git(cwd, 'rev-parse', `refs/tags/${value}^{commit}`) === git(cwd, 'rev-parse', 'HEAD'));
      // A non-release commit (docs/ci/chore) must not republish an older image.
      if (!tag) return { published: false };
      target = releaseTarget(cwd, tag, { requireHead: true });
    }
  }
  await ensureGithubRelease(target, api);
  // Recheck after the API calls so a deleted/moved tag or newer release cannot
  // silently cause the image aliases to point at the wrong code.
  releaseTarget(cwd, target.tag);
  log(`Docker publication ready: ${target.tag} at ${target.sha}`);
  return { published: true, version: target.version, sha: target.sha };
}

async function main() {
  // This recovery policy relies on the single stable/default release channel.
  if (process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Releases must run from main');
  const result = await publishRelease({
    recoverTag: process.env.RECOVER_TAG || undefined,
    runSemantic: async () => {
      const { default: semanticRelease } = await import('semantic-release');
      return semanticRelease();
    },
    api: githubApi({
      repository: process.env.GITHUB_REPOSITORY,
      token: process.env.GITHUB_TOKEN,
      apiUrl: process.env.GITHUB_API_URL,
    }),
  });
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(result).map(([key, value]) => `${key}=${value}\n`).join(''));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
