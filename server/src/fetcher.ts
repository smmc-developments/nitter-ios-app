import { chromium, type BrowserContext } from 'playwright';
import { spawn, execFileSync, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';

const CDP_PORT = parseInt(process.env.CDP_PORT || '9222');
const BASE_URL = process.env.NITTER_BASE_URL || 'https://nitter.poast.org';

function log(msg: string) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [fetcher] ${msg}`);
}

function findChromePath(): string {
  const envPath = process.env.CHROME_PATH;
  if (envPath && existsSync(envPath)) {
    log(`Chrome from CHROME_PATH: ${envPath}`);
    return envPath;
  }

  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
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
      '--user-data-dir=/tmp/nitter-chrome-profile',
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
      log(`Chrome process error: ${err.message}`);
    });
    this.chrome.on('exit', (code, signal) => {
      this.ready = false;
      this.sessionReady = false;
      this.context = null;
      log(`Chrome process exited: code=${code} signal=${signal}`);
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
    if (this.context) {
      try {
        await this.context.browser()?.close();
        log('Browser closed');
      } catch (err: any) {
        log(`Error closing browser: ${err?.message}`);
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

  getContext(): BrowserContext | null {
    return this.context;
  }

  async ensureSession(forceRefresh = false): Promise<void> {
    if (!this.ready || !this.context) throw new Error('Fetcher not started');
    if (forceRefresh) this.sessionReady = false;
    if (this.sessionReady) return;
    if (this.sessionPromise) return this.sessionPromise;

    const promise = this.solveChallenge('/');
    this.sessionPromise = promise;
    try {
      await promise;
      this.sessionReady = true;
      log('Nitter HTTP session ready');
    } finally {
      this.sessionPromise = null;
    }
  }

  async fetchPage(path: string): Promise<string> {
    if (!this.ready || !this.context) throw new Error('Fetcher not started');

    if (this.sessionReady) {
      try {
        return await this.fetchWithRequest(path);
      } catch (err) {
        if (!(err instanceof SessionExpiredError)) throw err;
        log(`HTTP session expired for ${path}; re-running browser challenge`);
        this.sessionReady = false;
      }
    }

    await this.ensureSession();
    return this.fetchWithRequest(path);
  }

  async fetchMedia(
    url: string,
    headers: Record<string, string>,
    signal: AbortSignal,
    method: 'GET' | 'HEAD' = 'GET',
  ): Promise<Response> {
    if (!this.ready || !this.context) throw new Error('Fetcher not started');
    await this.ensureSession();

    for (let attempt = 0; attempt < 2; attempt++) {
      const cookies = await this.context.cookies(BASE_URL);
      const response = await fetch(url, {
        method,
        headers: {
          ...headers,
          accept: 'video/mp4,video/*;q=0.9,*/*;q=0.5',
          cookie: cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '),
          'user-agent': this.userAgent,
        },
        redirect: 'follow',
        signal,
      });
      if (attempt === 0 && (response.status === 403 || response.status === 503)) {
        await response.body?.cancel();
        await this.ensureSession(true);
        continue;
      }
      return response;
    }
    throw new Error('Unable to fetch video');
  }

  private async fetchWithRequest(path: string): Promise<string> {
    if (!this.context) throw new Error('Fetcher not started');
    const url = `${BASE_URL}${path}`;
    const startTime = Date.now();
    const response = await this.context.request.fetch(url, {
      maxRedirects: 0,
      timeout: 30_000,
    });
    const html = await response.text();
    const lower = html.toLowerCase();

    if (response.status() === 429 || lower.includes('too many requests')) {
      throw new Error(`429 rate limited for ${path}`);
    }
    if (response.status() === 503 || lower.includes('verifying your browser')) {
      throw new SessionExpiredError();
    }
    if (!response.ok()) {
      throw new Error(`Nitter returned HTTP ${response.status()} for ${path}`);
    }
    if (lower.includes('class="error-panel"')) {
      throw new Error(`Nitter returned an error page for ${path}`);
    }
    if (!lower.includes('class="timeline') && !lower.includes('class="profile-card')) {
      throw new Error(`Nitter returned incomplete HTML for ${path}`);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log(`[${path}] HTTP fast path done in ${elapsed}s — HTML length: ${html.length}`);
    return html;
  }

  private async solveChallenge(path: string): Promise<void> {
    if (!this.context) throw new Error('Fetcher not started');

    const url = `${BASE_URL}${path}`;
    log(`Browser challenge bootstrap fetching ${url}`);
    const startTime = Date.now();

    const page = await this.context.newPage();
    log(`Page opened for ${path}`);
    try {
      await page.goto(url, { waitUntil: 'commit', timeout: 30_000 });
      log(`Initial navigation complete for ${path}`);

      for (let i = 0; i < 30; i++) {
        await page.waitForTimeout(2_000);
        try {
          const title = await page.title();
          log(`[${path}] poll ${i + 1}: title = "${title}"`);

          // Detect 429 rate limiting — fail immediately so scheduler can backoff.
          if (title.includes('429') || title.toLowerCase().includes('too many')) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            throw new Error(`429 rate limited for ${path} (elapsed: ${elapsed}s)`);
          }

          const lowerTitle = title.toLowerCase();
          if (!lowerTitle.includes('verifying') && !lowerTitle.startsWith('loading ')) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            log(`[${path}] Browser challenge solved in ${elapsed}s`);
            return;
          }
        } catch (err: any) {
          log(`[${path}] Poll ${i + 1} error: ${err?.message}`);
          throw err;
        }
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      throw new Error(`Challenge did not solve for ${path} within 60s (elapsed: ${elapsed}s)`);
    } finally {
      await page.close().catch(() => {});
    }
  }
}

class SessionExpiredError extends Error {}
