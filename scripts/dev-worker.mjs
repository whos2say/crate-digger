// Local stand-in for Spacefast Functions: runs the worker on :8788 with a SQLite-backed env.DB.
// Usage: node --experimental-sqlite scripts/dev-worker.mjs   (then `npm run dev` in another shell)
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";

const env = {};
for (const file of [".env.local", ".env.server"]) {
  try { for (const line of (await readFile(file, "utf8")).split("\n")) { const m = line.match(/^([A-Z_]+)=(.*)$/); if (m && m[2]) env[m[1]] = m[2].trim(); } } catch {}
}
const sqlite = new DatabaseSync(".local-crate.sqlite");
env.DB = {
  prepare(sql) {
    const s = sql.replace(/LONGTEXT/g, "TEXT").replace(/BIGINT/g, "INTEGER");
    let params = [];
    const st = { bind(...v) { params = v; return st; }, async all() { return { results: sqlite.prepare(s).all(...params) }; }, async run() { return sqlite.prepare(s).run(...params); } };
    return st;
  },
};
const out = await build({ entryPoints: ["server/worker.ts"], bundle: true, format: "esm", platform: "neutral", target: "es2022", write: false, conditions: ["workerd", "worker", "browser", "import", "module", "default"] });
const mod = await import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));
createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const r = await mod.default.fetch(new Request("http://localhost:8788" + req.url, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body }), env);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(8788, () => console.log("worker on http://127.0.0.1:8788  (db:", !!env.DB, "spotify:", !!env.SPOTIFY_CLIENT_ID, "discogs:", !!env.DISCOGS_TOKEN, ")"));
