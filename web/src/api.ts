export interface ParentTweet {
  id: string;
  statusURL: string | null;
  authorName: string;
  authorHandle: string;
  avatarURL: string | null;
  date: string | null;
  text: string;
}

export interface Tweet {
  id: string;
  authorName: string | null;
  authorHandle: string | null;
  avatarURL: string | null;
  date: string | null;
  text: string | null;
  statusURL: string | null;
  replyCount: number;
  retweetCount: number;
  likeCount: number;
  viewCount: number;
  photoURLs: string[];
  videoPosterURL: string | null;
  videoURL: string | null;
  retweetedBy: string | null;
  isPinned: boolean;
  quotedText: string | null;
  quotedHandle: string | null;
  parent: ParentTweet | null;
}

export interface Account {
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  last_fetched_at: string | null;
  fetch_error: string | null;
  last_tweet_at: string | null;
  backfill_complete: number;
}

const settings = {
  get baseURL() { return localStorage.getItem('nitter.server')?.replace(/\/$/, '') ?? ''; },
  get apiKey() { return localStorage.getItem('nitter.apiKey') ?? ''; },
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (settings.apiKey) headers.set('Authorization', `Bearer ${settings.apiKey}`);
  if (init?.body) headers.set('Content-Type', 'application/json');
  const response = await fetch(`${settings.baseURL}${path}`, { ...init, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export const api = {
  feed: () => request<{ tweets: Tweet[] }>('/api/feed?limit=500'),
  timeline: (username: string) => request<{ tweets: Tweet[] }>(`/api/timeline/${encodeURIComponent(username)}?limit=100`),
  tweet: (username: string, id: string) => request<{ tweet: Tweet | null; replies: Tweet[] }>(`/api/tweet/${encodeURIComponent(username)}/${encodeURIComponent(id)}`),
  accounts: () => request<Account[]>('/api/accounts'),
  addAccount: (username: string) => request<Account>('/api/accounts', { method: 'POST', body: JSON.stringify({ username }) }),
  removeAccount: (username: string) => request<{ ok: boolean }>(`/api/accounts/${encodeURIComponent(username)}`, { method: 'DELETE' }),
  refresh: () => request<{ ok: boolean }>('/api/fetch', { method: 'POST' }),
  health: () => request<{ ok: boolean }>('/health'),
};
