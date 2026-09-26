// Spotify: one connected account (Brendan's), stored in the kv table. Tokens never reach the
// browser except the short-lived access token the Web Playback SDK needs, and only for the owner.
//
// Setup: create an app at developer.spotify.com, add `<APP_ORIGIN>/api/spotify/callback` as a
// redirect URI, then set SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET and APP_ORIGIN on the Space.

import { kvDel, kvGet, kvSet, type D1Like } from "./db";
import type { Playlist, PlaylistTrack, SpotifyMatch } from "./types";

const ACCOUNTS = "https://accounts.spotify.com";
const API = "https://api.spotify.com/v1";
const SCOPES = [
  "playlist-modify-public", "playlist-modify-private", "playlist-read-private",
  "streaming", "user-read-email", "user-read-private", "user-read-playback-state", "user-modify-playback-state",
].join(" ");
const STATE_TTL_MS = 10 * 60 * 1000;
const MATCH_FRESH_MS = 30 * 24 * 3600 * 1000;

export class SpotifyError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export interface SpotifyEnv { SPOTIFY_CLIENT_ID?: string; SPOTIFY_CLIENT_SECRET?: string; APP_ORIGIN?: string; [k: string]: unknown }

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
  user: { id: string; name: string; product?: string; url?: string };
}

export function configured(env: SpotifyEnv): boolean {
  return typeof env.SPOTIFY_CLIENT_ID === "string" && env.SPOTIFY_CLIENT_ID.length > 0
    && typeof env.SPOTIFY_CLIENT_SECRET === "string" && env.SPOTIFY_CLIENT_SECRET.length > 0;
}

function origin(env: SpotifyEnv, requestOrigin: string): string {
  const o = typeof env.APP_ORIGIN === "string" && env.APP_ORIGIN ? env.APP_ORIGIN : requestOrigin;
  return o.replace(/\/+$/, "");
}

export function redirectUri(env: SpotifyEnv, requestOrigin: string): string {
  return origin(env, requestOrigin) + "/api/spotify/callback";
}

export async function getTokens(db: D1Like): Promise<StoredTokens | null> {
  const raw = await kvGet(db, "spotify:tokens");
  if (!raw) return null;
  try { return JSON.parse(raw) as StoredTokens; } catch { return null; }
}

export async function connection(db: D1Like | null): Promise<{ connected: boolean; user?: StoredTokens["user"] }> {
  if (!db) return { connected: false };
  const t = await getTokens(db).catch(() => null);
  return t ? { connected: true, user: t.user } : { connected: false };
}

// ---------- OAuth (authorization code + PKCE; the client secret is sent too, from the server) ----------

function randomString(bytes = 32): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return base64url(b);
}
function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

export async function loginUrl(db: D1Like, env: SpotifyEnv, requestOrigin: string): Promise<string> {
  if (!configured(env)) throw new SpotifyError("Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET on the Space first.", 501);
  const state = randomString(16);
  const verifier = randomString(48);
  const challenge = base64url(await sha256(verifier));
  await kvSet(db, `spotify:state:${state}`, JSON.stringify({ verifier, at: Date.now() }));
  const qs = new URLSearchParams({
    client_id: env.SPOTIFY_CLIENT_ID as string,
    response_type: "code",
    redirect_uri: redirectUri(env, requestOrigin),
    scope: SCOPES,
    state,
    code_challenge_method: "S256",
    code_challenge: challenge,
    show_dialog: "true",
  });
  return `${ACCOUNTS}/authorize?${qs}`;
}

export async function handleCallback(db: D1Like, env: SpotifyEnv, requestOrigin: string, params: URLSearchParams): Promise<StoredTokens> {
  const error = params.get("error");
  if (error) throw new SpotifyError(`Spotify said: ${error}`, 400);
  const code = params.get("code"), state = params.get("state");
  if (!code || !state) throw new SpotifyError("Missing code or state.", 400);
  const rawState = await kvGet(db, `spotify:state:${state}`);
  await kvDel(db, `spotify:state:${state}`);
  if (!rawState) throw new SpotifyError("This sign-in link is stale. Start again from the crate.", 400);
  const { verifier, at } = JSON.parse(rawState) as { verifier: string; at: number };
  if (Date.now() - at > STATE_TTL_MS) throw new SpotifyError("This sign-in took too long. Start again from the crate.", 400);

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(env, requestOrigin),
    code_verifier: verifier,
  });
  const tokens = await tokenRequest(env, body);
  const me = await apiFetch<{ id: string; display_name?: string; product?: string; external_urls?: { spotify?: string } }>(tokens.access_token, "/me");
  const stored: StoredTokens = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? "",
    expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    scope: tokens.scope ?? SCOPES,
    user: { id: me.id, name: me.display_name || me.id, product: me.product, url: me.external_urls?.spotify },
  };
  await kvSet(db, "spotify:tokens", JSON.stringify(stored));
  return stored;
}

export async function disconnect(db: D1Like): Promise<void> {
  await kvDel(db, "spotify:tokens");
}

type TokenResponse = { access_token: string; refresh_token?: string; expires_in?: number; scope?: string; token_type?: string };

async function tokenRequest(env: SpotifyEnv, body: URLSearchParams): Promise<TokenResponse> {
  const basic = btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`);
  const res = await fetch(`${ACCOUNTS}/api/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try { detail = (JSON.parse(text) as { error_description?: string; error?: string }).error_description ?? detail; } catch { /* keep text */ }
    throw new SpotifyError(`Spotify would not issue a token (${res.status}): ${detail}`, 502);
  }
  return JSON.parse(text) as TokenResponse;
}

/** A valid access token for the connected account, refreshed when it has under two minutes left. */
export async function accessToken(db: D1Like, env: SpotifyEnv): Promise<StoredTokens> {
  const t = await getTokens(db);
  if (!t) throw new SpotifyError("Spotify is not connected. Connect it from the top-right of the crate.", 401);
  if (Date.now() < t.expiresAt - 120_000) return t;
  if (!t.refreshToken) throw new SpotifyError("Spotify session expired and cannot be refreshed. Connect again.", 401);
  const fresh = await tokenRequest(env, new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refreshToken }));
  const next: StoredTokens = {
    ...t,
    accessToken: fresh.access_token,
    refreshToken: fresh.refresh_token ?? t.refreshToken,
    expiresAt: Date.now() + (fresh.expires_in ?? 3600) * 1000,
  };
  await kvSet(db, "spotify:tokens", JSON.stringify(next));
  return next;
}

async function apiFetch<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(API + path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers as Record<string, string> | undefined) },
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? msg; } catch { /* keep text */ }
    if (res.status === 429) throw new SpotifyError(`Spotify is rate limiting us. Try again in ${res.headers.get("Retry-After") ?? "a few"}s.`, 429);
    throw new SpotifyError(`Spotify answered ${res.status}: ${msg}`, res.status === 401 || res.status === 403 ? 401 : 502);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

// ---------- matching a Discogs track to a Spotify track ----------

type SpTrack = {
  id: string; uri: string; name: string; duration_ms: number; preview_url: string | null; popularity?: number;
  artists: { name: string }[]; album: { name: string; release_date?: string; images?: { url: string }[] }; external_urls: { spotify: string };
};

function normalize(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\((\d+)\)/g, "") // Discogs disambiguators: "Loose Ends (2)"
    .replace(/\b(feat|ft)\.?\b.*$/, "")
    .replace(/[^a-z0-9]+/g, " ").trim();
}
function tokens(s: string): Set<string> { return new Set(normalize(s).split(" ").filter(Boolean)); }
function overlap(a: string, b: string): number {
  const x = tokens(a), y = tokens(b);
  if (!x.size || !y.size) return 0;
  let n = 0; for (const t of x) if (y.has(t)) n++;
  return n / Math.max(x.size, y.size);
}
function parseDurationMs(d?: string): number | null {
  if (!d) return null;
  const p = d.split(":").map(Number);
  if (p.some(isNaN)) return null;
  return p.reduce((s, n) => s * 60 + n, 0) * 1000;
}

export interface MatchQuery { title: string; artist: string; album?: string; duration?: string }

export async function matchTrack(db: D1Like, env: SpotifyEnv, q: MatchQuery): Promise<SpotifyMatch | null> {
  const key = `spotify:match:${normalize(q.artist)}|${normalize(q.title)}|${normalize(q.album ?? "")}`.slice(0, 190);
  const cached = await kvGet(db, key);
  if (cached) {
    const c = JSON.parse(cached) as { at: number; match: SpotifyMatch | null };
    if (Date.now() - c.at < MATCH_FRESH_MS) return c.match;
  }
  const { accessToken: token } = await accessToken(db, env);
  const queries = [
    `track:${q.title} artist:${q.artist}`,
    `${q.title} ${q.artist}`,
  ];
  let best: { t: SpTrack; score: number } | null = null;
  const wantMs = parseDurationMs(q.duration);
  for (const query of queries) {
    const res = await apiFetch<{ tracks: { items: SpTrack[] } }>(token, `/search?${new URLSearchParams({ q: query, type: "track", limit: "8" })}`);
    for (const t of res.tracks?.items ?? []) {
      const title = overlap(t.name, q.title);
      const artist = Math.max(...t.artists.map((a) => overlap(a.name, q.artist)), 0);
      const album = q.album ? overlap(t.album.name, q.album) * 0.3 : 0;
      const dur = wantMs ? Math.max(0, 0.2 - Math.abs(t.duration_ms - wantMs) / wantMs) : 0;
      const score = title * 0.55 + artist * 0.35 + album + dur + (t.preview_url ? 0.02 : 0);
      if (!best || score > best.score) best = { t, score };
    }
    if (best && best.score >= 0.8) break;
  }
  const match: SpotifyMatch | null = best && best.score >= 0.55 ? {
    uri: best.t.uri,
    id: best.t.id,
    title: best.t.name,
    artist: best.t.artists.map((a) => a.name).join(", "),
    album: best.t.album.name,
    durationMs: best.t.duration_ms,
    previewUrl: best.t.preview_url ?? undefined,
    url: best.t.external_urls.spotify,
    confidence: Math.round(Math.min(1, best.score) * 100) / 100,
  } : null;
  await kvSet(db, key, JSON.stringify({ at: Date.now(), match }));
  return match;
}

// ---------- playlist export ----------

export interface ExportResult { playlistId: string; url: string; matched: number; missed: { title: string; artist: string }[]; tracks: PlaylistTrack[] }

export async function exportPlaylist(db: D1Like, env: SpotifyEnv, list: Playlist): Promise<ExportResult> {
  const { accessToken: token, user } = await accessToken(db, env);
  const uris: string[] = [];
  const missed: { title: string; artist: string }[] = [];
  const tracks: PlaylistTrack[] = [];
  for (const pt of list.tracks) {
    let uri = pt.track.spotifyUri;
    let track = pt.track;
    if (!uri) {
      const m = await matchTrack(db, env, { title: pt.track.title, artist: pt.record.artist, album: pt.record.title, duration: pt.track.duration });
      if (m) { uri = m.uri; track = { ...pt.track, spotifyUri: m.uri, spotifyUrl: m.url, previewUrl: m.previewUrl }; }
    }
    if (uri) uris.push(uri); else missed.push({ title: pt.track.title, artist: pt.record.artist });
    tracks.push({ ...pt, track });
  }
  const description = (list.blurb || "Built in Crate Digger").slice(0, 300);
  let playlistId = list.spotifyPlaylistId;
  let url: string;
  if (playlistId) {
    // Already exported once: bring the Spotify playlist in line with the set as it is now.
    await apiFetch(token, `/playlists/${playlistId}`, { method: "PUT", body: JSON.stringify({ name: list.title.slice(0, 100), description }) });
    await apiFetch(token, `/playlists/${playlistId}/tracks`, { method: "PUT", body: JSON.stringify({ uris: uris.slice(0, 100) }) });
    for (let i = 100; i < uris.length; i += 100) await apiFetch(token, `/playlists/${playlistId}/tracks`, { method: "POST", body: JSON.stringify({ uris: uris.slice(i, i + 100) }) });
    url = `https://open.spotify.com/playlist/${playlistId}`;
  } else {
    const created = await apiFetch<{ id: string; external_urls: { spotify: string } }>(token, `/users/${encodeURIComponent(user.id)}/playlists`, {
      method: "POST", body: JSON.stringify({ name: list.title.slice(0, 100), description, public: false }),
    });
    playlistId = created.id;
    url = created.external_urls.spotify;
    for (let i = 0; i < uris.length; i += 100) await apiFetch(token, `/playlists/${playlistId}/tracks`, { method: "POST", body: JSON.stringify({ uris: uris.slice(i, i + 100) }) });
  }
  return { playlistId, url, matched: uris.length, missed, tracks };
}
