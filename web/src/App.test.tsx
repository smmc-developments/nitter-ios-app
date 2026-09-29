import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import App from './App';
import type { Tweet } from './api';

const tweet: Tweet = {
  id: '1234567890',
  authorName: 'NASA',
  authorHandle: 'nasa',
  avatarURL: null,
  date: '2026-09-29T12:00:00Z',
  text: 'Hello from space',
  statusURL: 'https://nitter.example/nitter/nasa/status/1234567890',
  replyCount: 1,
  retweetCount: 2,
  likeCount: 3,
  viewCount: 4,
  photoURLs: [],
  videoPosterURL: null,
  videoURL: null,
  retweetedBy: null,
  isPinned: false,
  quotedText: null,
  quotedHandle: null,
  parent: null,
};

function mockTweets(post = tweet, replies: Tweet[] = []) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ tweets: [post], tweet: post, replies }),
  }));
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ tweets: [] }) }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

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

test.each(['/', '/account/nasa', '/tweet/nasa/1234567890'])('shares the Nitter post link on %s', async path => {
  mockTweets();
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  // The companion server's origin must not be used in the shared link.
  localStorage.setItem('nitter.server', 'https://reader.example');
  render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);

  fireEvent.click(await screen.findByRole('button', { name: 'Share' }));

  expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  expect(writeText).toHaveBeenCalledExactlyOnceWith(tweet.statusURL);
  expect(screen.getByRole('heading', { name: path.startsWith('/tweet') ? 'Conversation' : path.startsWith('/account') ? '@nasa' : 'Latest' })).toBeInTheDocument();
});

test('shares the reply rather than the main conversation post', async () => {
  const reply = { ...tweet, id: '1234567891', text: 'A reply', statusURL: 'https://nitter.example/nitter/nasa/status/1234567891' };
  mockTweets(tweet, [reply]);
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  render(<MemoryRouter initialEntries={['/tweet/nasa/1234567890']}><App /></MemoryRouter>);
  const replyCard = (await screen.findByText('A reply')).closest('article')!;

  fireEvent.click(within(replyCard).getByRole('button', { name: 'Share' }));

  expect(await within(replyCard).findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  expect(writeText).toHaveBeenCalledExactlyOnceWith(reply.statusURL);
});

test('only confirms copying after the clipboard write completes', async () => {
  mockTweets();
  let completeCopy!: () => void;
  const writeText = vi.fn().mockImplementation(() => new Promise<void>(resolve => { completeCopy = resolve; }));
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  render(<MemoryRouter><App /></MemoryRouter>);

  fireEvent.click(await screen.findByRole('button', { name: 'Share' }));
  expect(screen.getByRole('button', { name: 'Copying...' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Copied' })).not.toBeInTheDocument();
  await act(async () => completeCopy());
  expect(screen.getByRole('button', { name: 'Copied' })).toBeEnabled();
});

test('resets the copied confirmation', async () => {
  mockTweets();
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  render(<MemoryRouter><App /></MemoryRouter>);
  const share = await screen.findByRole('button', { name: 'Share' });
  vi.useFakeTimers();

  await act(async () => fireEvent.click(share));
  expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(1500));
  expect(screen.getByRole('button', { name: 'Share' })).toBeInTheDocument();
});

test('shows an error and a link when copying fails', async () => {
  mockTweets();
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('Permission denied')) } });
  render(<MemoryRouter><App /></MemoryRouter>);

  fireEvent.click(await screen.findByRole('button', { name: 'Share' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('Unable to copy the link');
  expect(screen.getByRole('link', { name: 'Open the Nitter post' })).toHaveAttribute('href', tweet.statusURL);
  expect(screen.queryByRole('button', { name: 'Copied' })).not.toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Share' })).toBeEnabled());
});

test('disables sharing when a post has no link', async () => {
  mockTweets({ ...tweet, statusURL: null });
  render(<MemoryRouter><App /></MemoryRouter>);
  expect(await screen.findByRole('button', { name: 'Share' })).toBeDisabled();
});
