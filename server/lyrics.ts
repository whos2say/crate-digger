// Lyrics come from LRCLIB (https://lrclib.net), a free community-run database. No API key needed.
// Two calls: /api/get for an exact artist+title+album+duration match, /api/search as a fuzzier
// fallback when duration or album is off. Both plain lyrics and time-synced .lrc are returned
// when the database has them; synced enables the highlighted current-line UI while a track plays.
//
// Everything is cached in dg_cache exactly like Discogs so we don't hammer LRCLIB, with a longer
// TTL because lyrics essentially don't change once matched.

import type { Ctx } from "./discogs";

const API = "https://lrclib.net/api";
const UA = "CrateDigger/1.0 (+https://crate-digger.view.fast)";
const CACHE_FRESH_MS = 7 * 24 * 60 * 60 * 1000; // a week
const MISS_TTL_MS = 24 * 60 * 60 * 1000; // a day: retry misses eventually in case LRCLIB adds them
const memory = new Map<string, { at: number; body: unknown }>();

export interface LyricLine { ms: number; text: string }
export interface Lyrics { plain?: string; synced?: LyricLine[]; source: "lrclib"; url?: string }

/** Parse an LRC-format string ("[00:12.34]Some line\n[00:15.78]Next line") into ordered lines. */
export function parseSynced(lrc: string): LyricLine[] {
  const out: LyricLine[] = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const tags: number[] = [];
    let rest = raw;
    // One line can carry multiple timestamps: "[00:12.34][00:24.56]repeat".
    while (true) {
      const m = rest.match(/^\[(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?\]/);
      if (!m) break;
      const min = Number(m[1]), sec = Number(m[2]), frac = m[3] ? Number(`0.${m[3]}`) : 0;
      tags.push(Math.round((min * 60 + sec + frac) * 1000));
      rest = rest.slice(m[0].length);
    }
    const text = rest.trim();
    if (!tags.length) continue;
    for (const ms of tags) out.push({ ms, text });
  }
  return out.sort((a, b) => a.ms - b.ms);
}

async function cached(ctx: Ctx, key: string, fetcher: () => Promise<unknown>): Promise<unknown> {
  const now = Date.now();
  const hit = memory.get(key);
  if (hit && now - hit.at < CACHE_FRESH_MS) return hit.body;
  if (ctx.db) {
    const { results } = await ctx.db.prepare(`SELECT body, fetched_at FROM dg_cache WHERE k = ?`)
      .bind(key).all<{ body: string; fetched_at: number }>().catch(() => ({ results: [] as { body: string; fetched_at: number }[] }));
    const row = results[0];
    if (row) {
      const age = now - Number(row.fetched_at);
      const body = JSON.parse(row.body);
      // Serve fresh; also serve misses for a day so LRCLIB isn't polled on every load.
      const ttl = body === null ? MISS_TTL_MS : CACHE_FRESH_MS;
      if (age < ttl) { memory.set(key, { at: Number(row.fetched_at), body }); return body; }
    }
  }
  const body = await fetcher();
  memory.set(key, { at: now, body });
  if (ctx.db) {
    await ctx.db.prepare(`REPLACE INTO dg_cache (k, status, body, fetched_at) VALUES (?, ?, ?, ?)`)
      .bind(key, 200, JSON.stringify(body ?? null), now).run().catch(() => undefined);
  }
  return body;
}

interface LrcHit { id: number; plainLyrics?: string | null; syncedLyrics?: string | null; instrumental?: boolean }

async function fetchGet(artist: string, title: string, album: string | undefined, durationSec: number | undefined): Promise<LrcHit | null> {
  const qs = new URLSearchParams({ artist_name: artist, track_name: title });
  if (album) qs.set("album_name", album);
  if (durationSec && Number.isFinite(durationSec)) qs.set("duration", String(Math.round(durationSec)));
  const res = await fetch(`${API}/get?${qs}`, { headers: { "User-Agent": UA } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`LRCLIB answered ${res.status}.`);
  return res.json() as Promise<LrcHit>;
}

async function fetchSearch(artist: string, title: string): Promise<LrcHit | null> {
  const qs = new URLSearchParams({ artist_name: artist, track_name: title });
  const res = await fetch(`${API}/search?${qs}`, { headers: { "User-Agent": UA } });
  if (!res.ok) return null;
  const hits = (await res.json()) as LrcHit[];
  if (!Array.isArray(hits) || !hits.length) return null;
  // Prefer entries with synced lyrics; fall back to the first with plain.
  return hits.find((h) => h.syncedLyrics) ?? hits.find((h) => h.plainLyrics) ?? null;
}

export async function getLyrics(ctx: Ctx, q: { title: string; artist: string; album?: string; durationSec?: number }): Promise<Lyrics | null> {
  if (!q.title || !q.artist) return null;
  const key = `lrc:${q.artist.toLowerCase()}::${q.title.toLowerCase()}::${(q.album ?? "").toLowerCase()}::${Math.round(q.durationSec ?? 0)}`;
  const body = await cached(ctx, key, async () => {
    // First artist name only: LRCLIB matches better on the primary act than on "A, B & C".
    const artist = q.artist.split(/[,&/]/)[0].trim();
    let hit = await fetchGet(artist, q.title, q.album, q.durationSec).catch(() => null);
    if (!hit) hit = await fetchGet(artist, q.title, undefined, undefined).catch(() => null);
    if (!hit) hit = await fetchSearch(artist, q.title).catch(() => null);
    if (!hit || hit.instrumental) return null;
    const plain = hit.plainLyrics?.trim() || undefined;
    const synced = hit.syncedLyrics ? parseSynced(hit.syncedLyrics) : undefined;
    if (!plain && !(synced && synced.length)) return null;
    const out: Lyrics = { source: "lrclib", url: `https://lrclib.net/api/get/${hit.id}` };
    if (plain) out.plain = plain;
    if (synced && synced.length) out.synced = synced;
    return out;
  });
  return (body as Lyrics | null);
}
