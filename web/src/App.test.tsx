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
