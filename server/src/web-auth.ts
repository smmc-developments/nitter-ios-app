import { createHash, timingSafeEqual } from 'crypto';
import type { RequestHandler } from 'express';

function secureEqual(actual: string, expected: string): boolean {
  const actualHash = createHash('sha256').update(actual).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

export function createWebAuthMiddleware(username: string, password: string): RequestHandler {
  if (!username && !password) return (_req, _res, next) => next();
  if (!username || !password) {
    throw new Error('WEB_USERNAME and WEB_PASSWORD must be set together');
  }
  if (username.includes(':')) {
    throw new Error('WEB_USERNAME cannot contain a colon');
  }

  return (req, res, next) => {
    const header = req.headers.authorization;
    if (header?.startsWith('Basic ')) {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      if (separator !== -1) {
        const suppliedUsername = decoded.slice(0, separator);
        const suppliedPassword = decoded.slice(separator + 1);
        if (secureEqual(suppliedUsername, username) && secureEqual(suppliedPassword, password)) {
          return next();
        }
      }
    }

    res.setHeader('WWW-Authenticate', 'Basic realm="Nitter", charset="UTF-8"');
    res.status(401).send('Authentication required');
  };
}
