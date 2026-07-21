import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeTweetDate } from '../src/dates.js';

test('normalizes Nitter UTC dates to sortable ISO-8601', () => {
  assert.equal(
    normalizeTweetDate('Jul 20, 2026 · 8:33 PM UTC'),
    '2026-07-20T20:33:00.000Z',
  );
  assert.equal(
    normalizeTweetDate('Jan 2, 2025 · 12:05 AM UTC'),
    '2025-01-02T00:05:00.000Z',
  );
});

test('rejects unknown date formats', () => {
  assert.equal(normalizeTweetDate('not a date'), null);
});
