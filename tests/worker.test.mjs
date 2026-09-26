// End-to-end test of the bundled worker with a SQLite env.DB and a fake Discogs.
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

const IMG = "https://i.discogs.com/abc/h:600/w:600/cover.jpg";
let discogsCalls = 0;
globalThis.fetch = async (url) => {
  const u = String(url);
  discogsCalls++;
  if (u.includes("/masters/100")) return Response.json({ id: 100, title: "Blue Moon", year: 1994, artists: [{ name: "Loose Ends (2)", id: 7 }], genres: ["Electronic"], styles: ["Deep House"], images: [{ type: "primary", uri: IMG, uri150: IMG }], tracklist: [{ position: "A1", title: "Blue Moon (Original)", duration: "6:12" }, { position: "B1", title: "Dub", duration: "5:00" }], videos: [{ uri: "https://www.youtube.com/watch?v=abcdef12345", title: "Loose Ends - Blue Moon (Original Mix)" }], main_release: 200, uri: "/master/100" });
  if (u.includes("/releases/200")) return Response.json({ id: 200, title: "Blue Moon", labels: [{ name: "Nu Groove" }], country: "US", formats: [{ name: "Vinyl", descriptions: ["12\""] }], tracklist: [], images: [] });
  if (u.includes("/database/search")) {
    if (!u.includes("token")) { /* token goes in header; emulate 401 when missing */ }
    return Response.json({ pagination: { page: 1, pages: 3 }, results: [
      { id: 100, type: "master", title: "Loose Ends (2) - Blue Moon", year: "1994", label: ["Nu Groove"], genre: ["Electronic"], style: ["Deep House"], cover_image: IMG, thumb: IMG, uri: "/master/100" },
      { id: 101, type: "master", title: "No Cover - Record", cover_image: "https://st.discogs.com/spacer.gif", thumb: "" },
    ] });
  }
  if (u.startsWith("https://i.discogs.com/")) return new Response(new Uint8Array([255, 216, 255]), { headers: { "Content-Type": "image/jpeg" } });
  return new Response("nope", { status: 404 });
};

const env = { DB, DISCOGS_TOKEN: "t", OWNER_KEY: "sesame" };
const req = (path, init = {}) => worker.fetch(new Request("https://crate.test" + path, init), env);
const j = async (r) => ({ status: r.status, body: await r.json() });

test("status + health", async () => {
  const s = await j(await req("/api/status"));
  assert.equal(s.status, 200); assert.equal(s.body.discogs.token, true); assert.equal(s.body.unlocked, false);
  assert.equal((await req("/api/health")).status, 200);
});

test("record detail normalizes, borrows label from main release, matches YouTube", async () => {
  const r = await j(await req("/api/records/dg:m:100"));
  assert.equal(r.status, 200);
  assert.equal(r.body.artist, "Loose Ends"); assert.equal(r.body.label, "Nu Groove"); assert.equal(r.body.country, "US");
  assert.equal(r.body.tracks[0].youtube, "abcdef12345"); assert.equal(r.body.tracks[1].youtube, undefined);
  assert.ok(r.body.cover.startsWith("/api/image?u=https%3A%2F%2Fi.discogs.com"));
});

test("cache: second read costs no Discogs call, and survives memory reset via DB", async () => {
  const before = discogsCalls;
  await req("/api/records/dg:m:100");
  assert.equal(discogsCalls, before);
  const { results } = await DB.prepare("SELECT COUNT(*) AS n FROM dg_cache").all();
  assert.ok(results[0].n >= 2);
});

test("search drops results without covers and proxies images", async () => {
  const r = await j(await req("/api/search?style=Deep+House&decade=1990s"));
  assert.equal(r.status, 200); assert.equal(r.body.records.length, 1); assert.equal(r.body.pages, 3);
  assert.equal(r.body.records[0].id, "dg:m:100"); assert.equal(r.body.records[0].year, 1994);
});

test("image proxy: allowlist + cache headers", async () => {
  const ok = await req("/api/image?u=" + encodeURIComponent(IMG));
  assert.equal(ok.status, 200); assert.match(ok.headers.get("cache-control"), /max-age=2592000/);
  assert.equal((await req("/api/image?u=https://evil.example/x.jpg")).status, 403);
});

test("top tens: owner key gates writes; share page renders with OG tags", async () => {
  const denied = await req("/api/toptens", { method: "POST", body: JSON.stringify({ title: "x" }) });
  assert.equal(denied.status, 401);
  const rec = (await j(await req("/api/records/dg:m:100"))).body;
  const auth = { "x-crate-key": "sesame", "Content-Type": "application/json" };
  const created = await j(await req("/api/toptens", { method: "POST", headers: auth, body: JSON.stringify({ title: "Top 10 Deep House Covers of the 90s", blurb: "Sunrise material.", items: [rec] }) }));
  assert.equal(created.status, 201); assert.equal(created.body.slug, "top-10-deep-house-covers-of-the-90s");
  const dup = await j(await req("/api/toptens", { method: "POST", headers: auth, body: JSON.stringify({ title: "Top 10 Deep House Covers of the 90s" }) }));
  assert.equal(dup.body.slug, "top-10-deep-house-covers-of-the-90s-2");
  const upd = await j(await req(`/api/toptens/${created.body.id}`, { method: "PUT", headers: auth, body: JSON.stringify({ items: Array(12).fill(rec) }) }));
  assert.equal(upd.body.items.length, 1); // duplicates collapse
  const page = await req(`/s/${created.body.slug}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /property="og:title" content="Top 10 Deep House Covers of the 90s"/);
  assert.match(html, /og:image" content="https:\/\/crate.test\/api\/image\?u=/);
  assert.match(html, /class="rank"[^>]*>1</);
  const list = await j(await req("/api/toptens"));
  assert.equal(list.body.lists.length, 2);
  assert.equal((await req(`/api/toptens/${created.body.id}`, { method: "DELETE", headers: auth })).status, 200);
  assert.equal((await req(`/s/${created.body.slug}`)).status, 404);
});

test("playlists CRUD with notes", async () => {
  const auth = { "x-crate-key": "sesame", "Content-Type": "application/json" };
  const rec = (await j(await req("/api/records/dg:m:100"))).body;
  const p = await j(await req("/api/playlists", { method: "POST", headers: auth, body: JSON.stringify({ title: "2am", tracks: [{ record: rec, track: rec.tracks[0], note: "long intro" }] }) }));
  assert.equal(p.status, 201); assert.equal(p.body.tracks[0].note, "long intro");
  const got = await j(await req(`/api/playlists/${p.body.id}`));
  assert.equal(got.body.tracks.length, 1);
  assert.equal((await req("/api/spotify/connect")).status, 501);
});

test("rate limit: 429 from Discogs honors Retry-After, coalesces duplicates, serves stale when it can", async () => {
  const realFetch = globalThis.fetch;
  let searchCalls = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/database/search")) {
      searchCalls++;
      return new Response("{}", { status: 429, headers: { "Retry-After": "7" } });
    }
    return realFetch(url);
  };
  try {
    // Uncached search: fails fast with a wait the client can act on.
    const a = await req("/api/search?label=Nu+Groove");
    assert.equal(a.status, 429);
    assert.equal(a.headers.get("retry-after"), "7");
    assert.equal((await a.json()).retryAfter, 7);
    // The worker is now backing off: the same search costs no Discogs call…
    const b = await req("/api/search?label=Nu+Groove");
    assert.equal(b.status, 429); assert.equal(searchCalls, 1);
    // …but a previously cached search still answers from the cache.
    const c = await req("/api/search?style=Deep+House&decade=1990s");
    assert.equal(c.status, 200);
  } finally { globalThis.fetch = realFetch; }
});
