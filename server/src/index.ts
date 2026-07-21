import express from 'express';
import { Fetcher } from './fetcher.js';
import { Scheduler } from './scheduler.js';
import { createRouter } from './routes.js';
import { ImageCache } from './image-cache.js';
import type { Request, Response, NextFunction } from 'express';
import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { DATA_DIR } from './paths.js';

const PORT = parseIntegerEnv('PORT', 3000, 1, 65_535);
const FETCH_MINUTES = parseIntegerEnv('FETCH_MINUTES', 15, 1, 24 * 60);
const API_KEY = process.env.API_KEY || '';
const ALLOW_INSECURE_NO_AUTH = process.env.ALLOW_INSECURE_NO_AUTH === 'true';
const PROXY_SECRET = loadProxySecret();

function log(msg: string) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [index] ${msg}`);
}

function loadProxySecret(): string {
  if (process.env.PROXY_SECRET) return process.env.PROXY_SECRET;
  if (API_KEY) return API_KEY;

  mkdirSync(DATA_DIR, { recursive: true });
  const secretPath = join(DATA_DIR, 'proxy-secret');
  if (existsSync(secretPath)) {
    const stored = readFileSync(secretPath, 'utf8').trim();
    if (stored) return stored;
  }

  const generated = randomBytes(32).toString('hex');
  try {
    writeFileSync(secretPath, generated, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return generated;
  } catch {
    const stored = readFileSync(secretPath, 'utf8').trim();
    if (!stored) throw new Error('Persisted proxy secret is empty');
    return stored;
  }
}

function parseIntegerEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function authMiddleware(req: Request, res: Response, next: NextFunction) {
  if (req.path === '/proxy') return next(); // signed, allowlisted image URLs
  if (!API_KEY) return next(); // no key configured — open access

  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    log(`Auth failed for ${req.method} ${req.path} — missing Authorization header`);
    return res.status(401).json({ error: 'Missing Authorization header' });
  }
  const token = header.slice(7);
  // Constant-time comparison to prevent timing attacks
  if (token.length !== API_KEY.length || !timingSafeEqual(token, API_KEY)) {
    log(`Auth failed for ${req.method} ${req.path} — invalid API key`);
    return res.status(403).json({ error: 'Invalid API key' });
  }
  next();
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

async function main() {
  if (process.env.NODE_ENV === 'production' && !API_KEY && !ALLOW_INSECURE_NO_AUTH) {
    throw new Error(
      'API_KEY is required when NODE_ENV=production. '
      + 'For isolated local testing only, set ALLOW_INSECURE_NO_AUTH=true.',
    );
  }
  log('Starting Nitter server...');
  log(`Config: PORT=${PORT}, FETCH_MINUTES=${FETCH_MINUTES}, API_KEY=${API_KEY ? '(set)' : '(not set)'}`);

  const fetcher = new Fetcher();
  await fetcher.start();
  log('Fetcher initialized');
  await fetcher.ensureSession();
  log('Nitter session initialized');

  const imageCache = new ImageCache(fetcher);

  const scheduler = new Scheduler(fetcher, imageCache, FETCH_MINUTES);
  scheduler.start();
  log('Scheduler started');

  const app = express();
  // Caddy terminates TLS one hop upstream; this makes req.protocol honor
  // X-Forwarded-Proto when generating signed media URLs.
  app.set('trust proxy', 1);
  app.use(express.json());

  // Request logging middleware
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const elapsed = Date.now() - start;
      log(`${req.method} ${req.path} ${res.statusCode} ${elapsed}ms`);
    });
    next();
  });

  app.get('/health', (_req, res) => {
    const ok = fetcher.isReady;
    res.status(ok ? 200 : 503).json({ ok });
  });

  const router = createRouter(fetcher, scheduler, imageCache, PROXY_SECRET);
  app.use('/api', authMiddleware, router);

  app.listen(PORT, () => {
    log(`Listening on http://localhost:${PORT}${API_KEY ? ' (auth enabled)' : ' (no auth)'}`);
  });

  const shutdown = async () => {
    log('Shutting down...');
    scheduler.stop();
    await fetcher.stop();
    log('Shutdown complete');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error(`[${new Date().toISOString()}] [index] FATAL: ${err}`);
  process.exit(1);
});
