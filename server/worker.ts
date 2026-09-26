// The one worker behind /api/* and /s/*. Everything else is a static file served by Spacefast.

import { isOwner, ownerKeySet } from "./auth";
import { ensureSchema, type D1Like } from "./db";
import * as catalog from "./catalog";
import * as dg from "./discogs";
import * as lists from "./lists";
import { renderShare } from "./share";
import * as sp from "./spotify";
import type { Status } from "./types";

export interface Env { DB?: D1Like; DISCOGS_TOKEN?: string; OWNER_KEY?: string; SPOTIFY_CLIENT_ID?: string; SPOTIFY_CLIENT_SECRET?: string; APP_ORIGIN?: string; [k: string]: unknown }

const json = (data: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...extra } });
const err = (message: string, status: number) => json({ error: message }, status);

const CACHED = { "Cache-Control": "public, max-age=300, stale-while-revalidate=3600" };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const db = env.DB ?? null;
    if (db) {
      try { await ensureSchema(db); } catch (e) { return err("Database unavailable: " + (e instanceof Error ? e.message : String(e)), 503); }
    }
    const ctx: dg.Ctx = { db, token: typeof env.DISCOGS_TOKEN === "string" && env.DISCOGS_TOKEN ? env.DISCOGS_TOKEN : null };
    const needsDb = () => (db ? null : err("This Space has no database binding yet. Check runtime.database in sf.jsonc.", 503));
    const guard = () => (isOwner(request, env) ? null : err("That key does not match the Space's OWNER_KEY.", 401));

    try {
      // ---- share pages (public, server-rendered) ----
      let m = path.match(/^\/s\/([\w-]+)$/);
      if (m) {
        if (!db) return new Response("No database.", { status: 503 });
        const list = await lists.getTopTen(db, m[1]);
        if (!list) return new Response("This Top Ten does not exist (or was deleted).", { status: 404, headers: { "Content-Type": "text/plain" } });
        return new Response(renderShare(list, url.origin), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=60" } });
      }

      // ---- status ----
      if (path === "/api/status") {
        const status: Status = {
          discogs: { token: !!ctx.token, cache: db ? await dg.cacheSize(db).catch(() => 0) : 0 },
          spotify: { configured: sp.configured(env), ...(await sp.connection(db)) },
          ownerKeySet: ownerKeySet(env),
          unlocked: isOwner(request, env),
        };
        return json(status);
      }
      if (path === "/api/health") return json({ ok: true, db: !!db, spotify: sp.configured(env), discogsToken: !!ctx.token, time: new Date().toISOString() });


      // ---- images (fallback + palette reads; the browser loads covers straight from the CDN) ----
      if (path === "/api/image") {
        const u = url.searchParams.get("u");
        if (!u) return err("Missing u", 400);
        return dg.proxyImage(u);
      }

      // ---- catalogue (Spotify) ----
      if (path === "/api/crates") return json({ crates: catalog.crateDefinitions(), browse: { genres: catalog.GENRES, decades: catalog.DECADES } }, 200, CACHED);
      m = path.match(/^\/api\/crates\/([\w-]+)$/);
      if (m) return json(await catalog.crate(db, env, m[1], Number(url.searchParams.get("page") ?? 1)), 200, CACHED);
      if (path === "/api/search") {
        const decade = url.searchParams.get("decade");
        const p: catalog.SearchParams = {
          q: url.searchParams.get("q") ?? undefined,
          genre: url.searchParams.get("genre") ?? url.searchParams.get("style") ?? undefined,
          label: url.searchParams.get("label") ?? undefined,
          year: url.searchParams.get("year") ?? (decade ? catalog.decadeRange(decade) : undefined),
          page: Number(url.searchParams.get("page") ?? 1),
        };
        return json(await catalog.search(db, env, p), 200, CACHED);
      }
      m = path.match(/^\/api\/records\/([\w:]+)$/);
      if (m) return json(await catalog.getRecord(db, env, m[1]), 200, CACHED);
      m = path.match(/^\/api\/artists\/([A-Za-z0-9]+)$/);
      if (m) return json(await catalog.getArtist(db, env, m[1]), 200, CACHED);

      // ---- the back of the sleeve (Discogs, on demand) ----
      if (path === "/api/sleeve") {
        const artist = url.searchParams.get("artist"), title = url.searchParams.get("title");
        if (!artist || !title) return err("Need artist and title.", 400);
        const y = Number(url.searchParams.get("year"));
        return json({ sleeve: await dg.sleeve(ctx, artist, title, y || undefined) }, 200, CACHED);
      }

      // ---- export a Top Ten to Spotify ----
      m = path.match(/^\/api\/toptens\/([\w-]+)\/export$/);
      if (m && request.method === "POST") {
        const e = needsDb(); if (e) return e;
        const g = guard(); if (g) return g;
        const list = await lists.getTopTen(db!, m[1]);
        if (!list) return err("Not found", 404);
        const result = await sp.exportTopTen(db!, env, list);
        const saved = await lists.updateTopTen(db!, list.id, { spotifyPlaylistId: result.playlistId, items: result.items });
        return json({ list: saved, url: result.url, matched: result.matched, missed: result.missed });
      }

      // ---- top tens ----
      if (path === "/api/toptens") {
        const e = needsDb(); if (e) return e;
        if (request.method === "GET") return json({ lists: await lists.listTopTens(db!) });
        if (request.method === "POST") { const g = guard(); if (g) return g; return json(await lists.createTopTen(db!, await request.json()), 201); }
      }
      m = path.match(/^\/api\/toptens\/([\w-]+)$/);
      if (m) {
        const e = needsDb(); if (e) return e;
        if (request.method === "GET") { const t = await lists.getTopTen(db!, m[1]); return t ? json(t) : err("Not found", 404); }
        const g = guard(); if (g) return g;
        if (request.method === "PUT" || request.method === "PATCH") { const t = await lists.updateTopTen(db!, m[1], await request.json()); return t ? json(t) : err("Not found", 404); }
        if (request.method === "DELETE") { await lists.deleteTopTen(db!, m[1]); return json({ ok: true }); }
      }

      // ---- export a set to Spotify ----
      m = path.match(/^\/api\/playlists\/([\w-]+)\/export$/);
      if (m && request.method === "POST") {
        const e = needsDb(); if (e) return e;
        const g = guard(); if (g) return g;
        const list = await lists.getPlaylist(db!, m[1]);
        if (!list) return err("Not found", 404);
        const result = await sp.exportPlaylist(db!, env, list);
        const saved = await lists.updatePlaylist(db!, list.id, { spotifyPlaylistId: result.playlistId, tracks: result.items });
        return json({ playlist: saved, url: result.url, matched: result.matched, missed: result.missed });
      }

      // ---- playlists ----
      if (path === "/api/playlists") {
        const e = needsDb(); if (e) return e;
        if (request.method === "GET") return json({ lists: await lists.listPlaylists(db!) });
        if (request.method === "POST") { const g = guard(); if (g) return g; return json(await lists.createPlaylist(db!, await request.json()), 201); }
      }
      m = path.match(/^\/api\/playlists\/([\w-]+)$/);
      if (m) {
        const e = needsDb(); if (e) return e;
        if (request.method === "GET") { const p = await lists.getPlaylist(db!, m[1]); return p ? json(p) : err("Not found", 404); }
        const g = guard(); if (g) return g;
        if (request.method === "PUT" || request.method === "PATCH") { const p = await lists.updatePlaylist(db!, m[1], await request.json()); return p ? json(p) : err("Not found", 404); }
        if (request.method === "DELETE") { await lists.deletePlaylist(db!, m[1]); return json({ ok: true }); }
      }

      // ---- spotify ----
      if (path.startsWith("/api/spotify/")) {
        const e = needsDb(); if (e) return e;
        const back = (q: string) => Response.redirect(`${typeof env.APP_ORIGIN === "string" && env.APP_ORIGIN ? env.APP_ORIGIN.replace(/\/+$/, "") : url.origin}/?${q}`, 302);
        // Connect: a browser navigation, so the owner key may arrive as ?key=.
        if (path === "/api/spotify/login") {
          if (!isOwner(request, env, true)) return err("That key does not match the Space's OWNER_KEY.", 401);
          return Response.redirect(await sp.loginUrl(db!, env, url.origin), 302);
        }
        if (path === "/api/spotify/callback") {
          try { const t = await sp.handleCallback(db!, env, url.origin, url.searchParams); return back(`spotify=connected&as=${encodeURIComponent(t.user.name)}`); }
          catch (e2) { return back(`spotify=error&why=${encodeURIComponent(e2 instanceof Error ? e2.message : "unknown")}`); }
        }
        if (path === "/api/spotify/disconnect" && request.method === "POST") {
          const g = guard(); if (g) return g;
          await sp.disconnect(db!);
          return json({ ok: true });
        }
        // Access token for the Web Playback SDK (owner only; Premium plays full tracks in the browser).
        if (path === "/api/spotify/token") {
          const g = guard(); if (g) return g;
          const t = await sp.accessToken(db!, env);
          return json({ accessToken: t.accessToken, expiresAt: t.expiresAt, product: t.user.product, user: t.user });
        }
        // Match a Discogs track to a Spotify track: uri, preview, link. Public, cached a month.
        if (path === "/api/spotify/match") {
          const title = url.searchParams.get("title"), artist = url.searchParams.get("artist");
          if (!title || !artist) return err("Need title and artist.", 400);
          const match = await sp.matchTrack(db!, env, { title, artist, album: url.searchParams.get("album") ?? undefined, duration: url.searchParams.get("duration") ?? undefined });
          return json({ match }, 200, CACHED);
        }
        return err("No such Spotify route.", 404);
      }


      return err("No such route.", 404);
    } catch (e) {
      if (e instanceof sp.SpotifyError || e instanceof dg.DiscogsError) {
        const extra: Record<string, string> = e.status === 429 ? { "Retry-After": String(Math.ceil((e.retryAfterMs ?? 8000) / 1000)) } : {};
        return json({ error: e.message, retryAfter: e.retryAfterMs ? Math.ceil(e.retryAfterMs / 1000) : undefined }, e.status, extra);
      }
      console.error("worker error", e);
      return err(e instanceof Error ? e.message : "Something broke.", 500);
    }
  },
};
