// A thin layer over Spacefast's D1-shaped `env.DB` binding (MySQL underneath).

export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
export interface D1Like { prepare(sql: string): D1Statement }

let ready: Promise<void> | null = null;

export function ensureSchema(db: D1Like): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    await db.prepare(`CREATE TABLE IF NOT EXISTS dg_cache (
      k VARCHAR(191) PRIMARY KEY,
      status INT NOT NULL,
      body LONGTEXT NOT NULL,
      fetched_at BIGINT NOT NULL
    )`).run();
    await db.prepare(`CREATE TABLE IF NOT EXISTS top_tens (
      id VARCHAR(32) PRIMARY KEY,
      slug VARCHAR(120) NOT NULL,
      title VARCHAR(200) NOT NULL,
      blurb TEXT NOT NULL,
      items LONGTEXT NOT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )`).run();
    await db.prepare(`CREATE TABLE IF NOT EXISTS playlists (
      id VARCHAR(32) PRIMARY KEY,
      title VARCHAR(200) NOT NULL,
      blurb TEXT NOT NULL,
      tracks LONGTEXT NOT NULL,
      spotify_playlist_id VARCHAR(64) NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )`).run();
    await db.prepare(`CREATE TABLE IF NOT EXISTS kv (
      k VARCHAR(191) PRIMARY KEY,
      v LONGTEXT NOT NULL,
      updated_at BIGINT NOT NULL
    )`).run();
  })().catch((e) => { ready = null; throw e; });
  return ready;
}

export async function kvGet(db: D1Like, k: string): Promise<string | null> {
  const { results } = await db.prepare(`SELECT v FROM kv WHERE k = ?`).bind(k).all<{ v: string }>();
  return results[0]?.v ?? null;
}
export async function kvSet(db: D1Like, k: string, v: string): Promise<void> {
  await db.prepare(`REPLACE INTO kv (k, v, updated_at) VALUES (?, ?, ?)`).bind(k, v, Date.now()).run();
}

export async function kvDel(db: D1Like, k: string): Promise<void> {
  await db.prepare(`DELETE FROM kv WHERE k = ?`).bind(k).run();
}

export function newId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function slugify(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "list";
}
