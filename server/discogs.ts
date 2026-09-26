// Discogs is optional now: it powers the "read the sleeve" panel (label, catalogue number, format,
// country, notes) for a record the crate found on Spotify. Every call goes through `cached()`,
// which serves from memory, then from the dg_cache table, then from Discogs; a 429 serves stale.

import type { D1Like } from "./db";
import type { Sleeve } from "./types";

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

// ---------- sleeve lookup ----------

function cleanName(name: string): string {
  return (name || "").replace(/\s\(\d+\)$/, "").trim();
}

type SearchResult = { id: number; type: "master" | "release"; title: string; year?: string; label?: string[]; catno?: string; country?: string; format?: string[]; genre?: string[]; style?: string[]; cover_image?: string; uri: string };
type DgRelease = {
  id: number; title: string; year?: number; country?: string; notes?: string; uri?: string;
  artists?: { name: string }[]; labels?: { name: string; catno?: string }[]; genres?: string[]; styles?: string[];
  formats?: { name: string; descriptions?: string[] }[]; images?: { uri: string; type?: string }[];
  tracklist?: { position: string; title: string; duration?: string }[]; main_release?: number;
};

function norm(s: string): string { return s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/\(.*?\)|\[.*?\]/g, "").replace(/[^a-z0-9]+/g, " ").trim(); }

/** Find the Discogs master (or release) for an album and read its sleeve. */
export async function sleeve(ctx: Ctx, artist: string, title: string, year?: number): Promise<Sleeve | null> {
  if (!ctx.token) throw new DiscogsError("Reading sleeves needs a Discogs token on the Space.", 401);
  const qs = new URLSearchParams({ artist, release_title: title, type: "master", per_page: "10" });
  let data = (await cached(ctx, `/database/search?${qs}`, SEARCH_FRESH_MS)) as { results: SearchResult[] };
  if (!data.results.length) {
    const alt = new URLSearchParams({ q: `${artist} ${title}`, type: "release", per_page: "10" });
    data = (await cached(ctx, `/database/search?${alt}`, SEARCH_FRESH_MS)) as { results: SearchResult[] };
  }
  const want = norm(title);
  const scored = data.results
    .map((r) => {
      const t = r.title.includes(" - ") ? r.title.slice(r.title.indexOf(" - ") + 3) : r.title;
      let score = norm(t) === want ? 2 : norm(t).includes(want) || want.includes(norm(t)) ? 1 : 0;
      if (year && r.year && Math.abs(Number(r.year) - year) <= 1) score += 0.5;
      if (r.type === "master") score += 0.25;
      return { r, score };
    })
    .filter((x) => x.score >= 1)
    .sort((a, b) => b.score - a.score);
  const best = scored[0]?.r;
  if (!best) return null;
  const detail = (await cached(ctx, `/${best.type === "master" ? "masters" : "releases"}/${best.id}`)) as DgRelease;
  let release = detail;
  if (best.type === "master" && detail.main_release) {
    try { release = (await cached(ctx, `/releases/${detail.main_release}`)) as DgRelease; } catch { /* master alone is fine */ }
  }
  const label = release.labels?.[0] ?? detail.labels?.[0];
  return {
    url: `https://www.discogs.com/${best.type}/${best.id}`,
    title: detail.title,
    artist: (detail.artists ?? []).map((a) => cleanName(a.name)).join(", ") || artist,
    year: detail.year || release.year || (best.year ? Number(best.year) : undefined),
    label: label ? cleanName(label.name) : undefined,
    catno: label?.catno && label.catno !== "none" ? label.catno : undefined,
    country: release.country,
    formats: release.formats?.map((f) => [f.name, ...(f.descriptions ?? [])].join(" ")).filter(Boolean),
    genres: detail.genres ?? release.genres ?? best.genre ?? [],
    styles: detail.styles ?? release.styles ?? best.style ?? [],
    notes: (release.notes ?? detail.notes)?.replace(/\[.*?\]/g, "").trim().slice(0, 1200) || undefined,
    tracks: (release.tracklist ?? detail.tracklist ?? []).filter((t) => t.title).map((t) => ({ position: t.position, title: t.title, duration: t.duration || undefined })),
    cover: (detail.images?.find((i) => i.type === "primary") ?? detail.images?.[0])?.uri,
  };
}

// ---------- image proxy ----------
const IMAGE_HOSTS = new Set(["i.discogs.com", "img.discogs.com", "st.discogs.com", "i.scdn.co", "mosaic.scdn.co", "image-cdn-ak.spotifycdn.com", "image-cdn-fa.spotifycdn.com"]);

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
