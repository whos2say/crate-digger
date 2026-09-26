// End-to-end test of the bundled worker with a SQLite env.DB, a fake Spotify and a fake Discogs.
// Run: npm test   (after npm run build)
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import worker from "../dist/functions/_worker.js";

const sqlite = new DatabaseSync(":memory:");
const DB = {
  prepare(sql) {
    const s = sql.replace(/LONGTEXT/g, "TEXT").replace(/BIGINT/g, "INTEGER");
    let params = [];
    const st = { bind(...v) { params = v; return st; }, async all() { return { results: sqlite.prepare(s).all(...params) }; }, async run() { return sqlite.prepare(s).run(...params); } };
    return st;
  },
};

// ---------- fake Spotify + fake Discogs ----------
const IMG = "https://i.scdn.co/image/abc640";
const IMG300 = "https://i.scdn.co/image/abc300";
const images = [{ url: IMG, width: 640, height: 640 }, { url: IMG300, width: 300, height: 300 }];
const artistLite = { id: "art1", name: "Loose Ends", external_urls: { spotify: "https://open.spotify.com/artist/art1" } };
const album = (id, name, y, extra = {}) => ({ id, name, album_type: "album", release_date: `${y}-01-01`, images, artists: [artistLite], external_urls: { spotify: `https://open.spotify.com/album/${id}` }, ...extra });
const track = (id, name, n, dur = 372000) => ({ id, uri: `spotify:track:${id}`, name, duration_ms: dur, track_number: n, artists: [artistLite], external_urls: { spotify: `https://open.spotify.com/track/${id}` }, album: { name: "Blue Moon" } });

const calls = { spotify: 0, discogs: 0, tokenGrants: [], playlists: [], added: {}, replaced: {} };
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const body = init.body ? String(init.body) : "";
  if (u === "https://accounts.spotify.com/api/token") {
    const p = new URLSearchParams(body);
    calls.tokenGrants.push(p.get("grant_type"));
    assert.match(init.headers.Authorization, /^Basic /);
    if (p.get("grant_type") === "authorization_code") { assert.equal(p.get("code"), "CODE1"); assert.ok(p.get("code_verifier")); }
    return Response.json({ access_token: (p.get("grant_type") === "client_credentials" ? "APP-" : "AT-") + calls.tokenGrants.length, refresh_token: "RT", expires_in: 3600, scope: "streaming" });
  }
  if (u.startsWith("https://api.spotify.com/v1/")) {
    calls.spotify++;
    assert.match(init.headers.Authorization, /^Bearer (APP|AT)-/);
    const path = u.slice("https://api.spotify.com/v1".length);
    if (path === "/me") return Response.json({ id: "brendan", display_name: "DJ Brendan", product: "premium", external_urls: { spotify: "https://open.spotify.com/user/brendan" } });
    if (path.startsWith("/search?")) {
      const q = new URL(u).searchParams.get("q");
      const types = new URL(u).searchParams.get("type");
      const out = {};
      if (types.includes("album")) out.albums = { total: 2, items: /deep house|loose|blue moon|nu groove/i.test(q) ? [album("alb1", "Blue Moon", 1994, { label: "Nu Groove" }), album("alb1b", "Blue Moon (Remastered)", 2010), album("alb2", "No Art", 1990, { images: [] })] : [] };
      if (types.includes("artist")) out.artists = { items: [{ ...artistLite, images, genres: ["deep house", "uk street soul"], followers: { total: 12345 } }, { id: "art9", name: "No Photo", images: [], genres: [] }] };
      if (types.includes("track")) out.tracks = { items: /blue moon/i.test(q) ? [track("t1", "Blue Moon - Original Mix", 1), { ...track("t9", "Blue Moon", 1, 180000), artists: [{ id: "e", name: "Elvis Presley" }] }] : [] };
      return Response.json(out);
    }
    if (path === "/artists/art1") return Response.json({ ...artistLite, images, genres: ["deep house"], followers: { total: 12345 }, popularity: 40 });
    if (path.startsWith("/artists/art1/top-tracks")) return Response.json({ tracks: [{ ...track("t1", "Blue Moon - Original Mix", 1), album: album("alb1", "Blue Moon", 1994) }] });
    if (path.startsWith("/artists/art1/albums")) return Response.json({ items: [album("alb1", "Blue Moon", 1994), album("alb3", "Later", 1998)] });
    if (path.startsWith("/albums/alb1/tracks")) return Response.json({ items: [track("t1", "Blue Moon - Original Mix", 1)] });
    if (path.startsWith("/albums/alb1")) return Response.json({ ...album("alb1", "Blue Moon", 1994, { label: "Nu Groove", genres: [] }), total_tracks: 2, tracks: { items: [track("t1", "Blue Moon - Original Mix", 1), track("t2", "Dub", 2)] } });
    if (path.startsWith("/albums/nope")) return new Response("{}", { status: 404 });
    const m = path.match(/\/users\/([^/]+)\/playlists$/);
    if (m && init.method === "POST") { const id = "pl" + (calls.playlists.length + 1); calls.playlists.push({ id, user: m[1], ...JSON.parse(body) }); return Response.json({ id, external_urls: { spotify: "https://open.spotify.com/playlist/" + id } }); }
    const t = path.match(/\/playlists\/([^/]+)\/tracks$/);
    if (t && init.method === "POST") { (calls.added[t[1]] ??= []).push(...JSON.parse(body).uris); return Response.json({ snapshot_id: "s" }); }
    if (t && init.method === "PUT") { calls.replaced[t[1]] = JSON.parse(body).uris; return Response.json({ snapshot_id: "s" }); }
    if (path.match(/^\/playlists\/[^/]+$/) && init.method === "PUT") return new Response(null, { status: 200 });
    return new Response("{}", { status: 404 });
  }
  if (u.startsWith("https://api.discogs.com/")) {
    calls.discogs++;
    assert.match(init.headers.Authorization ?? "", /^Discogs token=/);
    if (u.includes("/database/search")) return Response.json({ results: [{ id: 100, type: "master", title: "Loose Ends (2) - Blue Moon", year: "1994", uri: "/master/100" }] });
    if (u.includes("/masters/100")) return Response.json({ id: 100, title: "Blue Moon", year: 1994, artists: [{ name: "Loose Ends (2)" }], genres: ["Electronic"], styles: ["Deep House"], main_release: 200, tracklist: [{ position: "A1", title: "Blue Moon (Original)", duration: "6:12" }] });
    if (u.includes("/releases/200")) return Response.json({ id: 200, title: "Blue Moon", country: "US", labels: [{ name: "Nu Groove", catno: "NG-042" }], formats: [{ name: "Vinyl", descriptions: ["12\""] }], notes: "Pressed at [l123]Frankford Wayne[/l]." });
    return new Response("nope", { status: 404 });
  }
  if (u.startsWith("https://i.scdn.co/") || u.startsWith("https://i.discogs.com/")) return new Response(new Uint8Array([255, 216, 255]), { headers: { "Content-Type": "image/jpeg" } });
  return new Response("nope", { status: 404 });
};

const env = { DB, SPOTIFY_CLIENT_ID: "cid", SPOTIFY_CLIENT_SECRET: "sec", APP_ORIGIN: "https://crate.test", DISCOGS_TOKEN: "t", OWNER_KEY: "sesame" };
const req = (path, init = {}, e = env) => worker.fetch(new Request("https://crate.test" + path, init), e);
const j = async (r) => ({ status: r.status, body: await r.json() });
const auth = { "x-crate-key": "sesame", "Content-Type": "application/json" };

test("status + health", async () => {
  const s = await j(await req("/api/status"));
  assert.equal(s.status, 200); assert.equal(s.body.spotify.configured, true); assert.equal(s.body.spotify.connected, false); assert.equal(s.body.discogs.token, true); assert.equal(s.body.unlocked, false);
  assert.equal((await req("/api/health")).status, 200);
});

test("catalogue: crates and search come from Spotify with an app token; artists ride along on text search", async () => {
  const c = await j(await req("/api/crates"));
  assert.ok(c.body.crates.find((x) => x.key === "deep-house-90s")); assert.ok(c.body.browse.genres.includes("Deep House"));
  const crate = await j(await req("/api/crates/deep-house-90s"));
  assert.equal(crate.status, 200);
  assert.equal(crate.body.label, "Deep house, nineties");
  // duplicates (remaster) and cover-less albums are dropped
  assert.deepEqual(crate.body.records.map((r) => r.id), ["sp:album:alb1"]);
  assert.equal(crate.body.records[0].cover, IMG); assert.equal(crate.body.records[0].thumb, IMG300); assert.equal(crate.body.records[0].year, 1994); assert.equal(crate.body.records[0].label, "Nu Groove"); assert.equal(crate.body.records[0].artistId, "art1");
  assert.equal(calls.tokenGrants[0], "client_credentials");
  const s = await j(await req("/api/search?q=loose+ends"));
  assert.equal(s.body.artists.length, 1); assert.equal(s.body.artists[0].name, "Loose Ends"); assert.equal(s.body.artists[0].thumb, IMG300);
  assert.equal(s.body.records.length, 1);
  assert.equal((await req("/api/search")).status, 400);
  assert.equal((await req("/api/crates/nope")).status, 404);
});

test("catalogue: second read is served from the cache; artist wall and album detail", async () => {
  const before = calls.spotify;
  await req("/api/crates/deep-house-90s");
  assert.equal(calls.spotify, before);
  const a = await j(await req("/api/artists/art1"));
  assert.equal(a.status, 200); assert.equal(a.body.name, "Loose Ends"); assert.equal(a.body.followers, 12345);
  assert.equal(a.body.topTracks[0].track.spotifyUri, "spotify:track:t1"); assert.equal(a.body.topTracks[0].record.id, "sp:album:alb1");
  assert.deepEqual(a.body.records.map((r) => r.year), [1994, 1998]);
  const d = await j(await req("/api/records/sp:album:alb1"));
  assert.equal(d.status, 200); assert.equal(d.body.tracks.length, 2); assert.equal(d.body.tracks[0].duration, "6:12"); assert.equal(d.body.tracks[1].spotifyUri, "spotify:track:t2");
  assert.deepEqual(d.body.genres, ["deep house"]); // borrowed from the artist
  assert.equal((await req("/api/records/sp:album:nope")).status, 404);
  assert.equal((await req("/api/records/dg:m:1")).status, 400);
});

test("sleeve: Discogs is consulted only on demand and returns label, catno, format, notes", async () => {
  const before = calls.discogs;
  const s = await j(await req("/api/sleeve?artist=Loose+Ends&title=Blue+Moon&year=1994"));
  assert.equal(s.status, 200);
  assert.equal(s.body.sleeve.label, "Nu Groove"); assert.equal(s.body.sleeve.catno, "NG-042"); assert.equal(s.body.sleeve.country, "US");
  assert.deepEqual(s.body.sleeve.formats, ['Vinyl 12"']); assert.equal(s.body.sleeve.notes, "Pressed at Frankford Wayne.");
  assert.equal(s.body.sleeve.url, "https://www.discogs.com/master/100");
  assert.ok(calls.discogs > before);
  assert.equal((await req("/api/sleeve?artist=x&title=y", {}, { ...env, DISCOGS_TOKEN: "" })).status, 401);
});

test("image proxy: allowlist + cache headers", async () => {
  const ok = await req("/api/image?u=" + encodeURIComponent(IMG));
  assert.equal(ok.status, 200); assert.match(ok.headers.get("cache-control"), /max-age=2592000/);
  assert.equal((await req("/api/image?u=https://evil.example/x.jpg")).status, 403);
});

test("rate limit: a 429 from Spotify carries Retry-After to the client", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => (String(url).includes("/artists/art2") ? new Response("{}", { status: 429, headers: { "Retry-After": "7" } }) : realFetch(url, init));
  try {
    const a = await req("/api/artists/art2");
    assert.equal(a.status, 429); assert.equal(a.headers.get("retry-after"), "7"); assert.equal((await a.json()).retryAfter, 7);
  } finally { globalThis.fetch = realFetch; }
});

test("spotify connect: login redirects with PKCE + state; callback stores the account; token endpoint is owner-only", async () => {
  assert.equal((await req("/api/spotify/login?key=sesame", {}, { ...env, SPOTIFY_CLIENT_ID: "" })).status, 501);
  assert.equal((await req("/api/spotify/login")).status, 401);
  const login = await req("/api/spotify/login?key=sesame");
  assert.equal(login.status, 302);
  const authUrl = new URL(login.headers.get("location"));
  assert.equal(authUrl.origin + authUrl.pathname, "https://accounts.spotify.com/authorize");
  assert.equal(authUrl.searchParams.get("redirect_uri"), "https://crate.test/api/spotify/callback");
  assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256");
  const state = authUrl.searchParams.get("state");
  assert.match((await req("/api/spotify/callback?code=CODE1&state=nope")).headers.get("location"), /spotify=error/);
  const cb = await req(`/api/spotify/callback?code=CODE1&state=${state}`);
  assert.equal(cb.headers.get("location"), "https://crate.test/?spotify=connected&as=DJ%20Brendan");
  const after = (await j(await req("/api/status"))).body.spotify;
  assert.equal(after.connected, true); assert.equal(after.user.product, "premium");
  assert.equal((await req("/api/spotify/token")).status, 401);
  assert.equal((await j(await req("/api/spotify/token", { headers: auth }))).body.product, "premium");
});

test("top tens: track items, legacy album items, owner gate, share page, export as a playlist", async () => {
  const rec = (await j(await req("/api/crates/deep-house-90s"))).body.records[0];
  const detail = (await j(await req("/api/records/sp:album:alb1"))).body;
  assert.equal((await req("/api/toptens", { method: "POST", body: JSON.stringify({ title: "x" }) })).status, 401);
  const created = await j(await req("/api/toptens", { method: "POST", headers: auth, body: JSON.stringify({ title: "Top 10 Deep House Covers of the 90s", blurb: "Sunrise records.", items: [{ record: rec, track: detail.tracks[1] }, rec, { record: rec, track: detail.tracks[1] }] }) }));
  assert.equal(created.status, 201);
  assert.equal(created.body.slug, "top-10-deep-house-covers-of-the-90s");
  // a bare Record is upgraded to an album-only item; the duplicate track is dropped
  assert.equal(created.body.items.length, 2);
  assert.equal(created.body.items[0].track.spotifyUri, "spotify:track:t2"); assert.equal(created.body.items[1].track, undefined);
  const page = await req(`/s/${created.body.slug}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /property="og:title" content="Top 10 Deep House Covers of the 90s"/);
  assert.match(html, new RegExp(`og:image" content="${IMG}"`));
  assert.match(html, />Dub</);
  // export: the album-only item uses the album's first track
  const ex = (await j(await req(`/api/toptens/${created.body.id}/export`, { method: "POST", headers: auth }))).body;
  assert.equal(ex.matched, 2); assert.deepEqual(ex.missed, []);
  assert.deepEqual(calls.added.pl1, ["spotify:track:t2", "spotify:track:t1"]);
  assert.equal(ex.list.spotifyUrl, "https://open.spotify.com/playlist/pl1");
  assert.equal(ex.list.items[1].track.spotifyUri, "spotify:track:t1");
  assert.match(await (await req(`/s/${created.body.slug}`)).text(), /Listen on Spotify/);
  assert.equal((await req(`/api/toptens/${created.body.id}`, { method: "DELETE", headers: auth })).status, 200);
  assert.equal((await req(`/s/${created.body.slug}`)).status, 404);
});

test("sets: CRUD with notes, export creates then updates one playlist, match falls back to search", async () => {
  const rec = (await j(await req("/api/crates/deep-house-90s"))).body.records[0];
  const detail = (await j(await req("/api/records/sp:album:alb1"))).body;
  const p = (await j(await req("/api/playlists", { method: "POST", headers: auth, body: JSON.stringify({ title: "2am", tracks: [
    { record: rec, track: detail.tracks[0], note: "long intro" },
    { record: { ...rec, artist: "Nobody" }, track: { position: "B2", title: "Nothing Here" }, note: "" },
  ] }) }))).body;
  assert.equal(p.tracks[0].note, "long intro");
  const ex = (await j(await req(`/api/playlists/${p.id}/export`, { method: "POST", headers: auth }))).body;
  assert.equal(ex.matched, 1); assert.deepEqual(ex.missed, [{ title: "Nothing Here", artist: "Nobody" }]);
  assert.equal(calls.playlists.find((x) => x.name === "2am").public, false);
  await req(`/api/playlists/${p.id}/export`, { method: "POST", headers: auth });
  assert.equal(calls.playlists.filter((x) => x.name === "2am").length, 1);
  assert.deepEqual(calls.replaced[ex.playlist.spotifyPlaylistId], ["spotify:track:t1"]);
  // matcher prefers the right artist
  const m = (await j(await req("/api/spotify/match?title=Blue+Moon&artist=Loose+Ends"))).body.match;
  assert.equal(m.uri, "spotify:track:t1");
  assert.equal((await req("/api/spotify/disconnect", { method: "POST", headers: auth })).status, 200);
  assert.equal((await j(await req("/api/status"))).body.spotify.connected, false);
});
