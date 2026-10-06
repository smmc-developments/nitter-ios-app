import { chromium, type BrowserContext } from 'playwright';
import { spawn, execFileSync, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { createLogger } from './logger.js';
import { NitterInstances } from './instances.js';
import { isAllowedImageUrl } from './image-cache.js';
import { MediaNotFoundError } from './media-errors.js';

const CDP_PORT = parseInt(process.env.CDP_PORT || '9222');
const MAX_MEDIA_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const log = createLogger('fetcher');

export interface FetchedPage {
  html: string;
  baseUrl: string;
}

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
    '/Applications/Arc.app/Contents/MacOS/Arc',
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
  private sessions = new Set<string>();
  private sessionPromises = new Map<string, Promise<void>>();
  private userAgent = 'Mozilla/5.0';

  constructor(private instances = new NitterInstances()) {}

  get nitterBaseUrls(): readonly string[] { return this.instances.baseUrls; }

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
      log.error(`Chrome process error: ${err.message}`);
    });
    this.chrome.on('exit', (code, signal) => {
      this.ready = false;
      this.sessions.clear();
      this.context = null;
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
    this.sessions.clear();
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

  getContext(): BrowserContext | null {
    return this.context;
  }

  async ensureSession(forceRefresh = false, baseUrl?: string, path = '/'): Promise<void> {
    if (!this.ready || !this.context) throw new Error('Fetcher not started');
    if (!baseUrl) {
      const tried = new Set<string>();
      let lastError: unknown;
      for (let attempt = 0; attempt < (this.instances.automatic ? 3 : 1); attempt++) {
        let base: string;
        try { base = await this.instances.select(tried); } catch (error) { throw lastError ?? error; }
        tried.add(base);
        try {
          await this.ensureSession(forceRefresh, base, path);
          return;
        } catch (error) {
          lastError = error;
          this.instances.failed(base, error);
        }
      }
      throw lastError;
    }
    if (forceRefresh) this.sessions.delete(baseUrl);
    if (this.sessions.has(baseUrl)) return;
    const existing = this.sessionPromises.get(baseUrl);
    if (existing) return existing;

    const promise = this.solveChallenge(path, baseUrl).catch(error => {
      throw new InstanceUnavailableError(`Session bootstrap failed for ${baseUrl}: ${String(error)}`);
    });
    this.sessionPromises.set(baseUrl, promise);
    try {
      await promise;
      this.sessions.add(baseUrl);
      log(`Nitter HTTP session ready for ${baseUrl}`);
    } finally {
      this.sessionPromises.delete(baseUrl);
    }
  }

  async fetchPage(path: string): Promise<FetchedPage> {
    if (!this.ready || !this.context) throw new Error('Fetcher not started');
    const tried = new Set<string>();
    let lastError: unknown;
    for (let attempt = 0; attempt < (this.instances.automatic ? 3 : 1); attempt++) {
      let baseUrl: string;
      try { baseUrl = await this.instances.select(tried); } catch (error) { throw lastError ?? error; }
      tried.add(baseUrl);
      try {
        await this.ensureSession(false, baseUrl);
        let html: string;
        try {
          html = await this.fetchWithRequest(path, baseUrl);
        } catch (error) {
          if (!(error instanceof SessionExpiredError)) throw error;
          log(`HTTP session expired for ${baseUrl}${path}; re-running browser challenge`);
          await this.ensureSession(true, baseUrl, path);
          html = await this.fetchWithRequest(path, baseUrl);
        }
        // Carry the origin with each response; concurrent requests can finish
        // on different instances while another request is switching hosts.
        return { html, baseUrl };
      } catch (error) {
        if (!(error instanceof InstanceUnavailableError)) throw error;
        lastError = error;
        this.instances.failed(baseUrl, error);
      }
    }
    throw lastError;
  }

  async fetchImage(url: string): Promise<Response> {
    return this.fetchAsset(url, {}, new AbortController().signal, 'GET',
      value => isAllowedImageUrl(value, this.nitterBaseUrls), 'image');
  }

  async fetchMedia(
    url: string,
    headers: Record<string, string>,
    signal: AbortSignal,
    method: 'GET' | 'HEAD' = 'GET',
    isAllowedRedirect: (url: string) => boolean,
  ): Promise<Response> {
    return this.fetchAsset(url, headers, signal, method, isAllowedRedirect, 'video');
  }

  private async fetchAsset(
    url: string,
    headers: Record<string, string>,
    signal: AbortSignal,
    method: 'GET' | 'HEAD',
    isAllowedRedirect: (url: string) => boolean,
    kind: 'image' | 'video',
  ): Promise<Response> {
    if (!this.ready || !this.context) throw new Error('Fetcher not started');
    signal.throwIfAborted();
    if (!isAllowedRedirect(url)) throw new Error('Media URL is not allowed');
    const instanceMedia = this.instances.isInstanceUrl(url);
    const canSwitch = instanceMedia && this.instances.automatic;
    const tried = new Set<string>();
    let lastError: unknown;
    for (let attempt = 0; attempt < (canSwitch ? 3 : 1); attempt++) {
      signal.throwIfAborted();
      let baseUrl: string | undefined;
      let target = url;
      if (instanceMedia) {
        if (canSwitch) {
          try { baseUrl = await this.instances.select(tried); } catch (error) { throw lastError ?? error; }
          const original = new URL(url);
          target = `${baseUrl}${original.pathname}${original.search}`;
        } else {
          baseUrl = this.nitterBaseUrls.find(base => new URL(base).origin === new URL(url).origin);
        }
        tried.add(baseUrl!);
      }
      // Only configured/discovered media paths can be rewritten or followed.
      if (!isAllowedRedirect(target)) throw new Error('Media URL is not allowed');
      try {
        if (baseUrl) await this.ensureSession(false, baseUrl);
        let response: Response | undefined;
        for (let sessionAttempt = 0; sessionAttempt < 2; sessionAttempt++) {
          const requestSignal = kind === 'image' ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : signal;
          response = await this.fetchMediaFollowingRedirects(target, headers, requestSignal, method, isAllowedRedirect, kind);
          if (baseUrl && sessionAttempt === 0 && (response.status === 403 || response.status === 503)) {
            await response.body?.cancel();
            await this.ensureSession(true, baseUrl);
            continue;
          }
          break;
        }
        if (response!.status === 404 || response!.status === 410) {
          await response!.body?.cancel();
          throw new MediaNotFoundError(response!.status, target);
        }
        const contentType = response!.headers.get('content-type')?.toLowerCase() ?? '';
        const validStatus = response!.ok || (kind === 'video' && response!.status === 416);
        if (!validStatus || (!contentType.startsWith(`${kind}/`)
          && !(kind === 'video' && contentType.startsWith('application/octet-stream')))) {
          await response!.body?.cancel();
          throw new InstanceUnavailableError(`Upstream ${kind} request returned HTTP ${response!.status} (${contentType})`);
        }
        return response!;
      } catch (error) {
        if (error instanceof MediaNotFoundError) throw error;
        if (!canSwitch || signal.aborted) throw error;
        lastError = error;
        this.instances.failed(baseUrl!, error);
      }
    }
    throw lastError;
  }

  // Follows redirects manually so every hop is re-validated against the same
  // allowlist as the initial URL. Blindly following redirects would let an
  // allowlisted URL bounce the server to arbitrary (e.g. internal or
  // attacker-controlled) hosts and stream the response back to clients.
  private async fetchMediaFollowingRedirects(
    initialUrl: string,
    headers: Record<string, string>,
    signal: AbortSignal,
    method: 'GET' | 'HEAD',
    isAllowedRedirect: (url: string) => boolean,
    kind: 'image' | 'video',
  ): Promise<Response> {
    let currentUrl = initialUrl;
    for (let redirectCount = 0; ; redirectCount++) {
      const requestHeaders: Record<string, string> = {
        ...headers,
        accept: kind === 'video' ? 'video/mp4,video/*;q=0.9,*/*;q=0.5' : 'image/*',
        'user-agent': this.userAgent,
      };
      // Session cookies are only for the Nitter origin — never leak them to
      // redirect targets on other hosts.
      if (this.instances.isInstanceUrl(currentUrl)) {
        const cookies = await this.context!.cookies(currentUrl);
        requestHeaders.cookie = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      }
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
        throw new Error('Media redirected too many times');
      }
      const nextUrl = new URL(location, currentUrl).href;
      if (!isAllowedRedirect(nextUrl)) {
        log.warn(`fetchMedia — blocked redirect to disallowed URL: ${nextUrl.slice(0, 160)}`);
        throw new Error('Media redirect target is not allowed');
      }
      currentUrl = nextUrl;
    }
  }

  private async fetchWithRequest(path: string, baseUrl: string): Promise<string> {
    if (!this.context) throw new Error('Fetcher not started');
    const url = `${baseUrl}${path}`;
    const startTime = Date.now();
    let response;
    let html: string;
    try {
      response = await this.context.request.fetch(url, {
        maxRedirects: 0, timeout: 30_000, headers: { 'user-agent': this.userAgent },
      });
      try { html = await response.text(); } finally { await response.dispose(); }
    } catch (error) {
      throw new InstanceUnavailableError(`Request failed for ${url}: ${String(error)}`);
    }
    const lower = html.toLowerCase();

    if (response.status() === 429 || lower.includes('too many requests')) {
      throw new InstanceUnavailableError(`429 rate limited for ${path}`);
    }
    if (response.status() === 403 || response.status() === 503 || lower.includes('verifying your browser')
      || lower.includes('making sure you') || lower.includes('<title>oh noes!') || lower.includes('<title>just a moment')) {
      throw new SessionExpiredError(`Browser session expired for ${url} (HTTP ${response.status()})`);
    }
    if (!response.ok()) {
      if (response.status() >= 500 || REDIRECT_STATUSES.has(response.status())) {
        throw new InstanceUnavailableError(`Nitter returned HTTP ${response.status()} for ${path}`);
      }
      throw new Error(`Nitter returned HTTP ${response.status()} for ${path}`);
    }
    if (lower.includes('class="error-panel"')) {
      throw new InstanceUnavailableError(`Nitter returned an error page for ${path}`);
    }
    if (!lower.includes('class="timeline') && !lower.includes('class="profile-card')) {
      throw new InstanceUnavailableError(`Nitter returned incomplete HTML for ${path}`);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log(`[${path}] HTTP fast path done in ${elapsed}s — HTML length: ${html.length}`);
    return html;
  }

  private async solveChallenge(path: string, baseUrl: string): Promise<void> {
    if (!this.context) throw new Error('Fetcher not started');

    const url = `${baseUrl}${path}`;
    log(`Browser challenge bootstrap fetching ${url}`);
    const startTime = Date.now();

    const page = await this.context.newPage();
    log(`Page opened for ${path}`);
    try {
      await page.route('**/*', route => {
        const request = route.request();
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()
          && new URL(request.url()).origin !== new URL(baseUrl).origin) return route.abort();
        return route.continue();
      });
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
          if (lowerTitle.includes('oh noes!')) throw new Error(`Browser challenge rejected the request for ${url}`);
          if (!lowerTitle.includes('verifying') && !lowerTitle.startsWith('loading ')
            && !lowerTitle.includes('just a moment') && !lowerTitle.includes('security check')
            && !lowerTitle.includes('making sure') && !lowerTitle.includes('checking your browser')) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            log(`[${path}] Browser challenge solved in ${elapsed}s`);
            return;
          }
        } catch (err: any) {
          log.debug(`[${path}] Poll ${i + 1} error: ${err?.message}`);
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

class InstanceUnavailableError extends Error {}
class SessionExpiredError extends InstanceUnavailableError {}
