# Crate Digger

A visual-first record crate for DJ Brendan: covers and faces first, everything else second.
Dig by crate, genre, era, label or search; find an artist by their photo and land on a wall of
their records with their top tracks ready to play; build ordered Top Tens that become real
Spotify playlists, each with a public page built for screenshots; assemble working sets with a
note per track.

**Spotify is the catalogue.** Browsing uses an app-only token, so anyone with the URL can dig.
Playback (full tracks, Spotify Premium) and playlist export use Brendan's connected account.
**Discogs is optional:** with a token set, any record gets a "Read the sleeve" button that pulls
the label, catalogue number, pressing format and notes from Discogs on demand.

Runs on Spacefast as one project: static Vite/React frontend, plus a Functions worker behind
`/api/*` and `/s/*` that keeps every key server-side, caches in the Space's database, and
persists Top Tens and sets.

## Layout

```
server/      the worker: router, Spotify catalogue + auth, Discogs sleeve lookup, lists, share page, owner gate
src/         React app: crate, artist wall, Top Tens, sets, record sheet, global player
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
| `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` | **Required.** The catalogue, artist walls and search all read Spotify with an app token. From an app at developer.spotify.com; add `<APP_ORIGIN>/api/spotify/callback` as a redirect URI and add Brendan's Spotify account under the app's User Management (dev-mode apps only serve listed users). |
| `APP_ORIGIN` | The public origin, e.g. `https://crate-digger.view.fast`, used for the Spotify redirect. Defaults to the request origin. |
| `DISCOGS_TOKEN` | Optional. Turns on the "Read the sleeve" panel. Free personal token from discogs.com → Settings → Developers. |
| `OWNER_KEY` | Passphrase Brendan enters once in the app (top-right). Required for creating and editing lists. Until it is set, writes are open — fine for a first look, not for a public URL. |


## Local development

```sh
node --experimental-sqlite scripts/dev-worker.mjs   # worker on :8788 with a SQLite env.DB, reads .env.local
npm run dev                                         # Vite on :5173, proxies /api and /s to the worker
npm test                                            # builds must exist: npm run build && npm test
```

## How it works

- Catalogue reads (`server/catalog.ts`) go through one cached `get()`: memory, then the
  `dg_cache` table (24 h), then Spotify with a client-credentials token that refreshes itself. A
  429 serves stale data when there is any and otherwise returns `Retry-After`, which the views
  turn into an automatic retry with a countdown.
- Crates are Spotify searches (`genre:"deep house" year:1990-1999`); the genre and decade chips
  combine. Text search returns artists (with photos) above the albums.
- Covers load straight from Spotify's CDN in the browser. `/api/image` remains for canvas pixel
  reads ("More covers like this") and as a fallback.
- An artist page is a wall: portrait, genres, top tracks (play / + top ten / + set), then the
  discography in release order.
- Playback: one player for the app (`src/components/Player.tsx`). With the connected account on
  Premium and the owner key set in the browser, ▶ plays the full track through the Web Playback
  SDK; otherwise ▶ opens the track in Spotify.
- Top Ten items are `{ record, track? }`. Adding from a tracklist or top-tracks picks the track;
  adding a cover picks the album, and export uses its first track. Rows saved before this change
  (bare records) still read fine.
- Share pages (`/s/<slug>`) render on the server with `og:title`, `og:description`, the #1
  cover as `og:image`, and a *Listen on Spotify* link once the list is exported.
- Spacefast's Functions proxy drops `Set-Cookie`, so the owner key travels as an
  `x-crate-key` header (or `?key=` on the one browser navigation, the Spotify connect link).

## Spotify

One account (Brendan's) is connected once and lives in the `kv` table; nothing Spotify-related
reaches the browser except a short-lived access token for the Web Playback SDK, and only when the
owner key is set in that browser.

- **Connect:** top-right → *Connect Spotify* (needs the owner key; it rides as `?key=` because
  that is a browser navigation). `GET /api/spotify/login` sends you to Spotify's consent screen
  (authorization code + PKCE, with the server secret), `GET /api/spotify/callback` stores tokens
  under `spotify:tokens` and returns you to the crate. Tokens refresh themselves.
- **Playback:** every track in the catalogue carries its `spotifyUri`, so ▶ plays it in full
  through the Web Playback SDK when the connected account is Premium and the crate is unlocked.
  (Spotify no longer issues 30-second preview URLs to new apps, so there is no preview lane.)
- **Export:** *Export to Spotify* on a Top Ten (`POST /api/toptens/:id/export`) or a set
  (`POST /api/playlists/:id/export`) creates a private playlist on the connected account and
  writes `spotifyPlaylistId` back; re-exporting updates that playlist in place. Tracks without a
  URI (legacy Discogs items) are matched by title and artist, and anything Spotify does not have
  is listed rather than silently dropped.
- **Disconnect:** `POST /api/spotify/disconnect` (owner only) forgets the account.

Identity still keys off `OWNER_KEY`; tying it to the connected Spotify account would need a
session the Functions proxy cannot carry (it drops `Set-Cookie`).

## Deferred on purpose

No social features, no mobile app, no photo identification. The loop is crate → curate → share.
