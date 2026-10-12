import assert from 'node:assert/strict';
import test from 'node:test';
import { createLogger, errorMessage, getLogs, isLogLevelEnabled, parseLogLevel, sanitizeLogMessage } from '../src/logger.js';

test('defaults to info and accepts supported log levels case-insensitively', () => {
  assert.equal(parseLogLevel(undefined), 'info');
  assert.equal(parseLogLevel(' DEBUG '), 'debug');
  assert.equal(parseLogLevel('silent'), 'silent');
});

test('rejects unsupported log levels', () => {
  assert.throws(() => parseLogLevel('verbose'), /LOG_LEVEL must be one of/);
});

test('filters messages below the configured level', () => {
  assert.equal(isLogLevelEnabled('debug', 'info'), false);
  assert.equal(isLogLevelEnabled('info', 'info'), true);
  assert.equal(isLogLevelEnabled('error', 'warn'), true);
  assert.equal(isLogLevelEnabled('error', 'silent'), false);
});

test('Playwright errors retain the timeout reason but discard cookie-bearing call logs', () => {
  const error = new Error('apiRequestContext.fetch: Timeout 30000ms exceeded.\nCall log:\n  - → GET https://instance.example/alice\n  - cookie: session=secret-cookie\n  - authorization: Bearer secret-token\n');
  assert.equal(errorMessage(error), 'apiRequestContext.fetch: Timeout 30000ms exceeded.');
  assert.equal(errorMessage({ message: error.message.replaceAll('\n', '\r\n') }), 'apiRequestContext.fetch: Timeout 30000ms exceeded.');
  assert.equal(errorMessage('Connection refused'), 'Connection refused');
  assert.equal(errorMessage(null), 'null');
});

test('sensitive headers are redacted even without a Playwright call log', () => {
  const safe = sanitizeLogMessage('Request failed\n- Cookie: session=secret-cookie\n- Set-Cookie: other=secret-other\nAuthorization: Bearer secret-token\nProxy-Authorization: Basic secret-proxy\nX-Api-Key: secret-key');
  assert.ok(!safe.includes('secret-'));
  assert.ok(!safe.includes('\n'));
  assert.ok(safe.includes('Cookie: [REDACTED]'));
  assert.ok(safe.includes('Authorization: [REDACTED]'));
  assert.equal(sanitizeLogMessage('{"cookie":"secret-cookie","accept":"*/*"}'), '{"cookie":"[REDACTED]","accept":"*/*"}');
});

test('console output and client log buffers receive the same sanitized message', t => {
  const watermark = getLogs().latest;
  const lines: string[] = [];
  t.mock.method(console, 'error', (line: string) => { lines.push(line); });
  const logger = createLogger('redaction-test');
  logger.error('Timeline request timed out\nCall log:\n  - cookie: session=secret-cookie');
  const entries = getLogs({ after: watermark }).entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].message, 'Timeline request timed out');
  assert.equal(lines.length, 1);
  assert.ok(lines[0].endsWith('Timeline request timed out'));
  assert.ok(!lines[0].includes('secret-cookie'));
  assert.ok(!lines[0].includes('\n'));
});

test('log messages are single-line and bounded', () => {
  assert.equal(sanitizeLogMessage('First\r\nSecond\u2028Third'), 'First Second Third');
  assert.equal(sanitizeLogMessage('a'.repeat(10_000)).length, 2_049);
});
