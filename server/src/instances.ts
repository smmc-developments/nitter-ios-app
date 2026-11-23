import * as cheerio from 'cheerio';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { createLogger, errorDetails } from './logger.js';

export const XXCANCEL_URL = 'https://xxcancel.com';
export const XNOTME_URL = 'https://xnotme.com';
const DISPATCHER_ORIGINS = new Set([XXCANCEL_URL, XNOTME_URL]);
const DISCOVERY_PATH = '/nasa';
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_DISCOVERY_REDIRECTS = 3;
const REFRESH_MS = 15 * 60_000;
const COOLDOWN_MS = 5 * 60_000;
const log = createLogger('instances');

export function configuredBaseUrl(): string {
  return (process.env.NITTER_BASE_URL || 'https://nitter.click').replace(/\/+$/, '');
}

export function automaticInstances(): boolean {
  return process.env.NITTER_AUTO_INSTANCE === 'true' || DISPATCHER_ORIGINS.has(configuredBaseUrl());
}

export function shareBaseUrl(): string {
  return automaticInstances() ? XNOTME_URL : configuredBaseUrl();
}

// Only read the routing controls, never arbitrary links in the dispatcher page.
export function parseInstanceOrigins(html: string): string[] {
  const $ = cheerio.load(html);
  const links = [$('#redirect-controls').attr('data-redirect-url'), $('#open-now').attr('href')];
  $('#instance-options a[href]').each((_, element) => { links.push($(element).attr('href')); });
  const origins = new Set<string>();
  for (const link of links) {
    if (!link) continue;
    try {
      const url = new URL(link);
      const host = url.hostname;
      if (url.protocol !== 'https:' || url.username || url.password || url.port
        || url.pathname !== '/nasa' || url.search || url.hash
        || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host) || isIP(host)
        || /\.(localhost|local|internal|test|invalid|onion)$/i.test(host)
        || DISPATCHER_ORIGINS.has(url.origin)) continue;
      origins.add(url.origin);
    } catch {
      // Ignore malformed or unsafe destinations.
    }
  }
  return [...origins].slice(0, 20);
}

const privateAddresses = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) privateAddresses.addSubnet(address, prefix, 'ipv4');
privateAddresses.addSubnet('2001:db8::', 32, 'ipv6');
privateAddresses.addSubnet('2002::', 16, 'ipv6');
const globalIPv6 = new BlockList();
globalIPv6.addSubnet('2000::', 3, 'ipv6');

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !privateAddresses.check(address, 'ipv4');
  return family === 6 && globalIPv6.check(address, 'ipv6') && !privateAddresses.check(address, 'ipv6');
}

async function fetchDiscoveryPage(): Promise<Response> {
  let url = `${XNOTME_URL}${DISCOVERY_PATH}`;
  const signal = AbortSignal.timeout(15_000);
  for (let redirects = 0; ; redirects++) {
    const response = await fetch(url, { redirect: 'manual', signal });
    if (!REDIRECT_STATUSES.has(response.status)) {
      if (response.ok) return response;
      await response.body?.cancel();
      throw new Error(`Instance discovery returned HTTP ${response.status}`);
    }
    await response.body?.cancel();
    if (redirects >= MAX_DISCOVERY_REDIRECTS) throw new Error('Instance discovery redirected too many times');
    const location = response.headers.get('location');
    if (!location) throw new Error('Instance discovery redirect is missing Location');
    let next: URL;
    try { next = new URL(location, url); } catch { throw new Error('Instance discovery returned an invalid redirect'); }
    // xxcancel moved to xnotme. Permit only known dispatcher origins and the
    // fixed discovery path, not arbitrary redirects or Nitter proxy targets.
    if (!DISPATCHER_ORIGINS.has(next.origin) || next.username || next.password
      || next.pathname !== DISCOVERY_PATH || next.search || next.hash) {
      throw new Error('Instance discovery redirect destination is not allowed');
    }
    url = next.href;
  }
}

export async function discoverInstances(resolve = (hostname: string): Promise<Array<{ address: string }>> => lookup(hostname, { all: true })): Promise<string[]> {
  // Dispatcher pages route users via JavaScript/meta refresh. Parse the
  // advertised instances without executing that third-party JavaScript.
  const response = await fetchDiscoveryPage();
  const html = await response.text();
  if (html.length > 512_000) throw new Error('Instance discovery response is too large');
  const origins = parseInstanceOrigins(html);
  const approved = await Promise.all(origins.map(async origin => {
    try {
      const addresses = await resolve(new URL(origin).hostname);
      return addresses.length > 0 && addresses.every(entry => isPublicAddress(entry.address)) ? origin : null;
    } catch {
      return null;
    }
  }));
  const result = approved.filter((origin): origin is string => origin !== null);
  if (!result.length) throw new Error('xnotme did not advertise any usable public Nitter instances');
  return result;
}

export class NitterInstances {
  readonly automatic: boolean;
  private fallback: string;
  private candidates: string[];
  private known: string[];
  private active: string | null = null;
  private failedUntil = new Map<string, number>();
  private refreshedAt: number | null = null;
  private refreshing: Promise<void> | null = null;
  private discover: () => Promise<string[]>;
  private now: () => number;

  constructor(options: { automatic?: boolean; baseUrl?: string; discover?: () => Promise<string[]>; now?: () => number } = {}) {
    this.automatic = options.automatic ?? automaticInstances();
    const base = options.baseUrl ?? configuredBaseUrl();
    this.fallback = DISPATCHER_ORIGINS.has(base) ? 'https://nitter.click' : base;
    this.candidates = [this.fallback];
    this.known = [this.fallback];
    this.discover = options.discover ?? discoverInstances;
    this.now = options.now ?? Date.now;
  }

  get baseUrls(): readonly string[] { return this.known; }

  isInstanceUrl(value: string): boolean {
    const origin = new URL(value).origin;
    return this.known.some(base => new URL(base).origin === origin);
  }

  async select(excluded: Set<string> = new Set()): Promise<string> {
    await this.refresh();
    const choose = () => [this.active, ...this.candidates].find((base): base is string =>
      base !== null && !excluded.has(base) && (this.failedUntil.get(base) ?? 0) <= this.now());
    let selected = choose();
    if (!selected && this.automatic && this.refreshedAt !== null && this.now() - this.refreshedAt >= 60_000) {
      await this.refresh(true);
      selected = choose();
    }
    if (!selected) throw new Error('No healthy Nitter instance is currently available');
    this.active = selected;
    return selected;
  }

  failed(base: string, error?: unknown) {
    if (!this.automatic) return;
    this.failedUntil.set(base, this.now() + COOLDOWN_MS);
    if (this.active === base) this.active = null;
    log.warn(`Cooling down failed instance ${base} for ${COOLDOWN_MS / 60_000} minutes${error ? `: ${String(error)}` : ''}`);
  }

  private async refresh(force = false): Promise<void> {
    if (!this.automatic) return;
    if (this.refreshing) return this.refreshing;
    if (!force && this.refreshedAt !== null && this.now() - this.refreshedAt < REFRESH_MS) return;
    const promise = (async () => {
      try {
        const discovered = await this.discover();
        if (!discovered.length) throw new Error('Empty instance list');
        this.candidates = [...new Set([...discovered, this.fallback])];
        // Retain recently discovered origins so cached media still passes the
        // allowlist after a switch, but do not grow the list without bounds.
        this.known = [...new Set([this.fallback, ...(this.active ? [this.active] : []), ...this.candidates, ...this.known])].slice(0, 64);
        for (const base of this.failedUntil.keys()) {
          if (!this.known.includes(base)) this.failedUntil.delete(base);
        }
        log(`Discovered ${discovered.length} Nitter instance(s) through xnotme`);
      } catch (error) {
        log.warn(`Discovery failed for ${XNOTME_URL}; retaining known instances: ${errorDetails(error)}`);
      } finally {
        this.refreshedAt = this.now();
      }
    })();
    this.refreshing = promise;
    try { await promise; } finally { this.refreshing = null; }
  }
}
