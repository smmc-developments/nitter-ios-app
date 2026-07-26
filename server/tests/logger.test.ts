import assert from 'node:assert/strict';
import test from 'node:test';
import { isLogLevelEnabled, parseLogLevel } from '../src/logger.js';

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
