import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import App from './App';

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ tweets: [] }) }));
});

afterEach(() => vi.unstubAllGlobals());

test('renders the feed shell', async () => {
  render(<MemoryRouter><App /></MemoryRouter>);
  expect(screen.getByRole('heading', { name: 'Latest' })).toBeInTheDocument();
  expect(await screen.findByText('Nothing here yet')).toBeInTheDocument();
});

test('renders settings fields', () => {
  render(<MemoryRouter initialEntries={['/settings']}><App /></MemoryRouter>);
  expect(screen.getByLabelText('Server URL')).toBeInTheDocument();
  expect(screen.getByLabelText('API key')).toBeInTheDocument();
});

test('renders server logs', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({
      entries: [{ id: 1, ts: '2026-09-10T18:04:33.421Z', level: 'warn', scope: 'routes', message: 'Auth failed for GET /api/feed' }],
      latest: 1,
    }),
  }));
  render(<MemoryRouter initialEntries={['/logs']}><App /></MemoryRouter>);
  expect(screen.getByRole('heading', { name: 'Server Logs' })).toBeInTheDocument();
  expect(await screen.findByText('Auth failed for GET /api/feed')).toBeInTheDocument();
  expect(screen.getByText('WARN')).toBeInTheDocument();
  expect(screen.getByText(/routes/)).toBeInTheDocument();
});
