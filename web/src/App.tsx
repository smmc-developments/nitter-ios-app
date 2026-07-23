import { FormEvent, ReactNode, useEffect, useState } from 'react';
import { Link, NavLink, Route, Routes, useParams } from 'react-router-dom';
import { Account, api, Tweet } from './api';

type Theme = 'system' | 'light' | 'dark';

function useLoad<T>(loader: () => Promise<T>, dependencies: unknown[] = []) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const load = () => {
    setLoading(true);
    setError('');
    loader().then(setData).catch(error => setError(error instanceof Error ? error.message : String(error))).finally(() => setLoading(false));
  };
  // Callers provide primitive route values as dependencies.
  useEffect(load, dependencies); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error, loading, reload: load };
}

function Page({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return <main><header className="page-header"><h1>{title}</h1>{action}</header>{children}</main>;
}

function State({ loading, error, empty }: { loading: boolean; error: string; empty?: boolean }) {
  if (loading) return <div className="state"><span className="spinner" />Loading</div>;
  if (error) return <div className="state error"><strong>Unable to load</strong><span>{error}</span></div>;
  if (empty) return <div className="state"><strong>Nothing here yet</strong><span>Add accounts or refresh the server to populate this view.</span></div>;
  return null;
}

function formatDate(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function richText(text: string) {
  const parts = text.split(/(https?:\/\/\S+|@[A-Za-z0-9_]{1,15})/g);
  return parts.map((part, index) => part.startsWith('http')
    ? <a key={index} href={part} target="_blank" rel="noreferrer">{part}</a>
    : <span key={index}>{part}</span>);
}

function Media({ tweet }: { tweet: Tweet }) {
  if (tweet.videoURL) return <video className="media single" controls preload="metadata" poster={tweet.videoPosterURL ?? undefined} src={tweet.videoURL} />;
  if (!tweet.photoURLs.length) return null;
  return <div className={`media-grid count-${Math.min(tweet.photoURLs.length, 4)}`}>
    {tweet.photoURLs.slice(0, 4).map((url, index) => <a href={url} target="_blank" rel="noreferrer" key={url}><img src={url} alt={`Post attachment ${index + 1}`} loading="lazy" /></a>)}
  </div>;
}

function TweetCard({ tweet, detail = false }: { tweet: Tweet; detail?: boolean }) {
  const handle = (tweet.authorHandle ?? '').replace(/^@/, '');
  const body = <>
    {tweet.retweetedBy && <div className="context">Reposted by {tweet.retweetedBy}</div>}
    {tweet.isPinned && <div className="context">Pinned post</div>}
    <div className="tweet-head">
      <div className="avatar">{tweet.avatarURL ? <img src={tweet.avatarURL} alt="" /> : handle.slice(0, 1).toUpperCase()}</div>
      <div className="identity"><strong>{tweet.authorName || handle}</strong><span>@{handle}</span></div>
      <time>{formatDate(tweet.date)}</time>
    </div>
    {tweet.parent && <div className="parent"><strong>@{tweet.parent.authorHandle}</strong><span>{tweet.parent.text}</span></div>}
    <div className="tweet-text">{richText(tweet.text ?? '')}</div>
    {tweet.quotedText && <div className="quote"><strong>@{tweet.quotedHandle}</strong><span>{tweet.quotedText}</span></div>}
    <Media tweet={tweet} />
    <div className="metrics"><span>{tweet.replyCount} replies</span><span>{tweet.retweetCount} reposts</span><span>{tweet.likeCount} likes</span><span>{tweet.viewCount} views</span></div>
  </>;
  return <article className={`tweet ${detail ? 'detail' : ''}`}><div className="tweet-body">{body}{!detail && <Link className="thread-link" to={`/tweet/${handle}/${tweet.id}`}>Open conversation</Link>}</div></article>;
}

function Feed() {
  const feed = useLoad(api.feed);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    try { await api.refresh(); } catch { /* Feed reload still reports connectivity errors. */ }
    setTimeout(() => { feed.reload(); setRefreshing(false); }, 1200);
  };
  return <Page title="Latest" action={<button onClick={refresh} disabled={refreshing}>{refreshing ? 'Refreshing...' : 'Refresh'}</button>}>
    <State loading={feed.loading} error={feed.error} empty={!feed.data?.tweets.length} />
    <section className="stream">{feed.data?.tweets.map(tweet => <TweetCard tweet={tweet} key={tweet.id} />)}</section>
  </Page>;
}

function Timeline() {
  const { username = '' } = useParams();
  const timeline = useLoad(() => api.timeline(username), [username]);
  return <Page title={`@${username}`}><State loading={timeline.loading} error={timeline.error} empty={!timeline.data?.tweets.length} /><section className="stream">{timeline.data?.tweets.map(tweet => <TweetCard tweet={tweet} key={tweet.id} />)}</section></Page>;
}

function TweetDetail() {
  const { username = '', id = '' } = useParams();
  const detail = useLoad(() => api.tweet(username, id), [username, id]);
  return <Page title="Conversation"><State loading={detail.loading} error={detail.error} />{detail.data?.tweet && <TweetCard tweet={detail.data.tweet} detail />}<h2 className="section-title">Replies</h2><section className="stream replies">{detail.data?.replies.map(tweet => <TweetCard tweet={tweet} key={tweet.id} />)}</section></Page>;
}

function Accounts() {
  const accounts = useLoad(api.accounts);
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const add = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try { await api.addAccount(username); setUsername(''); accounts.reload(); } catch (error) { setError(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); }
  };
  const remove = async (account: Account) => {
    if (!confirm(`Stop following @${account.username}?`)) return;
    await api.removeAccount(account.username); accounts.reload();
  };
  const importCsv = async (file?: File) => {
    if (!file) return;
    setBusy(true); setError('');
    const names = (await file.text()).split(/[\n,]/).map(value => value.trim().replace(/^@/, '')).filter(value => /^[A-Za-z0-9_]{1,15}$/.test(value));
    for (const name of new Set(names)) await api.addAccount(name).catch(() => undefined);
    setBusy(false); accounts.reload();
  };
  return <Page title="Accounts" action={<span className="count">{accounts.data?.length ?? 0} followed</span>}>
    <form className="add-account" onSubmit={add}><label><span>Add a profile</span><div><span className="at">@</span><input value={username} onChange={event => setUsername(event.target.value)} placeholder="username" autoCapitalize="none" required /><button disabled={busy}>Add</button></div></label><label className="file-button">Import CSV<input type="file" accept=".csv,text/csv" onChange={event => void importCsv(event.target.files?.[0])} /></label></form>
    {error && <div className="inline-error">{error}</div>}<State loading={accounts.loading} error={accounts.error} empty={!accounts.data?.length} />
    <section className="account-list">{accounts.data?.map(account => <article className="account" key={account.username}><Link to={`/account/${account.username}`}><div className="avatar">{account.avatar_url ? <img src={account.avatar_url} alt="" /> : account.username[0].toUpperCase()}</div><div><strong>{account.display_name || account.username}</strong><span>@{account.username}</span>{account.fetch_error && <small>{account.fetch_error}</small>}</div></Link><button className="danger quiet" onClick={() => void remove(account)}>Remove</button></article>)}</section>
  </Page>;
}

function Settings() {
  const [server, setServer] = useState(localStorage.getItem('nitter.server') ?? '');
  const [key, setKey] = useState(localStorage.getItem('nitter.apiKey') ?? '');
  const [theme, setTheme] = useState<Theme>((localStorage.getItem('nitter.theme') as Theme) || 'system');
  const [message, setMessage] = useState('');
  const save = (event: FormEvent) => {
    event.preventDefault();
    localStorage.setItem('nitter.server', server.trim().replace(/\/$/, ''));
    localStorage.setItem('nitter.apiKey', key.trim());
    localStorage.setItem('nitter.theme', theme);
    document.documentElement.dataset.theme = theme;
    setMessage('Settings saved');
  };
  const test = async () => { setMessage('Testing...'); try { await api.health(); setMessage('Server is reachable'); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); } };
  return <Page title="Settings"><form className="settings" onSubmit={save}><label>Server URL<input type="url" value={server} onChange={event => setServer(event.target.value)} placeholder="Same origin" /></label><p>Leave blank when the web app is hosted by your Nitter server.</p><label>API key<input type="password" value={key} onChange={event => setKey(event.target.value)} autoComplete="off" /></label><label>Appearance<select value={theme} onChange={event => setTheme(event.target.value as Theme)}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label><div className="button-row"><button type="submit">Save</button><button type="button" className="secondary" onClick={() => void test()}>Test connection</button></div>{message && <output>{message}</output>}</form></Page>;
}

function App() {
  useEffect(() => { document.documentElement.dataset.theme = localStorage.getItem('nitter.theme') || 'system'; }, []);
  return <div className="app-shell"><aside><Link to="/" className="brand"><span>N</span><strong>Nitter</strong></Link><nav><NavLink to="/" end>Feed</NavLink><NavLink to="/accounts">Accounts</NavLink><NavLink to="/settings">Settings</NavLink></nav><p className="aside-note">A quiet reader for the loud web.</p></aside><div className="content"><Routes><Route path="/" element={<Feed />} /><Route path="/accounts" element={<Accounts />} /><Route path="/settings" element={<Settings />} /><Route path="/account/:username" element={<Timeline />} /><Route path="/tweet/:username/:id" element={<TweetDetail />} /><Route path="*" element={<Page title="Not found"><div className="state">This page does not exist.</div></Page>} /></Routes></div><nav className="mobile-nav"><NavLink to="/" end>Feed</NavLink><NavLink to="/accounts">Accounts</NavLink><NavLink to="/settings">Settings</NavLink></nav></div>;
}

export default App;
