// The catalogue: everything the crate browses comes from Spotify. Reads use an app-only token
// (client credentials), so browsing works for anyone who opens the URL; only playback and playlist
// writes need Brendan's connected account (see spotify.ts).

import { kvGet, kvSet, type D1Like } from "./db";
import { SpotifyError, type SpotifyEnv } from "./spotify";
import type { ArtistCard, ArtistDetail, Crate, Record, RecordDetail, Track } from "./types";

const API = "https://api.spotify.com/v1";
const MARKET = "US";
const CACHE_FRESH_MS = 24 * 3600 * 1000;

// ---------- app token ----------

let appToken: { token: string; expiresAt: number } | null = null;

export async function appAccessToken(db: D1Like | null, env: SpotifyEnv): Promise<string> {
  if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) throw new SpotifyError("Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET on the Space to browse.", 501);
  if (appToken && Date.now() < appToken.expiresAt - 60_000) return appToken.token;
  if (db) {
    const raw = await kvGet(db, "spotify:app-token").catch(() => null);
    if (raw) { const t = JSON.parse(raw) as { token: string; expiresAt: number }; if (Date.now() < t.expiresAt - 60_000) { appToken = t; return t.token; } }
  }
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { Authorization: `Basic ${btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new SpotifyError(`Spotify would not issue an app token (${res.status}). Check the client id and secret.`, 502);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  appToken = { token: j.access_token, expiresAt: Date.now() + j.expires_in * 1000 };
  if (db) await kvSet(db, "spotify:app-token", JSON.stringify(appToken)).catch(() => {});
  return appToken.token;
}

// ---------- cached GET ----------

const memory = new Map<string, { body: unknown; at: number }>();
const inflight = new Map<string, Promise<unknown>>();

async function get<T>(db: D1Like | null, env: SpotifyEnv, path: string, freshMs = CACHE_FRESH_MS): Promise<T> {
  const key = "sp:" + path;
  const hit = memory.get(key);
  if (hit && Date.now() - hit.at < freshMs) return hit.body as T;
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;
  const p = (async () => {
    if (db && !hit) {
      const { results } = await db.prepare(`SELECT body, fetched_at FROM dg_cache WHERE k = ?`).bind(key).all<{ body: string; fetched_at: number }>().catch(() => ({ results: [] as { body: string; fetched_at: number }[] }));
      if (results[0] && Date.now() - Number(results[0].fetched_at) < freshMs) { const body = JSON.parse(results[0].body); memory.set(key, { body, at: Number(results[0].fetched_at) }); return body as T; }
    }
    const token = await appAccessToken(db, env);
    const res = await fetch(API + path, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 429) {
      if (hit) return hit.body as T;
      const wait = Number(res.headers.get("Retry-After") ?? 5);
      throw new SpotifyError(`Spotify is rate limiting us. Retrying in ${wait}s.`, 429, wait * 1000);
    }
    if (res.status === 404) throw new SpotifyError("Spotify has nothing at that id.", 404);
    if (!res.ok) {
      if (hit) return hit.body as T;
      let detail = "";
      try { detail = ((await res.json()) as { error?: { message?: string } }).error?.message ?? ""; } catch { /* no body */ }
      throw new SpotifyError(`Spotify answered ${res.status}${detail ? `: ${detail}` : "."} [${path.slice(0, 180)}]`, 502);
    }
    const text = await res.text();
    const body = JSON.parse(text);
    memory.set(key, { body, at: Date.now() });
    if (db) await db.prepare(`REPLACE INTO dg_cache (k, status, body, fetched_at) VALUES (?, ?, ?, ?)`).bind(key, 200, text, Date.now()).run().catch(() => {});
    return body as T;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ---------- shapes ----------

type SpImage = { url: string; width?: number; height?: number };
type SpArtistLite = { id: string; name: string; external_urls?: { spotify?: string } };
type SpArtist = SpArtistLite & { images?: SpImage[]; genres?: string[]; followers?: { total: number }; popularity?: number };
type SpAlbum = {
  id: string; name: string; album_type: "album" | "single" | "compilation"; release_date?: string; release_date_precision?: string;
  images?: SpImage[]; artists: SpArtistLite[]; label?: string; genres?: string[]; total_tracks?: number; external_urls: { spotify: string }; album_group?: string;
  tracks?: { items: SpTrack[] };
};
type SpTrack = { id: string; uri: string; name: string; duration_ms: number; track_number: number; disc_number?: number; explicit?: boolean; artists: SpArtistLite[]; external_urls: { spotify: string }; album?: SpAlbum; popularity?: number };

const pick = (images?: SpImage[], want = 640): string | undefined => {
  if (!images?.length) return undefined;
  const sorted = [...images].sort((a, b) => Math.abs((a.width ?? 0) - want) - Math.abs((b.width ?? 0) - want));
  return sorted[0]?.url;
};
const year = (a: SpAlbum): number | undefined => (a.release_date ? Number(a.release_date.slice(0, 4)) || undefined : undefined);
const ms = (n: number) => `${Math.floor(n / 60000)}:${String(Math.floor((n % 60000) / 1000)).padStart(2, "0")}`;

export function albumToRecord(a: SpAlbum): Record {
  return {
    id: `sp:album:${a.id}`,
    source: "spotify",
    title: a.name,
    artist: a.artists.map((x) => x.name).join(", "),
    artistId: a.artists[0]?.id,
    year: year(a),
    label: a.label || undefined,
    genres: a.genres ?? [],
    styles: [],
    cover: pick(a.images, 640) ?? "",
    thumb: pick(a.images, 300) ?? pick(a.images, 640) ?? "",
    url: a.external_urls.spotify,
    kind: a.album_type,
  };
}

export function trackToTrack(t: SpTrack): Track {
  return {
    position: `${t.disc_number && t.disc_number > 1 ? `${t.disc_number}-` : ""}${t.track_number}`,
    title: t.name,
    duration: ms(t.duration_ms),
    spotifyUri: t.uri,
    spotifyUrl: t.external_urls.spotify,
    artist: t.artists.map((x) => x.name).join(", "),
  };
}

export function artistToCard(a: SpArtist): ArtistCard {
  return {
    id: a.id,
    name: a.name,
    image: pick(a.images, 640),
    thumb: pick(a.images, 320) ?? pick(a.images, 640),
    genres: a.genres ?? [],
    followers: a.followers?.total,
    url: a.external_urls?.spotify ?? `https://open.spotify.com/artist/${a.id}`,
  };
}

// ---------- crates ----------

export const CRATES: { key: string; label: string; q: string }[] = [
  { key: "classic-rock", label: "Classic rock", q: `genre:"classic rock"` },
  { key: "broadway", label: "Broadway musicals", q: `genre:broadway` },
  { key: "disney", label: "Disney songs", q: `genre:disney` },
  { key: "show-tunes", label: "Show tunes", q: `genre:"show tunes"` },
  { key: "deep-house-90s", label: "Deep house, nineties", q: `genre:"deep house" year:1990-1999` },
  { key: "disco", label: "Disco twelves", q: `genre:disco year:1976-1983` },
  { key: "detroit", label: "Detroit", q: `genre:"detroit techno"` },
  { key: "jazz-funk", label: "Jazz-funk", q: `genre:"jazz funk" year:1970-1979` },
  { key: "balearic", label: "Balearic and ambient", q: `genre:balearic` },
  { key: "uk-garage", label: "UK garage", q: `genre:"uk garage" year:1996-2002` },
  { key: "bossa", label: "Bossa and MPB", q: `genre:"bossa nova" year:1960-1975` },
  { key: "dub", label: "Dub", q: `genre:dub year:1972-1982` },
  { key: "afrobeat", label: "Afrobeat", q: `genre:afrobeat` },
  { key: "boogie", label: "Boogie", q: `genre:boogie year:1979-1986` },
];
export const GENRES = ["Classic Rock", "Broadway", "Show Tunes", "Disney", "Soundtrack", "Rock", "Pop", "Soul", "Funk", "Disco", "Jazz", "Blues", "Country", "Reggae", "Hip Hop", "House", "Deep House", "Techno", "Ambient", "Bossa Nova"];
export const DECADES = ["1960s", "1970s", "1980s", "1990s", "2000s", "2010s", "2020s"];

export function decadeRange(decade: string): string | undefined {
  const m = decade.match(/^(\d{4})s$/);
  if (!m) return undefined;
  const y = Number(m[1]);
  return `${y}-${y + 9}`;
}

export function crateDefinitions(): { key: string; label: string }[] {
  return CRATES.map(({ key, label }) => ({ key, label }));
}

// ---------- search ----------

export interface SearchParams { q?: string; genre?: string; year?: string; label?: string; page?: number }

function buildQuery(p: SearchParams): string {
  const parts: string[] = [];
  if (p.q) parts.push(p.q);
  if (p.genre) parts.push(`genre:"${p.genre.toLowerCase()}"`);
  if (p.year) parts.push(`year:${p.year}`);
  if (p.label) parts.push(`label:"${p.label}"`);
  return parts.join(" ");
}

function normalizeName(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/^the\s+/, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function dedupeAlbums(albums: SpAlbum[]): SpAlbum[] {
  const seen = new Set<string>();
  const out: SpAlbum[] = [];
  for (const a of albums) {
    if (!a.images?.length) continue;
    const key = `${a.artists[0]?.id}|${a.name.toLowerCase().replace(/\s*\(.*?\)\s*/g, "")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

const PAGE = 20;
// Spotify's /search endpoint now rejects limit=50 with "Invalid limit"; the safe max here is 20.
const TRACK_PAGE = 20;

// Spotify's `genre:` filter only applies to track and artist searches, never albums. So any
// genre browse searches tracks and builds the crate from the albums those tracks sit on: one
// call, and it surfaces the records people actually play.
function albumsFromTracks(tracks: SpTrack[]): SpAlbum[] {
  const out: SpAlbum[] = [];
  for (const t of tracks) {
    if (!t.album?.images?.length) continue;
    out.push({ ...t.album, artists: t.album.artists?.length ? t.album.artists : t.artists });
  }
  return dedupeAlbums(out);
}

async function trackSearch(db: D1Like | null, env: SpotifyEnv, q: string, page: number, limit = TRACK_PAGE): Promise<{ albums: SpAlbum[]; total: number }> {
  const qs = new URLSearchParams({ q, type: "track", limit: String(limit), offset: String((page - 1) * limit), market: MARKET });
  const data = await get<{ tracks: { items: SpTrack[]; total: number } }>(db, env, `/search?${qs}`);
  return { albums: albumsFromTracks(data.tracks?.items ?? []), total: data.tracks?.total ?? 0 };
}

// A bare decade browse (no genre, no text) fans out across broad genres and merges what comes back.
const FANOUT_GENRES = ["classic rock", "broadway", "disney", "show tunes", "soul", "funk", "disco", "jazz", "pop", "rock"];

async function fanOut(db: D1Like | null, env: SpotifyEnv, p: SearchParams): Promise<{ records: Record[]; artists: ArtistCard[]; page: number; pages: number }> {
  const results = await Promise.all(FANOUT_GENRES.map(async (g) => {
    try { return (await trackSearch(db, env, buildQuery({ ...p, genre: g }), 1, 30)).albums; } catch { return [] as SpAlbum[]; }
  }));
  // Interleave so one genre does not dominate the top of the crate.
  const merged: SpAlbum[] = [];
  for (let i = 0; i < 20; i++) for (const r of results) if (r[i]) merged.push(r[i]);
  const albums = dedupeAlbums(merged);
  if (!albums.length && results.every((r) => !r.length)) throw new SpotifyError("Spotify found nothing for that.", 404);
  return { records: albums.slice(0, 80).map(albumToRecord), artists: [], page: 1, pages: 1 };
}

export async function search(db: D1Like | null, env: SpotifyEnv, p: SearchParams): Promise<{ records: Record[]; artists: ArtistCard[]; page: number; pages: number }> {
  const q = buildQuery(p);
  if (!q) throw new SpotifyError("Give me something to dig for.", 400);
  const page = Math.max(1, p.page ?? 1);
  if (p.genre) {
    // Genre (with optional text / year): track search, crate built from the tracks' albums.
    const r = await trackSearch(db, env, q, page);
    return { records: r.albums.map(albumToRecord), artists: [], page, pages: Math.max(1, Math.min(20, Math.ceil(r.total / TRACK_PAGE))) };
  }
  if (!p.q && !p.label) return fanOut(db, env, p);
  if (p.label && !p.q) {
    // `label:` is an album filter Spotify honours but does not document; fall back to plain text.
    try { return await albumSearch(db, env, q, page, false); }
    catch (e) { if (e instanceof SpotifyError && e.status === 502) return albumSearch(db, env, `${p.label}${p.year ? ` year:${p.year}` : ""}`, page, false); throw e; }
  }
  return albumSearch(db, env, q, page, page === 1, p.q);
}

async function albumSearch(db: D1Like | null, env: SpotifyEnv, q: string, page: number, withArtists: boolean, typed?: string): Promise<{ records: Record[]; artists: ArtistCard[]; page: number; pages: number }> {
  const types = withArtists ? "album,artist" : "album";
  const qs = new URLSearchParams({ q, type: types, limit: String(PAGE), offset: String((page - 1) * PAGE), market: MARKET });
  const data = await get<{ albums?: { items: SpAlbum[]; total: number }; artists?: { items: SpArtist[] } }>(db, env, `/search?${qs}`);
  let albums = dedupeAlbums(data.albums?.items ?? []);
  const artistItems = (data.artists?.items ?? []).filter((a) => a.images?.length);
  // Typed an artist's name? Put that artist first and lead the crate with their own records,
  // not just albums whose titles happen to contain the words.
  const wanted = normalizeName(typed ?? "");
  const exactIdx = wanted ? artistItems.findIndex((a) => normalizeName(a.name) === wanted) : -1;
  if (exactIdx > 0) artistItems.unshift(...artistItems.splice(exactIdx, 1));
  if (exactIdx >= 0 && page === 1) {
    try {
      const own = await get<{ items: SpAlbum[] }>(db, env, `/artists/${artistItems[0].id}/albums?include_groups=album,single,compilation&market=${MARKET}&limit=50`);
      const theirs = dedupeAlbums(own.items).sort((a, b) => (year(b) ?? 0) - (year(a) ?? 0));
      albums = dedupeAlbums([...theirs, ...albums]);
    } catch { /* fall back to the plain search */ }
  }
  const artists = artistItems.slice(0, 8).map((a, i) => ({ ...artistToCard(a), exact: i === 0 && exactIdx >= 0 }));
  const total = data.albums?.total ?? albums.length;
  return { records: albums.map(albumToRecord), artists, page, pages: Math.max(1, Math.min(25, Math.ceil(total / PAGE))) };
}

export async function crate(db: D1Like | null, env: SpotifyEnv, key: string, page = 1): Promise<Crate & { pages: number }> {
  const def = CRATES.find((c) => c.key === key);
  if (!def) throw new SpotifyError("No such crate.", 404);
  const r = await trackSearch(db, env, def.q, page);
  return { key, label: def.label, records: r.albums.map(albumToRecord), pages: Math.max(1, Math.min(20, Math.ceil(r.total / TRACK_PAGE))) };
}

// ---------- artists ----------

export async function getArtist(db: D1Like | null, env: SpotifyEnv, id: string): Promise<ArtistDetail> {
  const [artist, top, albums] = await Promise.all([
    get<SpArtist>(db, env, `/artists/${id}`),
    get<{ tracks: SpTrack[] }>(db, env, `/artists/${id}/top-tracks?market=${MARKET}`),
    get<{ items: SpAlbum[] }>(db, env, `/artists/${id}/albums?include_groups=album,single,compilation&market=${MARKET}&limit=50`),
  ]);
  const records = dedupeAlbums(albums.items).sort((a, b) => (year(a) ?? 0) - (year(b) ?? 0)).map(albumToRecord);
  return {
    ...artistToCard(artist),
    popularity: artist.popularity,
    topTracks: top.tracks.filter((t) => t.album).map((t) => ({ track: trackToTrack(t), record: albumToRecord({ ...t.album!, artists: t.album!.artists?.length ? t.album!.artists : t.artists }) })),
    records,
  };
}

// ---------- albums ----------

export async function getRecord(db: D1Like | null, env: SpotifyEnv, id: string): Promise<RecordDetail> {
  const m = id.match(/^sp:album:([A-Za-z0-9]+)$/);
  if (!m) throw new SpotifyError("Unknown record id.", 400);
  const album = await get<SpAlbum & { tracks: { items: SpTrack[]; total: number } }>(db, env, `/albums/${m[1]}?market=${MARKET}`);
  const rec = albumToRecord(album);
  let genres = album.genres ?? [];
  if (!genres.length && album.artists[0]?.id) {
    try { const a = await get<SpArtist>(db, env, `/artists/${album.artists[0].id}`); genres = a.genres ?? []; } catch { /* genres are a nicety */ }
  }
  return {
    ...rec,
    genres,
    tracks: album.tracks.items.map(trackToTrack),
    totalTracks: album.total_tracks,
    releaseDate: album.release_date,
  };
}

export async function appTokenForDebug(db: D1Like | null, env: SpotifyEnv): Promise<string> { return appAccessToken(db, env); }
