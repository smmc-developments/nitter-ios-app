import * as cheerio from 'cheerio';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { createLogger } from './logger.js';

export const XXCANCEL_URL = 'https://xxcancel.com';
const REFRESH_MS = 15 * 60_000;
const COOLDOWN_MS = 5 * 60_000;
const log = createLogger('instances');

export function configuredBaseUrl(): string {
  return (process.env.NITTER_BASE_URL || 'https://nitter.click').replace(/\/+$/, '');
}

export function automaticInstances(): boolean {
  return process.env.NITTER_AUTO_INSTANCE === 'true' || configuredBaseUrl() === XXCANCEL_URL;
}

export function shareBaseUrl(): string {
  return automaticInstances() ? XXCANCEL_URL : configuredBaseUrl();
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
        || url.origin === XXCANCEL_URL) continue;
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

export async function discoverInstances(resolve = (hostname: string): Promise<Array<{ address: string }>> => lookup(hostname, { all: true })): Promise<string[]> {
  // xxcancel uses JavaScript/meta refresh, not HTTP redirects. Resolve its
  // advertised destinations without executing third-party JavaScript.
  const response = await fetch(`${XXCANCEL_URL}/nasa`, {
    redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Instance discovery returned HTTP ${response.status}`);
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
  if (!result.length) throw new Error('xxcancel did not advertise any usable public Nitter instances');
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
    this.fallback = base === XXCANCEL_URL ? 'https://nitter.click' : base;
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
        log(`Discovered ${discovered.length} Nitter instance(s) through xxcancel`);
      } catch (error) {
        log.warn(`Discovery failed; retaining known instances: ${String(error)}`);
      } finally {
        this.refreshedAt = this.now();
      }
    })();
    this.refreshing = promise;
    try { await promise; } finally { this.refreshing = null; }
  }
}
