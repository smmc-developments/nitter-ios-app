import assert from 'node:assert/strict';
import test from 'node:test';
import { InstanceUnavailableError, isInstanceFailure } from '../src/upstream-errors.js';

test('typed instance outages and legacy saved 418 errors are recognized', () => {
  assert.equal(isInstanceFailure(new InstanceUnavailableError('Unavailable')), true);
  for (const value of [
    'Nitter returned HTTP 418 for /alice/with_replies',
    'Nitter returned HTTP 429 for /alice/with_replies',
    'Browser session expired for https://instance.example/alice (HTTP 403)',
    'Nitter returned incomplete HTML for /alice',
    'Nitter request failed in direct mode (https://instance.example); automatic failover is disabled',
    'Fetcher not started',
  ]) assert.equal(isInstanceFailure(value), true, value);
});

test('account errors, incidental status numbers, and unknown errors are not instance outages', () => {
  for (const value of [null, undefined, {}, new Error('Invalid account'),
    'Nitter returned HTTP 404 for /alice', 'Nitter returned HTTP 410 for /alice',
    'Nitter returned HTTP 4180 for /alice', 'Invalid account alice418',
  ]) assert.equal(isInstanceFailure(value), false, String(value));
});
