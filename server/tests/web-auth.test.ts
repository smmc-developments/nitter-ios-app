import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { createWebAuthMiddleware } from '../src/web-auth.js';

async function withServer(run: (baseURL: string) => Promise<void>) {
  const app = express();
  app.use(createWebAuthMiddleware('reader', 'a:strong-password'));
  app.get('/', (_req, res) => res.send('Nitter'));
  const server = app.listen(0);
  try {
    const address = server.address();
    assert(address && typeof address !== 'string');
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
  }
}

test('challenges requests without valid web credentials', async () => {
  await withServer(async baseURL => {
    const missing = await fetch(baseURL);
    assert.equal(missing.status, 401);
    assert.equal(missing.headers.get('www-authenticate'), 'Basic realm="Nitter", charset="UTF-8"');

    const invalid = await fetch(baseURL, {
      headers: { authorization: `Basic ${Buffer.from('reader:wrong').toString('base64')}` },
    });
    assert.equal(invalid.status, 401);
  });
});

test('allows requests with valid web credentials', async () => {
  await withServer(async baseURL => {
    const response = await fetch(baseURL, {
      headers: { authorization: `Basic ${Buffer.from('reader:a:strong-password').toString('base64')}` },
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'Nitter');
  });
});

test('requires both web credential variables', () => {
  assert.throws(() => createWebAuthMiddleware('reader', ''), /must be set together/);
  assert.throws(() => createWebAuthMiddleware('', 'password'), /must be set together/);
});

test('allows requests when web credentials are not configured', async () => {
  const app = express();
  app.use(createWebAuthMiddleware('', ''));
  app.get('/', (_req, res) => res.send('Nitter'));
  const server = app.listen(0);
  try {
    const address = server.address();
    assert(address && typeof address !== 'string');
    const response = await fetch(`http://127.0.0.1:${address.port}`);
    assert.equal(response.status, 200);
  } finally {
    server.close();
  }
});
