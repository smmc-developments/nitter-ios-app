import { createHash } from 'crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'fs/promises';
import path from 'path';
import type { Fetcher } from './fetcher.js';
import { DATA_DIR } from './paths.js';
import { createLogger } from './logger.js';
import { configuredBaseUrl } from './instances.js';

const log = createLogger('image-cache');

const CACHE_DIR = path.join(DATA_DIR, 'images');
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_CACHE_BYTES = 512 * 1024 * 1024;
const MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const PREFETCH_CONCURRENCY = 4;
const MAX_QUEUED_IMAGES = 2_000;

export interface CachedImage {
  body: Buffer;
  contentType: string;
}

export class ImageCache {
  private fetcher: Fetcher;
  private inFlight = new Map<string, Promise<CachedImage>>();
  private queued = new Set<string>();
  private queue: string[] = [];
  private workers = 0;

  constructor(fetcher: Fetcher) {
    this.fetcher = fetcher;
    void mkdir(CACHE_DIR, { recursive: true }).then(() => this.pruneExpired());
  }

  prefetch(urls: Array<string | null | undefined>) {
    for (const url of new Set(urls.filter((value): value is string => Boolean(value)))) {
      if (this.queue.length >= MAX_QUEUED_IMAGES) break;
      if (!isAllowedImageUrl(url, this.fetcher.nitterBaseUrls) || this.queued.has(url) || this.inFlight.has(url)) continue;
      this.queued.add(url);
      this.queue.push(url);
    }
    this.startWorkers();
  }

  async get(url: string): Promise<CachedImage> {
    if (!isAllowedImageUrl(url, this.fetcher.nitterBaseUrls)) throw new Error('Image URL is not allowed');
    const cached = await this.read(url);
    if (cached) return cached;

    const existing = this.inFlight.get(url);
    if (existing) return existing;

    const request = this.fetchAndStore(url);
    this.inFlight.set(url, request);
    try {
      return await request;
    } finally {
      this.inFlight.delete(url);
      this.queued.delete(url);
    }
  }

  private startWorkers() {
    while (this.workers < PREFETCH_CONCURRENCY && this.queue.length > 0) {
      this.workers++;
      void this.runWorker();
    }
  }

  private async runWorker() {
    try {
      while (true) {
        const url = this.queue.shift();
        if (!url) return;
        try {
          await this.get(url);
        } catch (err) {
          log.error(`Prefetch failed: ${String(err)}`);
        } finally {
          this.queued.delete(url);
        }
      }
    } finally {
      this.workers--;
      this.startWorkers();
    }
  }

  private async fetchAndStore(url: string): Promise<CachedImage> {
    const response = await this.fetcher.fetchImage(url);
    try {
      const contentType = response.headers.get('content-type') || '';
      const contentLength = Number(response.headers.get('content-length') || 0);
      if (!response.ok) throw new Error(`Image host returned ${response.status}`);
      if (!contentType.toLowerCase().startsWith('image/')) throw new Error('Upstream response is not an image');
      if (contentLength > MAX_IMAGE_BYTES) throw new Error('Image is too large');

      const reader = response.body?.getReader();
      if (!reader) throw new Error('Image response has no body');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_IMAGE_BYTES) throw new Error('Image is too large');
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const image = { body: Buffer.concat(chunks, size), contentType };
      await this.write(url, image);
      return image;
    } finally {
      await response.body?.cancel().catch(() => {});
    }
  }

  private async read(url: string): Promise<CachedImage | null> {
    const key = cacheKey(url);
    const bodyPath = path.join(CACHE_DIR, `${key}.bin`);
    const metadataPath = path.join(CACHE_DIR, `${key}.json`);
    try {
      const info = await stat(bodyPath);
      if (Date.now() - info.mtimeMs > MAX_AGE_MS) {
        await Promise.all([rm(bodyPath, { force: true }), rm(metadataPath, { force: true })]);
        return null;
      }
      const [body, metadata] = await Promise.all([
        readFile(bodyPath),
        readFile(metadataPath, 'utf8').then(value => JSON.parse(value) as { contentType: string }),
      ]);
      return { body, contentType: metadata.contentType };
    } catch {
      return null;
    }
  }

  private async write(url: string, image: CachedImage) {
    await mkdir(CACHE_DIR, { recursive: true });
    const key = cacheKey(url);
    await Promise.all([
      writeFile(path.join(CACHE_DIR, `${key}.bin`), image.body),
      writeFile(path.join(CACHE_DIR, `${key}.json`), JSON.stringify({ contentType: image.contentType })),
    ]);
  }

  private async pruneExpired() {
    try {
      const files = (await readdir(CACHE_DIR)).filter(file => file.endsWith('.bin'));
      const now = Date.now();
      const entries = await Promise.all(files.map(async file => {
        const filePath = path.join(CACHE_DIR, file);
        const info = await stat(filePath);
        return { file, info };
      }));
      entries.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);

      let retainedBytes = 0;
      await Promise.all(entries.map(async ({ file, info }) => {
        retainedBytes += info.size;
        if (now - info.mtimeMs <= MAX_AGE_MS && retainedBytes <= MAX_CACHE_BYTES) return;
        const key = file.slice(0, -4);
        await Promise.all([
          rm(path.join(CACHE_DIR, `${key}.bin`), { force: true }),
          rm(path.join(CACHE_DIR, `${key}.json`), { force: true }),
        ]);
      }));
    } catch {
      // Cache cleanup is best-effort.
    }
  }
}

function cacheKey(url: string): string {
  return createHash('sha256').update(url).digest('hex');
}

export function isAllowedImageUrl(value: string, bases: readonly string[] = [configuredBaseUrl()]): boolean {
  return isAllowedUrl(value, url =>
    (isNitterUrl(url, bases) && url.pathname.startsWith('/pic/') && !isMp4Path(url))
    || (url.hostname === 'pbs.twimg.com' && !url.port && !isMp4Path(url)));
}

export function isAllowedVideoUrl(value: string, bases: readonly string[] = [configuredBaseUrl()]): boolean {
  return isAllowedUrl(value, url =>
    (isNitterUrl(url, bases) && (url.pathname.startsWith('/video/')
      || (url.pathname.startsWith('/pic/') && isMp4Path(url))))
    || (url.hostname === 'video.twimg.com' && !url.port && isMp4Path(url))
  );
}

function isAllowedUrl(value: string, acceptsUrl: (url: URL) => boolean): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && acceptsUrl(url);
  } catch {
    return false;
  }
}

function isNitterUrl(url: URL, bases: readonly string[]): boolean {
  return bases.some(value => url.origin === new URL(value).origin);
}

function isMp4Path(url: URL): boolean {
  try {
    return decodeURIComponent(url.pathname).toLowerCase().includes('.mp4');
  } catch {
    return url.pathname.toLowerCase().includes('.mp4');
  }
}
