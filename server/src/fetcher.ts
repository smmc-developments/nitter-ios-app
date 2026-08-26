import { chromium, type BrowserContext, type Page } from 'playwright';
import { spawn, execFileSync, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { createLogger } from './logger.js';

const CDP_PORT = parseInt(process.env.CDP_PORT || '9222');
// twitterwebviewer.com fronts its JSON API with a Vercel security checkpoint
// that blocks non-browser TLS fingerprints. API calls therefore run inside a
// real browser tab (the SPA's own CORS origin), after the tab has cleared any
// Cloudflare/Vercel challenge on the site.
const API_URL = process.env.TWV_API_URL || 'https://api.twitterwebviewer.com';
const SITE_URL = process.env.TWV_SITE_URL || 'https://twitterwebviewer.com';
const MAX_MEDIA_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const CHALLENGE_TITLE_PATTERNS = ['just a moment', 'verifying', 'checkpoint', 'security check', 'loading'];

const log = createLogger('fetcher');

function findChromePath(): string {
  const envPath = process.env.CHROME_PATH;
  if (envPath && existsSync(envPath)) {
    log(`Chrome from CHROME_PATH: ${envPath}`);
    return envPath;
  }

  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];

  for (const p of candidates) {
    if (existsSync(p)) {
      log(`Chrome auto-detected: ${p}`);
      return p;
    }
  }
  throw new Error('Chrome not found. Set CHROME_PATH env var.');
}

function hasXvfbRun(): boolean {
  try {
    execFileSync('which', ['xvfb-run'], { stdio: 'ignore' });
    log('xvfb-run available');
    return true;
  } catch {
    log('xvfb-run not found');
    return false;
  }
}

function hasDisplay(): boolean {
  if (process.platform === 'darwin') {
    log(`macOS detected — assuming display available`);
    return true;
  }
  const display = process.env.DISPLAY || process.env.WAYLAND_DISPLAY;
  if (display) {
    log(`Display found: ${display}`);
    return true;
  }
  log('No DISPLAY or WAYLAND_DISPLAY set');
  return false;
}

export class Fetcher {
  private chrome: ChildProcess | null = null;
  private context: BrowserContext | null = null;
  private ready = false;
  private sessionReady = false;
  private sessionPromise: Promise<void> | null = null;
  private sessionPage: Page | null = null;
  private userAgent = 'Mozilla/5.0';

  async start() {
    log('initializing...');
    const chromePath = findChromePath();
    const needsXvfb = !hasDisplay() && hasXvfbRun();
    log(`Platform: ${process.platform}, needsXvfb: ${needsXvfb}`);

    const chromeArgs = [
      `--remote-debugging-port=${CDP_PORT}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-gpu',
      '--no-sandbox',
      '--user-data-dir=/tmp/twv-chrome-profile',
    ];
    log(`Chrome args: ${chromeArgs.join(' ')}`);

    if (needsXvfb) {
      log('Spawning Chrome under xvfb...');
      this.chrome = spawn('xvfb-run', [
        '--auto-servernum',
        '--server-args=-screen 0 1280x800x24',
        chromePath,
        ...chromeArgs,
      ], { stdio: 'ignore' });
    } else {
      log('Spawning Chrome directly...');
      this.chrome = spawn(chromePath, chromeArgs, { stdio: 'ignore' });
    }

    this.chrome.on('error', (err) => {
      log.error(`Chrome process error: ${err.message}`);
    });
    this.chrome.on('exit', (code, signal) => {
      this.ready = false;
      this.sessionReady = false;
      this.sessionPage = null;
      log.warn(`Chrome process exited: code=${code} signal=${signal}`);
    });

    // Wait for Chrome to start its CDP server
    log(`Waiting for CDP on port ${CDP_PORT}...`);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        settled = true;
        log('Chrome did not start in time (20s timeout)');
        reject(new Error('Chrome did not start in time'));
      }, 20_000);
      let attempts = 0;
      const check = async () => {
        if (settled) return;
        attempts++;
        try {
          const resp = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
          const data = await resp.json() as { Browser?: string; webSocketDebuggerUrl?: string };
          log(`CDP ready after ${attempts} attempts — ${data.Browser || 'unknown browser'}`);
          settled = true;
          clearTimeout(timeout);
          resolve();
        } catch {
          if (attempts % 5 === 0) {
            log(`Still waiting for CDP... (attempt ${attempts})`);
          }
          setTimeout(check, 500);
        }
      };
      check();
    });

    log('Connecting Playwright over CDP...');
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    const contexts = browser.contexts();
    log(`Browser has ${contexts.length} existing context(s)`);
    this.context = contexts[0] || await browser.newContext();
    if (!contexts[0]) {
      log('Created new browser context');
    }
    const existingPage = this.context.pages()[0];
    const userAgentPage = existingPage ?? await this.context.newPage();
    this.userAgent = await userAgentPage.evaluate(() => navigator.userAgent);
    if (!existingPage) await userAgentPage.close();
    this.ready = true;
    log('Ready');
  }

  async stop() {
    log('Stopping...');
    this.ready = false;
    this.sessionReady = false;
    this.sessionPage = null;
    if (this.context) {
      try {
        await this.context.browser()?.close();
        log('Browser closed');
      } catch (err: any) {
        log.warn(`Error closing browser: ${err?.message}`);
      }
    }
    this.context = null;
    if (this.chrome) {
      this.chrome.kill();
      this.chrome = null;
      log('Chrome process killed');
    }
  }

  get isReady() {
    return this.ready;
  }

  async ensureSession(forceRefresh = false): Promise<void> {
    if (!this.ready || !this.context) throw new Error('Fetcher not started');
    if (forceRefresh) this.sessionReady = false;
    if (this.sessionReady) return;
    if (this.sessionPromise) return this.sessionPromise;

    const promise = this.establishSession();
    this.sessionPromise = promise;
    try {
      await promise;
      this.sessionReady = true;
      log('twitterwebviewer session ready');
    } finally {
      this.sessionPromise = null;
    }
  }

  /// Fetches a JSON API response. `path` is relative to TWV_API_URL
  /// (e.g. "/api/user/nasa").
  async fetchJson(path: string): Promise<unknown> {
    if (!this.ready || !this.context) throw new Error('Fetcher not started');

    if (this.sessionReady) {
      try {
        return await this.fetchJsonViaPage(path);
      } catch (err) {
        if (!(err instanceof SessionExpiredError)) throw err;
        log(`API session expired for ${path}; re-establishing browser session`);
        this.sessionReady = false;
      }
    }

    await this.ensureSession();
    return this.fetchJsonViaPage(path);
  }

  /// Media hosts (pbs.twimg.com / video.twimg.com) are public CDNs that accept
  /// plain HTTP clients — no browser session is needed. Redirects are followed
  /// manually so every hop is re-validated against the same allowlist as the
  /// initial URL; blindly following redirects would let an allowlisted URL
  /// bounce the server to arbitrary (e.g. internal or attacker-controlled)
  /// hosts and stream the response back to clients.
  async fetchMedia(
    url: string,
    headers: Record<string, string>,
    signal: AbortSignal,
    method: 'GET' | 'HEAD' = 'GET',
    isAllowedRedirect: (url: string) => boolean,
  ): Promise<Response> {
    let currentUrl = url;
    for (let redirectCount = 0; ; redirectCount++) {
      const requestHeaders: Record<string, string> = {
        ...headers,
        accept: 'video/mp4,video/*;q=0.9,*/*;q=0.5',
        'user-agent': this.userAgent,
      };
      const response = await fetch(currentUrl, {
        method,
        headers: requestHeaders,
        redirect: 'manual',
        signal,
      });
      const location = response.headers.get('location');
      if (!REDIRECT_STATUSES.has(response.status) || !location) return response;
      await response.body?.cancel();
      if (redirectCount >= MAX_MEDIA_REDIRECTS) {
        throw new Error('Video redirected too many times');
      }
      const nextUrl = new URL(location, currentUrl).href;
      if (!isAllowedRedirect(nextUrl)) {
        log.warn(`fetchMedia — blocked redirect to disallowed URL: ${nextUrl.slice(0, 160)}`);
        throw new Error('Video redirect target is not allowed');
      }
      currentUrl = nextUrl;
    }
  }

  private async fetchJsonViaPage(path: string): Promise<unknown> {
    if (!this.sessionPage) throw new SessionExpiredError();
    const url = `${API_URL}${path}`;
    const startTime = Date.now();

    const result = await this.sessionPage.evaluate(async (target: string) => {
      try {
        const response = await fetch(target, { headers: { accept: 'application/json' } });
        const body = await response.text();
        return { status: response.status, body };
      } catch (err) {
        return { status: 0, body: '', error: String(err) };
      }
    }, url).catch(() => ({ status: 0, body: '', error: 'page evaluate failed' }));

    if (result.status === 429) {
      throw new Error(`429 rate limited for ${path}`);
    }
    if (result.status === 0 || result.body.trimStart().startsWith('<')) {
      // Checkpoint/CDN error page instead of JSON — session must be re-solved.
      throw new SessionExpiredError(`${result.error ?? 'non-JSON response'} for ${path}`);
    }
    if (result.status !== 200) {
      throw new Error(`twitterwebviewer API returned HTTP ${result.status} for ${path}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.body);
    } catch {
      throw new SessionExpiredError(`Invalid JSON from ${path}`);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log(`[${path}] API fetch done in ${elapsed}s — ${result.body.length} bytes`);
    return parsed;
  }

  /// Opens a tab on the site origin and waits until any Cloudflare/Vercel
  /// challenge has cleared. The tab is kept open — its browser context (TLS
  /// fingerprint + cookies) authorizes subsequent same-origin CORS fetches
  /// against the API host.
  private async establishSession(): Promise<void> {
    if (!this.context) throw new Error('Fetcher not started');
    await this.sessionPage?.close().catch(() => {});
    this.sessionPage = null;

    const url = `${SITE_URL}/`;
    log(`Browser session bootstrap fetching ${url}`);
    const startTime = Date.now();

    const page = await this.context.newPage();
    try {
      await page.goto(url, { waitUntil: 'commit', timeout: 30_000 });

      for (let i = 0; i < 30; i++) {
        await page.waitForTimeout(2_000);
        const title = (await page.title().catch(() => '')) ?? '';
        log(`[session] poll ${i + 1}: title = "${title}"`);

        if (title.includes('429') || title.toLowerCase().includes('too many')) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          throw new Error(`429 rate limited for ${url} (elapsed: ${elapsed}s)`);
        }

        const lowerTitle = title.toLowerCase();
        if (lowerTitle && !CHALLENGE_TITLE_PATTERNS.some(pattern => lowerTitle.includes(pattern))) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          log(`[session] challenge cleared in ${elapsed}s`);
          this.sessionPage = page;
          return;
        }
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      throw new Error(`Session did not establish within 60s (elapsed: ${elapsed}s)`);
    } catch (err) {
      await page.close().catch(() => {});
      throw err;
    }
  }
}

class SessionExpiredError extends Error {}
