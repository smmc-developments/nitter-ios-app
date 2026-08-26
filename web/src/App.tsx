import { FormEvent, PointerEvent as ReactPointerEvent, ReactNode, useEffect, useRef, useState } from 'react';
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

function Lightbox({ images, index, onClose }: { images: string[]; index: number; onClose: () => void }) {
  const [current, setCurrent] = useState(index);
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef(view);
  const drag = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);
  const moved = useRef(0);

  const applyView = (next: { zoom: number; x: number; y: number }) => { viewRef.current = next; setView(next); };

  const clampOffset = (zoom: number, x: number, y: number) => {
    if (zoom <= 1) return { x: 0, y: 0 };
    const halfX = (window.innerWidth * (zoom - 1)) / 2;
    const halfY = (window.innerHeight * (zoom - 1)) / 2;
    return { x: Math.max(-halfX, Math.min(halfX, x)), y: Math.max(-halfY, Math.min(halfY, y)) };
  };
  const clamp = (x: number, y: number) => clampOffset(viewRef.current.zoom, x, y);

  const step = (delta: number) => {
    setCurrent(previous => {
      const next = (previous + delta + images.length) % images.length;
      if (next !== previous) applyView({ zoom: 1, x: 0, y: 0 });
      return next;
    });
  };

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, []);

  useEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
      const { zoom, x, y } = viewRef.current;
      const next = Math.max(1, Math.min(6, zoom * factor));
      if (next === zoom) return;
      const ratio = next / zoom;
      applyView({ zoom: next, x: next <= 1 ? 0 : x * ratio, y: next <= 1 ? 0 : y * ratio });
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      else if (event.key === 'ArrowLeft') step(-1);
      else if (event.key === 'ArrowRight') step(1);
      else if (event.key === '+' || event.key === '=') applyView({ zoom: Math.min(6, viewRef.current.zoom * 1.25), x: 0, y: 0 });
      else if (event.key === '-') applyView({ zoom: Math.max(1, viewRef.current.zoom / 1.25), x: 0, y: 0 });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]); // eslint-disable-line react-hooks/exhaustive-deps

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; cx: number; cy: number; zoom: number; x: number; y: number } | null>(null);
  const pinched = useRef(false);

  const onPointerDown = (event: ReactPointerEvent<HTMLImageElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    moved.current = 0;
    pinched.current = false;
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = {
        distance: Math.hypot(a.x - b.x, a.y - b.y),
        cx: (a.x + b.x) / 2,
        cy: (a.y + b.y) / 2,
        ...viewRef.current,
      };
      drag.current = null;
      setDragging(true);
    } else if (viewRef.current.zoom > 1) {
      drag.current = { px: event.clientX, py: event.clientY, ox: viewRef.current.x, oy: viewRef.current.y };
    }
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLImageElement>) => {
    const pointer = pointers.current.get(event.pointerId);
    if (!pointer) return;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    if (pointers.current.size === 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (Math.abs(distance - pinch.current.distance) > 8) pinched.current = true;
      const ratio = distance / pinch.current.distance;
      const next = Math.max(1, Math.min(6, pinch.current.zoom * ratio));
      const focalX = (a.x + b.x) / 2 - window.innerWidth / 2;
      const focalY = (a.y + b.y) / 2 - window.innerHeight / 2;
      const x = focalX * (1 - ratio) + pinch.current.x * ratio;
      const y = focalY * (1 - ratio) + pinch.current.y * ratio;
      const clamped = clampOffset(next, x, y);
      applyView({ zoom: next, x: clamped.x, y: clamped.y });
    } else if (drag.current && pointers.current.size === 1) {
      const dx = event.clientX - drag.current.px;
      const dy = event.clientY - drag.current.py;
      moved.current = Math.max(moved.current, Math.hypot(dx, dy));
      const clamped = clamp(drag.current.ox + dx, drag.current.oy + dy);
      applyView({ ...viewRef.current, x: clamped.x, y: clamped.y });
    }
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLImageElement>) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) { drag.current = null; setDragging(false); }
  };
  const onImageClick = () => {
    if (pinched.current) { pinched.current = false; return; }
    if (moved.current > 6) { moved.current = 0; return; }
    applyView(viewRef.current.zoom > 1 ? { zoom: 1, x: 0, y: 0 } : { zoom: 2.5, x: 0, y: 0 });
  };

  return <div className="lightbox" ref={rootRef} data-dragging={dragging} role="dialog" aria-modal="true" aria-label="Image preview" onClick={onClose}>
    <button type="button" className="lightbox-close" onClick={event => { event.stopPropagation(); onClose(); }} aria-label="Close preview">×</button>
    {images.length > 1 && <>
      <button type="button" className="lightbox-nav prev" onClick={event => { event.stopPropagation(); step(-1); }} aria-label="Previous image">‹</button>
      <button type="button" className="lightbox-nav next" onClick={event => { event.stopPropagation(); step(1); }} aria-label="Next image">›</button>
    </>}
    <div className="lightbox-stage" onClick={event => event.stopPropagation()}>
      <img src={images[current]} alt={`Post attachment ${current + 1} of ${images.length}`} draggable={false}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
        onClick={onImageClick} style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }} />
    </div>
    {images.length > 1 && <div className="lightbox-counter">{current + 1} / {images.length}</div>}
    <div className="lightbox-hint">{view.zoom > 1 ? 'Drag to pan · pinch or scroll to zoom' : 'Click, pinch or scroll to zoom'}</div>
  </div>;
}

function Media({ tweet }: { tweet: Tweet }) {
  const [preview, setPreview] = useState<{ images: string[]; index: number } | null>(null);
  if (tweet.videoURL) return <video className="media single" controls preload="metadata" poster={tweet.videoPosterURL ?? undefined} src={tweet.videoURL} />;
  if (!tweet.photoURLs.length) return null;
  const photos = tweet.photoURLs.slice(0, 4);
  return <>
    <div className={`media-grid count-${photos.length}`}>
      {photos.map((url, index) => <button type="button" className="media-thumb" onClick={() => setPreview({ images: photos, index })} key={url}><img src={url} alt={`Post attachment ${index + 1}`} loading="lazy" /></button>)}
    </div>
    {preview && <Lightbox images={preview.images} index={preview.index} onClose={() => setPreview(null)} />}
  </>;
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
