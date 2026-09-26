import type { ArtistDetail, Crate, Playlist, Record, RecordDetail, Status, TopTen } from "../server/types";
export type { ArtistDetail, Crate, Playlist, PlaylistTrack, Record, RecordDetail, Status, TopTen, Track } from "../server/types";

const KEY_STORAGE = "crate:key";
export function getOwnerKey(): string { try { return localStorage.getItem(KEY_STORAGE) ?? ""; } catch { return ""; } }
export function setOwnerKey(k: string) { try { k ? localStorage.setItem(KEY_STORAGE, k) : localStorage.removeItem(KEY_STORAGE); } catch {} }

export class ApiError extends Error {
  constructor(message: string, public status: number, public retryAfter?: number) { super(message); }
}

// A 429 is a "wait, then try again", not a dead end. Both Discogs (via the worker) and the
// hosting platform can answer 429; the worker says how long, the platform may not.
export function retryDelayMs(e: unknown): number | null {
  if (!(e instanceof ApiError) || e.status !== 429) return null;
  return Math.min(60, Math.max(2, e.retryAfter ?? 8)) * 1000;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: { [k: string]: string } = { ...(init.headers as { [k: string]: string }) };
  if (init.body) headers["Content-Type"] = "application/json";
  const key = getOwnerKey();
  if (key) headers["x-crate-key"] = key;
  const res = await fetch(path, { ...init, headers });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* html error page */ }
  if (!res.ok) {
    const body = data as { error?: string; retryAfter?: number } | null;
    const headerRetry = Number(res.headers.get("Retry-After"));
    const retryAfter = body?.retryAfter ?? (Number.isFinite(headerRetry) && headerRetry > 0 ? headerRetry : undefined);
    const message = body?.error ?? (res.status === 429 ? "Too many requests right now." : `Request failed (${res.status})`);
    throw new ApiError(message, res.status, retryAfter);
  }
  return data as T;
}

export const api = {
  status: () => call<Status>("/api/status"),
  crates: () => call<{ crates: { key: string; label: string }[]; token: boolean; browse: { genres: string[]; styles: string[]; decades: string[] } }>("/api/crates"),
  crate: (key: string, page = 1) => call<Crate & { pages: number }>(`/api/crates/${key}?page=${page}`),
  search: (params: { [k: string]: string | number | undefined }) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v));
    return call<{ records: Record[]; page: number; pages: number }>(`/api/search?${qs}`);
  },
  record: (id: string) => call<RecordDetail>(`/api/records/${id}`),
  artist: (id: number) => call<ArtistDetail>(`/api/artists/${id}`),
  topTens: () => call<{ lists: TopTen[] }>("/api/toptens").then((r) => r.lists),
  topTen: (id: string) => call<TopTen>(`/api/toptens/${id}`),
  createTopTen: (t: Partial<TopTen>) => call<TopTen>("/api/toptens", { method: "POST", body: JSON.stringify(t) }),
  updateTopTen: (id: string, t: Partial<TopTen>) => call<TopTen>(`/api/toptens/${id}`, { method: "PUT", body: JSON.stringify(t) }),
  deleteTopTen: (id: string) => call<{ ok: true }>(`/api/toptens/${id}`, { method: "DELETE" }),
  playlists: () => call<{ lists: Playlist[] }>("/api/playlists").then((r) => r.lists),
  playlist: (id: string) => call<Playlist>(`/api/playlists/${id}`),
  createPlaylist: (p: Partial<Playlist>) => call<Playlist>("/api/playlists", { method: "POST", body: JSON.stringify(p) }),
  updatePlaylist: (id: string, p: Partial<Playlist>) => call<Playlist>(`/api/playlists/${id}`, { method: "PUT", body: JSON.stringify(p) }),
  deletePlaylist: (id: string) => call<{ ok: true }>(`/api/playlists/${id}`, { method: "DELETE" }),
};

// ---------- cover palette (for "similar looking") ----------
export interface Palette { h: number; s: number; l: number; dark: number }
const palettes = new Map<string, Palette>();
const pending = new Map<string, Promise<Palette | null>>();

export function getPalette(r: Record): Palette | undefined { return palettes.get(r.id); }

export function loadPalette(r: Record): Promise<Palette | null> {
  const hit = palettes.get(r.id); if (hit) return Promise.resolve(hit);
  const inflight = pending.get(r.id); if (inflight) return inflight;
  const p = new Promise<Palette | null>((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const c = document.createElement("canvas"); c.width = 12; c.height = 12;
        const g = c.getContext("2d", { willReadFrequently: true })!;
        g.drawImage(img, 0, 0, 12, 12);
        const d = g.getImageData(0, 0, 12, 12).data;
        let sx = 0, sy = 0, sw = 0, sl = 0, dark = 0;
        for (let i = 0; i < d.length; i += 4) {
          const [h, s, l] = rgbToHsl(d[i], d[i + 1], d[i + 2]);
          const w = s + 0.05; // saturated pixels define the "look" more than grey ones
          sx += Math.cos((h * Math.PI) / 180) * w; sy += Math.sin((h * Math.PI) / 180) * w; sw += w; sl += l;
          if (l < 0.25) dark++;
        }
        const n = d.length / 4;
        const h = ((Math.atan2(sy, sx) * 180) / Math.PI + 360) % 360;
        const s = Math.min(1, Math.hypot(sx, sy) / sw);
        const pal = { h, s, l: sl / n, dark: dark / n };
        palettes.set(r.id, pal); resolve(pal);
      } catch { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = r.thumb;
  });
  pending.set(r.id, p);
  return p;
}

export function paletteDistance(a: Palette, b: Palette): number {
  const dh = Math.min(Math.abs(a.h - b.h), 360 - Math.abs(a.h - b.h)) / 180;
  const sat = Math.min(a.s, b.s);
  return dh * sat * 1.4 + Math.abs(a.s - b.s) + Math.abs(a.l - b.l) * 1.2 + Math.abs(a.dark - b.dark);
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

export function shuffle<T>(arr: T[]): T[] { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
