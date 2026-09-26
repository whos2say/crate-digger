# Crate Digger

A visual-first record crate for DJ Brendan: covers first, everything else second. Dig by
crate, genre, era, label or search; flip a cover to read the sleeve back; build ordered
Top Tens with a public page built for screenshots; assemble working sets with a note per track.

Runs on Spacefast as one project: static Vite/React frontend, plus a Functions worker behind
`/api/*` and `/s/*` that proxies Discogs (keys stay server-side), caches aggressively in the
Space's database, and persists Top Tens and sets.

## Layout

```
server/      the worker: router, Discogs client + cache, lists, share page, owner gate
src/         React app: crate, artist wall, Top Tens, sets, record sheet
functions/   source-tree route shims (the published ones are generated into dist/ by the build)
scripts/     build.mjs (Vite + esbuild → dist/), deploy.mjs (pack + publish), dev-worker.mjs (local)
tests/       end-to-end tests of the bundled worker with SQLite and a fake Discogs
sf.jsonc     Spacefast config: Functions runtime with database + fetch
```

## Publish (first time)

```sh
npm install
npm run deploy          # builds, packs with the Spacefast CLI, publishes, prints a live URL + claim link
```

Claim the Space from the link it prints (or `npx sf login` first and it publishes into your
account). Then set the server variables — they only take effect on a claimed Space:

```sh
cp .env.server.example .env.server      # fill in DISCOGS_TOKEN and OWNER_KEY
npx sf env import .env.server --secret --space <space-id>
npm run deploy -- --space <space-id>    # variables apply when a new version finalizes
```

Why `npm run deploy` and not `sf publish dist`: the current CLI (0.4.1) compiles the worker
correctly but reports `fetch: false` in the artifact metadata even when `sf.jsonc` says
`fetch: true`. The deploy script restores `db`, `fetch` and `env` on the packed archive before
publishing. Outbound fetch to `api.discogs.com` also needs the Space to be claimed (unclaimed
Spaces only reach a trusted host list).

## Variables

| Name | Purpose |
| --- | --- |
| `DISCOGS_TOKEN` | Free personal token (discogs.com → Settings → Developers). Discogs only opens `/database/search` to authenticated apps, so genre / era / label / search browsing needs it. Release, master and artist lookups, the starter crate, and all Top Ten and set features work without it. |
| `OWNER_KEY` | Passphrase Brendan enters once in the app (top-right). Required for creating and editing lists. Until it is set, writes are open — fine for a first look, not for a public URL. |
| `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` | From an app at developer.spotify.com. Add `<APP_ORIGIN>/api/spotify/callback` as a redirect URI on that app. |
| `APP_ORIGIN` | The public origin, e.g. `https://crate-digger.view.fast`, used for the Spotify redirect. Defaults to the request origin. |

## Local development

```sh
node --experimental-sqlite scripts/dev-worker.mjs   # worker on :8788 with a SQLite env.DB, reads .env.local
npm run dev                                         # Vite on :5173, proxies /api and /s to the worker
npm test                                            # builds must exist: npm run build && npm test
```

## How it works

- Discogs calls go through `server/discogs.ts → cached()`: memory, then the `dg_cache` table
  (7 days for records, 24 h for searches), then Discogs. A 429 or network failure serves stale
  data instead of failing, and pauses new calls for 20 s.
- Cover images are proxied by `/api/image?u=` with 30-day cache headers and CORS, so the edge
  and the browser cache them and the "More covers like this" palette matching can read pixels.
- "More covers like this" extracts a hue/saturation/lightness signature per cover in the
  browser and ranks the current crate by distance. It is a visual match, not a musical one.
- Track previews use the YouTube videos Discogs lists for a release, matched to track titles.
  Spotify previews and Web Playback replace these when the connection lands.
- Top Ten share pages (`/s/<slug>`) are rendered on the server with `og:title`, `og:description`
  and the #1 cover as `og:image`, so iMessage, Slack and X show a real preview.
- Spacefast's Functions proxy drops `Set-Cookie`, so the owner key travels as an
  `x-crate-key` header; the browser keeps it in localStorage.

## Spotify

One account (Brendan's) is connected once and lives in the `kv` table; nothing Spotify-related
reaches the browser except a short-lived access token for the Web Playback SDK, and only when the
owner key is set in that browser.

- **Connect:** top-right → *Connect Spotify* (needs the owner key; it rides as `?key=` because
  that is a browser navigation). `GET /api/spotify/login` sends you to Spotify's consent screen
  (authorization code + PKCE, with the server secret), `GET /api/spotify/callback` stores tokens
  under `spotify:tokens` and returns you to the crate. Tokens refresh themselves.
- **Previews:** opening a record with Spotify connected matches each track
  (`GET /api/spotify/match?title&artist&album&duration`, cached a month) and lights up its play
  button. Free accounts get the 30-second preview; a Premium account plays the full track through
  the Web Playback SDK. Tracks with no Spotify match fall back to the YouTube video Discogs lists.
  Matched tracks show a green *via Spotify* tag and carry `spotifyUri` / `previewUrl`.
- **Export:** on a set, *Export to Spotify* (`POST /api/playlists/:id/export`) creates a private
  playlist on the connected account and writes `spotifyPlaylistId` back; re-exporting updates that
  playlist in place. Tracks Spotify does not have are listed rather than silently dropped.
- **Disconnect:** `POST /api/spotify/disconnect` (owner only) forgets the account.

Identity still keys off `OWNER_KEY`; tying it to the connected Spotify account would need a
session the Functions proxy cannot carry (it drops `Set-Cookie`).

## Deferred on purpose

No social features, no mobile app, no photo identification. The loop is crate → curate → share.
