// Discogs access: every call goes through `cached()`, which serves from memory, then from the
// dg_cache table, then from Discogs. A 429 or network failure serves stale data rather than
// failing, because the crate view issues bursts of requests while Brendan flips through covers.

import type { D1Like } from "./db";
import type { ArtistDetail, Crate, Record, RecordDetail, Track } from "./types";

const API = "https://api.discogs.com";
const UA = "CrateDigger/0.1 +https://crate-digger.view.fast";
const FRESH_MS = 7 * 24 * 3600 * 1000; // a week: release metadata barely moves
const SEARCH_FRESH_MS = 24 * 3600 * 1000;

const memory = new Map<string, { status: number; body: string; fetchedAt: number }>();
// Identical requests in flight share one Discogs call: a crate of 40 covers opens with several
// sheets and palette reads that all want the same handful of releases.
const inflight = new Map<string, Promise<unknown>>();
let backoffUntil = 0;
const BACKOFF_DEFAULT_MS = 8_000;
const BACKOFF_MAX_MS = 60_000;

export class DiscogsError extends Error {
  constructor(message: string, public status: number, public retryAfterMs?: number) { super(message); }
}

function rateLimited(): DiscogsError {
  const wait = Math.max(1000, backoffUntil - Date.now());
  return new DiscogsError(`Discogs is rate limiting us. Retrying in ${Math.ceil(wait / 1000)}s.`, 429, wait);
}

export interface Ctx { db: D1Like | null; token: string | null }

async function cached(ctx: Ctx, path: string, freshMs = FRESH_MS): Promise<unknown> {
  const key = "dg:" + path;
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = cachedUncoalesced(ctx, key, path, freshMs).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function cachedUncoalesced(ctx: Ctx, key: string, path: string, freshMs: number): Promise<unknown> {
  const now = Date.now();
  let hit = memory.get(key) ?? null;
  if (!hit && ctx.db) {
    const { results } = await ctx.db.prepare(`SELECT status, body, fetched_at FROM dg_cache WHERE k = ?`).bind(key)
      .all<{ status: number; body: string; fetched_at: number }>();
    if (results[0]) {
      hit = { status: Number(results[0].status), body: results[0].body, fetchedAt: Number(results[0].fetched_at) };
      memory.set(key, hit);
    }
  }
  if (hit && hit.status === 200 && now - hit.fetchedAt < freshMs) return JSON.parse(hit.body);

  if (now < backoffUntil) {
    if (hit && hit.status === 200) return JSON.parse(hit.body);
    throw rateLimited();
  }

  const headers: { [k: string]: string } = { "User-Agent": UA, Accept: "application/vnd.discogs.v2.discogs+json" };
  if (ctx.token) headers.Authorization = `Discogs token=${ctx.token}`;
  let res: Response;
  try {
    res = await fetch(API + path, { headers });
  } catch (e) {
    if (hit && hit.status === 200) return JSON.parse(hit.body);
    throw new DiscogsError("Could not reach Discogs. " + (e instanceof Error ? e.message : ""), 502);
  }
  if (res.status === 429) {
    // Discogs meters a rolling 60 s window and says how long to wait; fall back to a short pause.
    const retryAfter = Number(res.headers.get("Retry-After") ?? NaN);
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, BACKOFF_MAX_MS) : BACKOFF_DEFAULT_MS;
    backoffUntil = Math.max(backoffUntil, Date.now() + waitMs);
    if (hit && hit.status === 200) return JSON.parse(hit.body);
    throw rateLimited();
  }
  // Ease off before the window is exhausted, so one busy crate does not black out the next click.
  const remainingHeader = res.headers.get("X-Discogs-Ratelimit-Remaining");
  if (remainingHeader !== null && Number(remainingHeader) <= 1) backoffUntil = Math.max(backoffUntil, Date.now() + 3_000);
  const body = await res.text();
  if (res.status === 200) {
    const entry = { status: 200, body, fetchedAt: Date.now() };
    memory.set(key, entry);
    if (ctx.db) {
      await ctx.db.prepare(`REPLACE INTO dg_cache (k, status, body, fetched_at) VALUES (?, ?, ?, ?)`)
        .bind(key, 200, body, entry.fetchedAt).run().catch(() => {});
    }
    return JSON.parse(body);
  }
  if (res.status === 401) throw new DiscogsError("This Discogs endpoint needs a token. Add DISCOGS_TOKEN to the Space.", 401);
  if (res.status === 404) throw new DiscogsError("Discogs has no record with that id.", 404);
  throw new DiscogsError(`Discogs answered ${res.status}.`, 502);
}

export async function cacheSize(db: D1Like | null): Promise<number> {
  if (!db) return memory.size;
  const { results } = await db.prepare(`SELECT COUNT(*) AS n FROM dg_cache`).all<{ n: number }>();
  return Number(results[0]?.n ?? 0);
}

// ---------- normalization ----------

export function proxied(url: string | undefined | null): string {
  if (!url) return "";
  return "/api/image?u=" + encodeURIComponent(url);
}

function splitArtist(title: string): { artist: string; album: string } {
  // Discogs search titles read "Artist - Album".
  const i = title.indexOf(" - ");
  if (i < 0) return { artist: "", album: title };
  return { artist: title.slice(0, i).replace(/\s\(\d+\)$/, ""), album: title.slice(i + 3) };
}

function cleanName(name: string): string {
  return (name || "").replace(/\s\(\d+\)$/, "").trim();
}

type SearchResult = {
  id: number; type: string; title: string; year?: string | number; label?: string[]; genre?: string[]; style?: string[];
  cover_image?: string; thumb?: string; master_id?: number; resource_url?: string; uri?: string;
};

export function fromSearchResult(r: SearchResult): Record | null {
  const isMaster = r.type === "master";
  if (!isMaster && r.type !== "release") return null;
  const cover = r.cover_image && !r.cover_image.includes("spacer.gif") ? r.cover_image : "";
  if (!cover) return null; // covers first: nothing to show without one
  const { artist, album } = splitArtist(r.title);
  return {
    id: isMaster ? `dg:m:${r.id}` : `dg:r:${r.id}`,
    source: "discogs",
    title: album,
    artist,
    year: r.year ? Number(r.year) || undefined : undefined,
    label: r.label?.[0] ? cleanName(r.label[0]) : undefined,
    genres: r.genre ?? [],
    styles: r.style ?? [],
    cover: proxied(cover),
    thumb: proxied(r.thumb || cover),
    url: "https://www.discogs.com" + (r.uri ?? `/${isMaster ? "master" : "release"}/${r.id}`),
  };
}

type DgRelease = {
  id: number; title: string; year?: number; artists?: { name: string; id: number }[]; labels?: { name: string }[];
  genres?: string[]; styles?: string[]; images?: { uri: string; uri150?: string; type?: string }[];
  tracklist?: { position: string; title: string; duration?: string; type_?: string }[];
  videos?: { uri: string; title: string }[]; notes?: string; formats?: { name: string; descriptions?: string[] }[];
  country?: string; uri?: string; main_release?: number; master_id?: number;
};

function primaryImage(images?: DgRelease["images"]) {
  if (!images?.length) return undefined;
  return images.find((i) => i.type === "primary") ?? images[0];
}

function youtubeId(uri: string): string | undefined {
  const m = uri.match(/[?&]v=([\w-]{6,})/) || uri.match(/youtu\.be\/([\w-]{6,})/);
  return m?.[1];
}

function matchVideos(tracks: Track[], videos: { id: string; title: string }[]) {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  for (const t of tracks) {
    const nt = norm(t.title);
    if (!nt) continue;
    const v = videos.find((v) => norm(v.title).includes(nt));
    if (v) t.youtube = v.id;
  }
}

export function fromRelease(r: DgRelease, kind: "m" | "r"): RecordDetail {
  const img = primaryImage(r.images);
  const artist = (r.artists ?? []).map((a) => cleanName(a.name)).join(", ");
  const tracks: Track[] = (r.tracklist ?? []).filter((t) => t.type_ !== "heading").map((t) => ({
    position: t.position, title: t.title, duration: t.duration || undefined,
  }));
  const videos = (r.videos ?? []).map((v) => ({ id: youtubeId(v.uri) ?? "", title: v.title })).filter((v) => v.id);
  matchVideos(tracks, videos);
  return {
    id: `dg:${kind}:${r.id}`,
    source: "discogs",
    title: r.title,
    artist,
    artistId: r.artists?.[0]?.id,
    year: r.year || undefined,
    label: r.labels?.[0]?.name ? cleanName(r.labels[0].name) : undefined,
    genres: r.genres ?? [],
    styles: r.styles ?? [],
    cover: proxied(img?.uri),
    thumb: proxied(img?.uri150 ?? img?.uri),
    url: "https://www.discogs.com" + (r.uri ?? `/${kind === "m" ? "master" : "release"}/${r.id}`),
    tracks,
    videos,
    notes: r.notes,
    formats: r.formats?.map((f) => [f.name, ...(f.descriptions ?? [])].join(" ")),
    country: r.country,
  };
}

// ---------- public API ----------

export async function getRecord(ctx: Ctx, id: string): Promise<RecordDetail> {
  const m = id.match(/^dg:(m|r):(\d+)$/);
  if (!m) throw new DiscogsError("Unknown record id.", 400);
  const kind = m[1] as "m" | "r";
  const data = (await cached(ctx, `/${kind === "m" ? "masters" : "releases"}/${m[2]}`)) as DgRelease;
  const detail = fromRelease(data, kind);
  // Masters carry no label; borrow it from the main release, cheaply and cached.
  if (kind === "m" && (!detail.label || !detail.tracks.length) && data.main_release) {
    try {
      const main = (await cached(ctx, `/releases/${data.main_release}`)) as DgRelease;
      const md = fromRelease(main, "r");
      detail.label ||= md.label;
      detail.country ||= md.country;
      detail.formats ||= md.formats;
      if (!detail.tracks.length) detail.tracks = md.tracks;
      if (!detail.videos.length) detail.videos = md.videos;
    } catch { /* main release is a nicety */ }
  }
  return detail;
}

export interface SearchParams {
  q?: string; genre?: string; style?: string; year?: string; label?: string; page?: number; perPage?: number; type?: "master" | "release";
}

export async function search(ctx: Ctx, p: SearchParams): Promise<{ records: Record[]; page: number; pages: number }> {
  const qs = new URLSearchParams();
  if (p.q) qs.set("q", p.q);
  if (p.genre) qs.set("genre", p.genre);
  if (p.style) qs.set("style", p.style);
  if (p.year) qs.set("year", p.year);
  if (p.label) qs.set("label", p.label);
  qs.set("type", p.type ?? "master");
  qs.set("per_page", String(p.perPage ?? 40));
  qs.set("page", String(p.page ?? 1));
  const data = (await cached(ctx, `/database/search?${qs}`, SEARCH_FRESH_MS)) as {
    results: SearchResult[]; pagination: { page: number; pages: number };
  };
  const seen = new Set<string>();
  const records: Record[] = [];
  for (const r of data.results) {
    const rec = fromSearchResult(r);
    if (rec && !seen.has(rec.cover)) { seen.add(rec.cover); records.push(rec); }
  }
  return { records, page: data.pagination.page, pages: data.pagination.pages };
}

export async function getArtist(ctx: Ctx, artistId: number): Promise<ArtistDetail> {
  type DgArtist = { id: number; name: string; profile?: string; images?: { uri: string; type?: string }[] };
  type DgArtistRelease = { id: number; type: "master" | "release"; title: string; year?: number; label?: string; role?: string; thumb?: string; artist?: string; main_release?: number; format?: string };
  const [artist, rels] = await Promise.all([
    cached(ctx, `/artists/${artistId}`) as Promise<DgArtist>,
    cached(ctx, `/artists/${artistId}/releases?sort=year&sort_order=asc&per_page=100`) as Promise<{ releases: DgArtistRelease[] }>,
  ]);
  const seen = new Set<string>();
  const records: Record[] = [];
  for (const r of rels.releases) {
    if (r.role && r.role !== "Main") continue;
    if (!r.thumb || r.thumb.includes("spacer.gif")) continue;
    const key = r.title.toLowerCase();
    if (seen.has(key)) continue; // masters and their releases both appear; keep the first
    seen.add(key);
    // The artist-releases feed only carries a 150px thumb. Full art loads lazily via /api/records/:id.
    records.push({
      id: r.type === "master" ? `dg:m:${r.id}` : `dg:r:${r.id}`,
      source: "discogs",
      title: r.title,
      artist: cleanName(r.artist || artist.name),
      artistId,
      year: r.year || undefined,
      label: r.label ? cleanName(r.label) : undefined,
      genres: [], styles: [],
      cover: proxied(r.thumb.replace("/h:150/", "/h:600/").replace("/w:150/", "/w:600/")),
      thumb: proxied(r.thumb),
      url: `https://www.discogs.com/${r.type}/${r.id}`,
    });
  }
  const img = artist.images?.find((i) => i.type === "primary") ?? artist.images?.[0];
  return {
    id: artist.id,
    name: cleanName(artist.name),
    profile: artist.profile?.replace(/\[.*?\]/g, "").slice(0, 600),
    image: proxied(img?.uri),
    records,
    keyTracks: [], // filled client-side from the first few records' tracklists
  };
}

// The home crate. With a token these are live Discogs searches; without, a set of artists
// whose discographies load from endpoints that need no token.
const TOKEN_CRATES: { key: string; label: string; params: SearchParams }[] = [
  { key: "deep-house-90s", label: "Deep house, nineties", params: { style: "Deep House", year: "1990-1999" } },
  { key: "disco-12s", label: "Disco twelves", params: { style: "Disco", year: "1976-1983" } },
  { key: "detroit", label: "Detroit", params: { style: "Techno", label: "Underground Resistance" } },
  { key: "jazz-funk", label: "Jazz-funk", params: { style: "Jazz-Funk", year: "1970-1979" } },
  { key: "balearic", label: "Balearic and ambient", params: { style: "Balearic", year: "1985-1995" } },
  { key: "uk-garage", label: "UK garage", params: { style: "UK Garage", year: "1996-2002" } },
  { key: "bossa", label: "Bossa and MPB", params: { style: "Bossa Nova", year: "1960-1975" } },
  { key: "dub", label: "Dub", params: { style: "Dub", year: "1972-1982" } },
];
const STARTER_ARTISTS = [1289 /* Daft Punk */, 45 /* Aphex Twin */, 2262, 3838, 21706, 5117, 1201, 2735];

export function crateDefinitions(): { key: string; label: string }[] {
  return TOKEN_CRATES.map(({ key, label }) => ({ key, label }));
}

export async function crate(ctx: Ctx, key: string, page = 1): Promise<Crate & { pages: number }> {
  const def = TOKEN_CRATES.find((c) => c.key === key);
  if (def) {
    if (!ctx.token) throw new DiscogsError("Browsing by genre, era and label needs a Discogs token.", 401);
    const res = await search(ctx, { ...def.params, page });
    return { key, label: def.label, records: res.records, pages: res.pages };
  }
  if (key === "starter") {
    const settled = await Promise.allSettled(STARTER_ARTISTS.map((id) => getArtist(ctx, id)));
    const records: Record[] = [];
    for (const s of settled) if (s.status === "fulfilled") records.push(...s.value.records.slice(0, 8));
    return { key, label: "Starter crate", records, pages: 1 };
  }
  throw new DiscogsError("No such crate.", 404);
}

// Discogs genre / style / decade / label browse
export const GENRES = ["Electronic", "Funk / Soul", "Jazz", "Hip Hop", "Reggae", "Rock", "Latin", "Pop", "Folk, World, & Country", "Stage & Screen"];
export const STYLES = ["Deep House", "House", "Techno", "Disco", "Boogie", "Jazz-Funk", "Soul", "Dub", "Downtempo", "Breaks", "UK Garage", "Ambient", "Balearic", "Afrobeat", "Italo-Disco", "Electro", "Drum n Bass", "Acid", "Minimal", "Bossa Nova"];
export const DECADES = ["1960s", "1970s", "1980s", "1990s", "2000s", "2010s", "2020s"];

export function decadeRange(decade: string): string | undefined {
  const m = decade.match(/^(\d{4})s$/);
  if (!m) return undefined;
  const y = Number(m[1]);
  return `${y}-${y + 9}`;
}

// ---------- image proxy ----------
const IMAGE_HOSTS = new Set(["i.discogs.com", "img.discogs.com", "st.discogs.com", "i.scdn.co", "mosaic.scdn.co"]);

export async function proxyImage(u: string): Promise<Response> {
  let url: URL;
  try { url = new URL(u); } catch { return new Response("bad url", { status: 400 }); }
  if (url.protocol !== "https:" || !IMAGE_HOSTS.has(url.hostname)) return new Response("host not allowed", { status: 403 });
  const upstream = await fetch(url.toString(), { headers: { "User-Agent": UA, Accept: "image/*" } });
  if (!upstream.ok) return new Response("upstream " + upstream.status, { status: upstream.status === 404 ? 404 : 502 });
  const headers = new Headers();
  headers.set("Content-Type", upstream.headers.get("Content-Type") ?? "image/jpeg");
  headers.set("Cache-Control", "public, max-age=2592000, immutable"); // 30 days at the edge and in the browser
  headers.set("Access-Control-Allow-Origin", "*"); // lets canvas read pixels for palette matching
  return new Response(upstream.body, { status: 200, headers });
}
