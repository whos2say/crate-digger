import { newId, slugify, type D1Like } from "./db";
import type { Playlist, PlaylistTrack, Record, TopTen } from "./types";

// ---------- Top Tens ----------

type TopTenRow = { id: string; slug: string; title: string; blurb: string; items: string; created_at: number; updated_at: number };

function rowToTopTen(r: TopTenRow): TopTen {
  return { id: r.id, slug: r.slug, title: r.title, blurb: r.blurb, items: JSON.parse(r.items), createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) };
}

export async function listTopTens(db: D1Like): Promise<TopTen[]> {
  const { results } = await db.prepare(`SELECT * FROM top_tens ORDER BY updated_at DESC`).all<TopTenRow>();
  return results.map(rowToTopTen);
}

export async function getTopTen(db: D1Like, idOrSlug: string): Promise<TopTen | null> {
  const { results } = await db.prepare(`SELECT * FROM top_tens WHERE id = ? OR slug = ? LIMIT 1`).bind(idOrSlug, idOrSlug).all<TopTenRow>();
  return results[0] ? rowToTopTen(results[0]) : null;
}

function cleanItems(items: unknown): Record[] {
  if (!Array.isArray(items)) return [];
  const seen = new Set<string>();
  return items
    .filter((r): r is Record => !!r && typeof r === "object" && typeof (r as Record).id === "string" && typeof (r as Record).cover === "string")
    .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
    .slice(0, 10);
}

async function uniqueSlug(db: D1Like, base: string, keepId?: string): Promise<string> {
  let slug = base;
  for (let n = 2; n < 50; n++) {
    const { results } = await db.prepare(`SELECT id FROM top_tens WHERE slug = ?`).bind(slug).all<{ id: string }>();
    if (!results[0] || results[0].id === keepId) return slug;
    slug = `${base}-${n}`;
  }
  return `${base}-${newId().slice(0, 6)}`;
}

export async function createTopTen(db: D1Like, input: Partial<TopTen>): Promise<TopTen> {
  const id = newId();
  const title = String(input.title ?? "Untitled Top Ten").slice(0, 200);
  const now = Date.now();
  const t: TopTen = {
    id, slug: await uniqueSlug(db, slugify(title)), title, blurb: String(input.blurb ?? "").slice(0, 600),
    items: cleanItems(input.items), createdAt: now, updatedAt: now,
  };
  await db.prepare(`INSERT INTO top_tens (id, slug, title, blurb, items, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(t.id, t.slug, t.title, t.blurb, JSON.stringify(t.items), now, now).run();
  return t;
}

export async function updateTopTen(db: D1Like, id: string, input: Partial<TopTen>): Promise<TopTen | null> {
  const current = await getTopTen(db, id);
  if (!current) return null;
  const title = input.title !== undefined ? String(input.title).slice(0, 200) : current.title;
  const slug = title !== current.title ? await uniqueSlug(db, slugify(title), id) : current.slug;
  const next: TopTen = {
    ...current, title, slug,
    blurb: input.blurb !== undefined ? String(input.blurb).slice(0, 600) : current.blurb,
    items: input.items !== undefined ? cleanItems(input.items) : current.items,
    updatedAt: Date.now(),
  };
  await db.prepare(`UPDATE top_tens SET slug = ?, title = ?, blurb = ?, items = ?, updated_at = ? WHERE id = ?`)
    .bind(next.slug, next.title, next.blurb, JSON.stringify(next.items), next.updatedAt, id).run();
  return next;
}

export async function deleteTopTen(db: D1Like, id: string): Promise<void> {
  await db.prepare(`DELETE FROM top_tens WHERE id = ?`).bind(id).run();
}

// ---------- Playlists ----------

type PlaylistRow = { id: string; title: string; blurb: string; tracks: string; spotify_playlist_id: string | null; created_at: number; updated_at: number };

function rowToPlaylist(r: PlaylistRow): Playlist {
  return { id: r.id, title: r.title, blurb: r.blurb, tracks: JSON.parse(r.tracks), spotifyPlaylistId: r.spotify_playlist_id ?? undefined, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) };
}

function cleanTracks(tracks: unknown): PlaylistTrack[] {
  if (!Array.isArray(tracks)) return [];
  return tracks.filter((t): t is PlaylistTrack => !!t && typeof t === "object" && !!(t as PlaylistTrack).record && !!(t as PlaylistTrack).track)
    .map((t) => ({ record: t.record, track: t.track, note: String(t.note ?? "").slice(0, 400) })).slice(0, 300);
}

export async function listPlaylists(db: D1Like): Promise<Playlist[]> {
  const { results } = await db.prepare(`SELECT * FROM playlists ORDER BY updated_at DESC`).all<PlaylistRow>();
  return results.map(rowToPlaylist);
}

export async function getPlaylist(db: D1Like, id: string): Promise<Playlist | null> {
  const { results } = await db.prepare(`SELECT * FROM playlists WHERE id = ?`).bind(id).all<PlaylistRow>();
  return results[0] ? rowToPlaylist(results[0]) : null;
}

export async function createPlaylist(db: D1Like, input: Partial<Playlist>): Promise<Playlist> {
  const now = Date.now();
  const p: Playlist = { id: newId(), title: String(input.title ?? "Untitled set").slice(0, 200), blurb: String(input.blurb ?? "").slice(0, 600), tracks: cleanTracks(input.tracks), createdAt: now, updatedAt: now };
  await db.prepare(`INSERT INTO playlists (id, title, blurb, tracks, spotify_playlist_id, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?)`)
    .bind(p.id, p.title, p.blurb, JSON.stringify(p.tracks), now, now).run();
  return p;
}

export async function updatePlaylist(db: D1Like, id: string, input: Partial<Playlist>): Promise<Playlist | null> {
  const current = await getPlaylist(db, id);
  if (!current) return null;
  const next: Playlist = {
    ...current,
    title: input.title !== undefined ? String(input.title).slice(0, 200) : current.title,
    blurb: input.blurb !== undefined ? String(input.blurb).slice(0, 600) : current.blurb,
    tracks: input.tracks !== undefined ? cleanTracks(input.tracks) : current.tracks,
    spotifyPlaylistId: input.spotifyPlaylistId !== undefined ? input.spotifyPlaylistId : current.spotifyPlaylistId,
    updatedAt: Date.now(),
  };
  await db.prepare(`UPDATE playlists SET title = ?, blurb = ?, tracks = ?, spotify_playlist_id = ?, updated_at = ? WHERE id = ?`)
    .bind(next.title, next.blurb, JSON.stringify(next.tracks), next.spotifyPlaylistId ?? null, next.updatedAt, id).run();
  return next;
}

export async function deletePlaylist(db: D1Like, id: string): Promise<void> {
  await db.prepare(`DELETE FROM playlists WHERE id = ?`).bind(id).run();
}
