# Nitter iOS App

An iOS client for reading Twitter/X timelines through Nitter, with a companion Node.js server that handles anti-bot bypass, feed aggregation, and media proxying.

## How It Works

Twitter/X content is accessed through public Nitter instances (xcancel.com, nitter.poast.org). These instances enforce a JavaScript anti-bot challenge that blocks plain HTTP clients and all headless browsers. The companion server solves this by launching a real system Chrome browser via Chrome DevTools Protocol, then uses Playwright to interact with it.

The server fetches timelines, stores tweets in SQLite, and serves a REST API. The iOS app consumes this API for a clean, native reading experience.

## Project Structure

```
ios/          Xcode project (iOS 17+, SwiftUI, Swift 6)
server/       Node.js server (TypeScript, Express, Playwright, Chromium)
```

## iOS App

- **Feed** — Merged, deduplicated timeline from all watched accounts with pull-to-refresh
- **Accounts** — Add/remove Twitter handles, CSV import, automatic background fetching
- **Settings** — Server URL, API key, System/Light/Dark appearance toggle
- **Tweet Detail** — Full tweet view with reply chain, parent context, in-app navigation
- **Media** — Photo grid (single full-width, multi two-column), video playback via native AVPlayer
- **Links** — Clickable URLs detected and rendered inline in tweet text

### Build

Requires Xcode 16+ and macOS. Uses [XcodeGen](https://github.com/yonaskolb/XcodeGen) — regenerate the Xcode project from `ios/project.yml` after any file changes.

```bash
cd ios
xcodegen generate
open Nitter.xcodeproj
```

## Server

### Production Deployment (Docker Compose)

The release Compose file pulls the published image from GitHub Container Registry instead of building it locally. Docker Compose reads deployment settings from `server/.env`.

```bash
cd server
cp .env.example .env
openssl rand -hex 32
openssl rand -hex 32
```

Put the two generated values in `.env` as `API_KEY` and `PROXY_SECRET`. They must be different and remain stable across upgrades. Enter `API_KEY` in the iOS app's Settings tab. Do not commit `.env`.

Set `NITTER_VERSION` to a released version such as `1.0.1` for reproducible deployments, or leave it as `latest` to track the newest release. If the GHCR package is private, authenticate using a GitHub personal access token with `read:packages`:

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io --username YOUR_GITHUB_USERNAME --password-stdin
```

Pull and start the service:

```bash
docker compose -f docker-compose.release.yml pull
docker compose -f docker-compose.release.yml up -d
docker compose -f docker-compose.release.yml logs -f
```

The server is available at `http://localhost:3000` by default. Set `HOST_PORT` in `.env` to expose a different host port. For internet-facing deployments, place it behind an HTTPS reverse proxy and do not expose port 3000 directly.

For Caddy, a basic site block is sufficient. Caddy supplies the forwarded host and HTTPS protocol that the server uses to generate signed media URLs:

```caddyfile
nitter.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

#### Persistent Data

The release Compose file uses the explicitly named Docker volume `nitter-ios-app-data`, mounted at `/app/data`. Container recreation and image upgrades preserve:

- `nitter.db` — accounts, tweets, cursors, and timeline membership
- `images/` — cached image data
- `proxy-secret` — fallback media signing secret

On the first start after upgrading from an older release, the server automatically renames the legacy `xcancel.db` database and its SQLite sidecar files to `nitter.db` before opening it.

The renamed iOS target intentionally retains its original bundle identifier so installing Nitter upgrades the existing app and preserves its settings and local data.

Inspect the volume with:

```bash
docker volume inspect nitter-ios-app-data
```

Back it up before upgrades:

```bash
docker run --rm \
  -v nitter-ios-app-data:/data:ro \
  -v "$PWD":/backup \
  alpine tar czf /backup/nitter-ios-app-data.tar.gz -C /data .
```

#### Upgrades

Update `NITTER_VERSION` in `.env`, then recreate the service using the new image:

```bash
docker compose -f docker-compose.release.yml pull
docker compose -f docker-compose.release.yml up -d --remove-orphans
docker image prune -f
```

To stop the service without deleting persistent data:

```bash
docker compose -f docker-compose.release.yml down
```

Do not pass `--volumes` to `docker compose down` unless you intend to delete the database and media cache.

### Local Docker Build

Use the development Compose file to build the server from the current checkout:

```bash
cd server
cp .env.example .env
docker compose up --build -d --remove-orphans
```

### Local Development (macOS)

Requires Node.js 20+ and Chromium installed (via `npx playwright install chromium`).

```bash
cd server
npm install
cp .env.example .env
# Edit .env and set API_KEY

npm run dev
```

### API Key

The server uses bearer token authentication. Set `API_KEY` in `.env` and enter the same value in the iOS app's Settings tab. The one exception is the media proxy (`/api/proxy`), which uses signed HMAC URLs instead.

Set `ALLOW_INSECURE_NO_AUTH=true` only for isolated local testing.

### Configuration

| Variable | Default | Description |
|---|---|---|
| `API_KEY` | *(required)* | Bearer token for API authentication |
| `PROXY_SECRET` | *(required by release Compose)* | Stable HMAC signing key for media URLs |
| `ALLOW_INSECURE_NO_AUTH` | `false` | Disable auth for local testing |
| `NITTER_BASE_URL` | `https://nitter.poast.org` | Nitter instance used for timelines and media |
| `FETCH_MINUTES` | `15` | Minutes between automatic fetch cycles |
| `MAX_ACCOUNTS_PER_CYCLE` | `40` | Max accounts fetched per automatic cycle |
| `FETCH_CONCURRENCY` | `2` | Simultaneous fetch requests |
| `FETCH_START_INTERVAL_MS` | `1000` | Delay between starting each fetch |
| `MAX_PAGES_PER_ACCOUNT` | `5` | Pages to follow per account for backfill |
| `INCLUDE_REPLIES` | `true` | Include replies in timeline |
| `MAX_PARENT_ENRICHMENTS` | `20` | Parent context fetches per cycle |

The release Compose file also accepts `NITTER_VERSION` (`latest`) and `HOST_PORT` (`3000`) for image selection and host port mapping. Existing `XCANCEL_VERSION` values remain supported during migration, but new deployments should use `NITTER_VERSION`. `PORT`, `DATA_DIR`, `CHROME_PATH`, and `NODE_ENV` are configured inside the image and should not be overridden.

### API Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/feed` | Bearer | Merged feed from all accounts (limit up to 1000) |
| `GET` | `/api/accounts` | Bearer | List all watched accounts |
| `POST` | `/api/accounts` | Bearer | Add accounts (`{ handles: ["handle1", "handle2"] }`) |
| `DELETE` | `/api/accounts/:handle` | Bearer | Remove an account |
| `GET` | `/api/tweets/:id` | Bearer | Tweet detail with replies |
| `POST` | `/api/fetch` | Bearer | Trigger an immediate fetch cycle |
| `GET` | `/api/status` | — | Server status |
| `GET` | `/api/proxy` | Signed URL | Proxy images and video |

### Data

Persistent data is stored in a Docker volume at `/app/data/`:
- `nitter.db` — SQLite database (tweets, accounts, timeline membership)
- `images/` — Cached media files (512 MB limit, 7-day expiry)
- `proxy-secret` — Auto-generated HMAC key (persists across restarts)

## How It Works (Details)

### Anti-Bot Bypass

All headless browsers (Puppeteer stealth, Playwright, etc.) are detected by BotD fingerprinting. The server launches a real system Chrome with `--remote-debugging-port`, connects via Playwright's `connectOverCDP`, and solves the challenge once at startup. Subsequent requests use the browser's HTTP context directly.

On macOS, Chrome runs with the native display. On Linux/Docker, `xvfb` provides a virtual display.

### Feed Scheduling

Accounts are prioritized by activity: new > active (24h) > warm (7d) > dormant (7d+). Each account tracks its own cursor position for pagination. The observation-based retention window keeps tweets for 7 days.

### Retweet Attribution

Nitter multi-user pages only show the retweeter's display name, not their handle. The server resolves this by fetching individual account pages and joining via a `tweet_timelines` table, enabling per-account retweet attribution.

### Media Proxy

Nitter's `/pic/` URLs return 503 to plain clients. The server proxies all media through the browser context with signed HMAC URLs (stable for ~24 hours). The iOS app uses `CachedAsyncImage` with request coalescing for efficient loading.

Video content is proxied with HTTP range support for seeking, and played natively via AVPlayer.

## CI/CD

Pull requests into `main` run the GitHub Actions CI workflow:

- Type-check and test the Node.js server
- Build the server Docker image
- Generate the Xcode project, build the iOS app, and run its unit tests in a simulator
- Upload the iOS `.xcresult` bundle for troubleshooting

Pushes to `main` verify the server and then run [semantic-release](https://semantic-release.gitbook.io/). Releases follow Conventional Commits:

| Commit | Release |
|---|---|
| `fix: correct media URL parsing` | Patch (`1.0.1`) |
| `feat: add account groups` | Minor (`1.1.0`) |
| `feat!: replace the API format` | Major (`2.0.0`) |
| `docs:`, `test:`, `ci:`, `chore:` | No release |

Each release creates a Git tag and GitHub release, then publishes multi-architecture (`linux/amd64` and `linux/arm64`) images to GitHub Container Registry:

```bash
docker pull ghcr.io/smmc-developments/nitter-ios-app:latest
```

Images are tagged with the full version, minor version, major version, and `latest`, for example `1.2.3`, `1.2`, `1`, and `latest`.

## License

Licensed under the [MIT License](LICENSE).
