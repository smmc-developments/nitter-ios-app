import { chromium, type BrowserContext } from 'playwright';
import { spawn, execFileSync, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { createLogger, errorMessage } from './logger.js';
import { NitterInstances } from './instances.js';
import { isAllowedImageUrl } from './image-cache.js';
import { MediaNotFoundError } from './media-errors.js';
import { InstanceUnavailableError } from './upstream-errors.js';
import { inspectNitterPage } from './nitter-page.js';

const CDP_PORT = parseInt(process.env.CDP_PORT || '9222');
const MAX_MEDIA_REDIRECTS = 5;
const MAX_PAGE_REDIRECTS = 5;
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
    log(this.instances.automatic
      ? 'Nitter instance mode: automatic — xnotme discovery and timeout failover enabled'
      : 'Nitter instance mode: direct — failover disabled; set NITTER_AUTO_INSTANCE=true to enable it');
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
      throw new PageRequestError(`Session bootstrap failed for ${baseUrl}: ${errorMessage(error)}`,
        error instanceof PageRequestError ? error.baseUrl : baseUrl);
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
      try { baseUrl = await this.instances.select(tried); } catch (error) { throw this.pageFailure(lastError ?? error, tried); }
      tried.add(baseUrl);
      try {
        await this.ensureSession(false, baseUrl, path);
        let page: FetchedPage;
        try {
          page = await this.fetchWithRequest(path, baseUrl);
        } catch (error) {
          if (!(error instanceof SessionExpiredError)) throw error;
          log(`HTTP session expired for ${error.baseUrl}${error.path.split('?')[0]}; re-running browser challenge`);
          await this.ensureSession(true, error.baseUrl, error.path);
          page = await this.fetchWithRequest(error.path, error.baseUrl);
        }
        // Carry the origin with each response; concurrent requests can finish
        // on different instances while another request is switching hosts.
        this.sessions.add(page.baseUrl);
        this.instances.succeeded(page.baseUrl);
        return page;
      } catch (error) {
        if (!(error instanceof InstanceUnavailableError)) throw error;
        lastError = error;
        this.instances.failed(baseUrl, error);
        if (error instanceof PageRequestError && error.baseUrl !== baseUrl) {
          tried.add(error.baseUrl);
          this.instances.failed(error.baseUrl, error);
        }
      }
    }
    throw this.pageFailure(lastError, tried);
  }

  private pageFailure(error: unknown, tried: Set<string>): Error {
    const attempted = [...tried].join(', ') || 'none available';
    const context = this.instances.automatic
      ? `Nitter request failed after trying ${tried.size} instance(s) (${attempted})`
      : `Nitter request failed in direct mode (${attempted}); automatic failover is disabled (NITTER_AUTO_INSTANCE=false)`;
    return new InstanceUnavailableError(`${context}: ${errorMessage(error)}`);
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
          try { baseUrl = await this.instances.select(tried, 'media'); } catch (error) { throw lastError ?? error; }
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
        if (baseUrl) this.instances.succeeded(baseUrl, 'media');
        return response!;
      } catch (error) {
        if (error instanceof MediaNotFoundError) throw error;
        if (!canSwitch || signal.aborted) throw error;
        lastError = error;
        this.instances.failed(baseUrl!, error, 'media');
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

  private instanceBaseUrl(url: URL): string {
    return this.nitterBaseUrls.find(base => new URL(base).origin === url.origin) ?? url.origin;
  }

  private isAllowedPageRedirect(next: URL, original: URL): boolean {
    return !next.username && !next.password && !next.hash
      && next.pathname.toLowerCase() === original.pathname.toLowerCase()
      && (next.origin === original.origin || (next.protocol === 'https:' && this.instances.isInstanceUrl(next.href)));
  }

  private pagePath(url: URL, baseUrl: string): string {
    const prefix = new URL(baseUrl).pathname.replace(/\/+$/, '');
    return (url.pathname.startsWith(prefix + '/') ? url.pathname.slice(prefix.length) : url.pathname) + url.search;
  }

  private async fetchWithRequest(path: string, baseUrl: string): Promise<FetchedPage> {
    if (!this.context) throw new Error('Fetcher not started');
    const original = new URL(`${baseUrl}${path}`);
    let url = original;
    const startTime = Date.now();
    const deadline = startTime + 30_000;
    for (let redirects = 0; ; redirects++) {
      const source = this.instanceBaseUrl(url);
      const displayUrl = url.origin + url.pathname; // Never log anti-bot query tokens.
      let status: number;
      let location: string | undefined;
      let html = '';
      try {
        const remaining = redirects === 0 ? 30_000 : deadline - Date.now();
        if (remaining <= 0) throw new Error('Timeline redirect deadline exceeded (30000ms)');
        const response = await this.context.request.fetch(url.href, {
          maxRedirects: 0, timeout: remaining, headers: { 'user-agent': this.userAgent },
        });
        try {
          status = response.status();
          if (REDIRECT_STATUSES.has(status)) location = response.headers().location;
          else html = await response.text();
        } finally { await response.dispose(); }
      } catch (error) {
        throw new PageRequestError(`Request failed for ${displayUrl}: ${errorMessage(error)}`, source);
      }

      if (REDIRECT_STATUSES.has(status)) {
        if (!location) throw new PageRequestError(`Nitter redirect has no Location for ${displayUrl}`, source);
        if (redirects >= MAX_PAGE_REDIRECTS) throw new PageRequestError(`Nitter redirected too many times for ${displayUrl}`, source);
        let next: URL;
        try { next = new URL(location, url); } catch { throw new PageRequestError(`Nitter returned an invalid redirect for ${displayUrl}`, source); }
        if (!this.isAllowedPageRedirect(next, original)) {
          throw new PageRequestError(`Nitter redirect destination is not allowed for ${displayUrl}`, source);
        }
        url = next;
        continue;
      }

      const state = inspectNitterPage(html);
      if (status === 418 || state.blocked) {
        throw new PageRequestError(`Nitter blocked the request for ${displayUrl} (HTTP ${status})`, source);
      }
      if (status === 429 || (!state.content && html.toLowerCase().includes('too many requests'))) {
        throw new PageRequestError(`429 rate limited for ${displayUrl}`, source);
      }
      if (status === 403 || status === 503 || state.challenge) {
        throw new SessionExpiredError(`Browser session expired for ${displayUrl} (HTTP ${status})`, source, this.pagePath(url, source));
      }
      if (status < 200 || status >= 300) {
        if (status >= 500) throw new PageRequestError(`Nitter returned HTTP ${status} for ${displayUrl}`, source);
        throw new Error(`Nitter returned HTTP ${status} for ${displayUrl}`);
      }
      if (state.error) throw new PageRequestError(`Nitter returned an error page for ${displayUrl}`, source);
      if (!state.content) throw new PageRequestError(`Nitter returned incomplete HTML for ${displayUrl}`, source);

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      log(`[${url.pathname}] HTTP fast path done in ${elapsed}s — HTML length: ${html.length}`);
      return { html, baseUrl: source };
    }
  }

  private async solveChallenge(path: string, baseUrl: string): Promise<void> {
    if (!this.context) throw new Error('Fetcher not started');

    const url = `${baseUrl}${path}`;
    const original = new URL(url);
    const displayPath = original.pathname;
    log(`Browser challenge bootstrap fetching ${original.origin}${displayPath}`);
    const startTime = Date.now();

    const page = await this.context.newPage();
    log(`Page opened for ${displayPath}`);
    try {
      await page.route('**/*', route => {
        const request = route.request();
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
          const next = new URL(request.url());
          if (next.username || next.password
            || (next.origin !== original.origin && !this.isAllowedPageRedirect(next, original))) return route.abort();
        }
        return route.continue();
      });
      const response = await page.goto(url, { waitUntil: 'commit', timeout: 30_000 });
      if (response?.status() === 418) {
        throw new PageRequestError(`Nitter blocked browser session bootstrap for ${original.origin}${displayPath} (HTTP 418)`, baseUrl);
      }
      log(`Initial navigation complete for ${displayPath}`);

      for (let i = 0; i < 30; i++) {
        await page.waitForTimeout(2_000);
        try {
          const state = inspectNitterPage(await page.content());
          const current = new URL(page.url());
          const source = this.instanceBaseUrl(current);
          log(`[${displayPath}] poll ${i + 1}: title = "${state.title}"`);

          // Detect 429 rate limiting — fail immediately so scheduler can backoff.
          if (state.title.includes('429') || state.title.toLowerCase().includes('too many')) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            throw new PageRequestError(`429 rate limited for ${displayPath} (elapsed: ${elapsed}s)`, source);
          }

          if (state.blocked) throw new PageRequestError(`Browser challenge rejected the request for ${current.origin}${current.pathname}`, source);
          if (state.error) throw new PageRequestError(`Browser returned a Nitter error page for ${current.origin}${current.pathname}`, source);
          if (!state.challenge && (state.content || (displayPath === '/' && state.home))) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            log(`[${displayPath}] Browser challenge solved in ${elapsed}s`);
            return;
          }
          if (!state.challenge) throw new PageRequestError(`Browser returned non-Nitter content for ${current.origin}${current.pathname}`, source);
        } catch (err: any) {
          log.debug(`[${displayPath}] Poll ${i + 1} error: ${err?.message}`);
          throw err;
        }
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      throw new Error(`Challenge did not solve for ${displayPath} within 60s (elapsed: ${elapsed}s)`);
    } finally {
      await page.close().catch(() => {});
    }
  }
}

class PageRequestError extends InstanceUnavailableError {
  constructor(message: string, readonly baseUrl: string) { super(message); }
}

class SessionExpiredError extends PageRequestError {
  constructor(message: string, baseUrl: string, readonly path: string) { super(message, baseUrl); }
}
