import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, retryDelayMs, shuffle, type ArtistCard, type Record } from "../api";
import { useShell } from "../App";
import CoverGrid, { Art } from "../components/CoverGrid";

type Browse = { genres: string[]; decades: string[] };
type Mode = "crate" | "genre" | "decade" | "label" | "search" | "dig";

export default function Crate() {
  const [params, setParams] = useSearchParams();
  const { status } = useShell();
  const [crates, setCrates] = useState<{ key: string; label: string }[]>([]);
  const [browse, setBrowse] = useState<Browse | null>(null);
  const [records, setRecords] = useState<Record[]>([]);
  const [artists, setArtists] = useState<ArtistCard[]>([]);
  const [pages, setPages] = useState(1);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryIn, setRetryIn] = useState<number | null>(null);
  const [title, setTitle] = useState<string>("");
  const [query, setQuery] = useState(params.get("q") ?? "");
  const [labelQ, setLabelQ] = useState(params.get("label") ?? "");
  const seq = useRef(0);
  const retries = useRef(0);

  const crateKey = params.get("crate");
  const mode: Mode = params.get("q") ? "search" : (params.get("genre") || params.get("style")) ? "genre" : params.get("decade") ? "decade" : params.get("label") ? "label" : params.get("dig") ? "dig" : "crate";
  const activeCrate = crateKey ?? crates[0]?.key ?? "deep-house-90s";

  useEffect(() => { api.crates().then((c) => { setCrates(c.crates); setBrowse(c.browse); }).catch(() => {}); }, []);

  const load = useCallback(async (p: number, append: boolean) => {
    const my = ++seq.current;
    setLoading(true); setError(null);
    try {
      let res: { records: Record[]; artists?: ArtistCard[]; pages: number; title: string };
      const genre = params.get("genre") ?? params.get("style");
      if (mode === "search") { const r = await api.search({ q: params.get("q")!, page: p }); res = { ...r, title: `“${params.get("q")}”` }; }
      else if (mode === "genre") { const r = await api.search({ genre: genre!, decade: params.get("decade") ?? undefined, page: p }); res = { ...r, title: genre! }; }
      else if (mode === "decade") { const r = await api.search({ decade: params.get("decade")!, genre: genre ?? undefined, page: p }); res = { ...r, title: `The ${params.get("decade")}` }; }
      else if (mode === "label") { const r = await api.search({ label: params.get("label")!, page: p }); res = { ...r, title: params.get("label")! }; }
      else if (mode === "dig") {
        const g = browse ? browse.genres[Math.floor(Math.random() * browse.genres.length)] : "house";
        const decade = browse ? browse.decades[1 + Math.floor(Math.random() * 5)] : "1990s";
        const r = await api.search({ genre: g, decade, page: 1 + Math.floor(Math.random() * 3) });
        res = { records: shuffle(r.records), pages: 1, title: `Keep digging — ${g}, ${decade}` };
      } else {
        const key = activeCrate;
        if (!key) return;
        const r = await api.crate(key, p);
        res = { records: r.records, pages: r.pages, title: r.label };
      }
      if (my !== seq.current) return;
      setRecords((cur) => (append ? dedupe([...cur, ...res.records]) : res.records));
      if (!append) setArtists(res.artists ?? []);
      setPages(res.pages); setPage(p); setTitle(res.title);
    } catch (e) {
      if (my !== seq.current) return;
      setError(e instanceof Error ? e.message : "Something broke");
      if (!append) setRecords([]);
      const delay = retryDelayMs(e);
      if (delay && retries.current < 3) {
        // Rate limited: count down and flip the same page again instead of leaving a dead card.
        retries.current += 1;
        const until = Date.now() + delay;
        setRetryIn(Math.ceil(delay / 1000));
        const tick = window.setInterval(() => setRetryIn(Math.max(0, Math.ceil((until - Date.now()) / 1000))), 500);
        window.setTimeout(() => { window.clearInterval(tick); setRetryIn(null); if (my === seq.current) load(p, append); }, delay);
      }
    } finally { if (my === seq.current) setLoading(false); }
  }, [mode, params, activeCrate, browse]);

  useEffect(() => { retries.current = 0; if (status) load(1, false); }, [load, status, params.get("dig")]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (next: { [k: string]: string }) => { setParams(next); window.scrollTo({ top: 0 }); };
  const genreParam = params.get("genre") ?? params.get("style");
  const dig = () => set({ dig: String(Date.now()) });

  const countLabel = useMemo(() => (records.length ? `${records.length} covers${pages > page ? " so far" : ""}` : ""), [records.length, pages, page]);

  return (
    <>
      <div className="dividers" role="tablist" aria-label="Crates">
        {crates.map((c) => (
          <button key={c.key} role="tab" aria-selected={mode === "crate" && activeCrate === c.key} className={`divider ${mode === "crate" && activeCrate === c.key ? "active" : ""}`} onClick={() => set({ crate: c.key })}>{c.label}</button>
        ))}
        <button className="divider dig" onClick={dig}>Keep digging</button>
      </div>
      <div className="crate-ledge" />

      <div className="browse">
        <form onSubmit={(e) => { e.preventDefault(); if (query.trim()) set({ q: query.trim() }); }}>
          <input className="field" placeholder="Search artists and records" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button className="btn">Dig</button>
        </form>
        <form onSubmit={(e) => { e.preventDefault(); if (labelQ.trim()) set({ label: labelQ.trim() }); }}>
          <input className="field" style={{ width: 200 }} placeholder="Label, e.g. Strictly Rhythm" value={labelQ} onChange={(e) => setLabelQ(e.target.value)} />
          <button className="btn">By label</button>
        </form>
      </div>
      {browse && (
        <div className="browse">
          <div className="chips">
            {browse.decades.map((d) => <button key={d} className={`chip ${params.get("decade") === d ? "on" : ""}`} onClick={() => set(params.get("decade") === d ? { ...(genreParam ? { genre: genreParam } : {}) } : { decade: d, ...(genreParam ? { genre: genreParam } : {}) })}>{d}</button>)}
          </div>
          <div className="chips">
            {browse.genres.map((g) => <button key={g} className={`chip ${genreParam === g ? "on" : ""}`} onClick={() => set(genreParam === g ? { ...(params.get("decade") ? { decade: params.get("decade")! } : {}) } : { genre: g, ...(params.get("decade") ? { decade: params.get("decade")! } : {}) })}>{g}</button>)}
          </div>
        </div>
      )}

      <div className="crate-title">
        <h1>{title || (loading ? "Flipping…" : "The crate")}</h1>
        <span className="count">{countLabel}</span>
      </div>

      {error && (
        <div className="notice error">
          <h3>{retryIn !== null ? "Spotify is busy" : "Couldn’t load that crate"}</h3>
          <p>{retryIn !== null ? `Too many requests in the last minute. Flipping again in ${retryIn}s…` : error}</p>
          {retryIn === null && <button className="btn" onClick={() => { retries.current = 0; load(page, false); }}>Try again</button>}
        </div>
      )}
      {!error && !loading && !records.length && status && (
        <div className="empty"><h2>Nothing in this crate yet</h2><p>Try another divider, search for a record, or hit Keep digging.</p></div>
      )}
      {artists.length > 0 && (
        <div className="artists-row" aria-label="Artists">
          {artists.map((a) => (
            <Link key={a.id} to={`/artist/${a.id}`} className="artist-card">
              <div className="face">{a.thumb && <Art src={a.thumb} alt="" loading="lazy" />}</div>
              <strong>{a.name}</strong>
              <span>{a.genres.slice(0, 2).join(" · ") || "Artist"}</span>
            </Link>
          ))}
        </div>
      )}
      <CoverGrid records={records} />
      {page < pages && (
        <div className="more"><button className="btn" disabled={loading} onClick={() => load(page + 1, true)}>{loading ? "Flipping…" : "Flip further back"}</button></div>
      )}
      {loading && !records.length && <div className="hint">Flipping through covers…</div>}
    </>
  );
}

function dedupe(rs: Record[]): Record[] {
  const seen = new Set<string>();
  return rs.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}
