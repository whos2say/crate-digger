import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, retryDelayMs, shuffle, type Record } from "../api";
import { useShell } from "../App";
import CoverGrid from "../components/CoverGrid";

type Browse = { genres: string[]; styles: string[]; decades: string[] };
type Mode = "crate" | "genre" | "style" | "decade" | "label" | "search" | "dig";

export default function Crate() {
  const [params, setParams] = useSearchParams();
  const { status } = useShell();
  const [crates, setCrates] = useState<{ key: string; label: string }[]>([]);
  const [browse, setBrowse] = useState<Browse | null>(null);
  const [records, setRecords] = useState<Record[]>([]);
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

  const hasToken = status?.discogs.token ?? false;
  const crateKey = params.get("crate");
  const mode: Mode = params.get("q") ? "search" : params.get("genre") ? "genre" : params.get("style") ? "style" : params.get("decade") ? "decade" : params.get("label") ? "label" : params.get("dig") ? "dig" : "crate";
  const activeCrate = crateKey ?? (hasToken ? crates[0]?.key : "starter") ?? "starter";

  useEffect(() => { api.crates().then((c) => { setCrates(c.crates); setBrowse(c.browse); }).catch(() => {}); }, []);

  const load = useCallback(async (p: number, append: boolean) => {
    const my = ++seq.current;
    setLoading(true); setError(null);
    try {
      let res: { records: Record[]; pages: number; title: string };
      if (mode === "search") { const s = await api.search({ q: params.get("q")!, page: p }); res = { ...s, title: `“${params.get("q")}”` }; }
      else if (mode === "genre") { const s = await api.search({ genre: params.get("genre")!, page: p }); res = { ...s, title: params.get("genre")! }; }
      else if (mode === "style") { const s = await api.search({ style: params.get("style")!, page: p }); res = { ...s, title: params.get("style")! }; }
      else if (mode === "decade") { const s = await api.search({ decade: params.get("decade")!, page: p }); res = { ...s, title: `The ${params.get("decade")}` }; }
      else if (mode === "label") { const s = await api.search({ label: params.get("label")!, page: p }); res = { ...s, title: params.get("label")! }; }
      else if (mode === "dig") {
        if (hasToken && browse) {
          const style = browse.styles[Math.floor(Math.random() * browse.styles.length)];
          const decade = browse.decades[2 + Math.floor(Math.random() * 4)];
          const s = await api.search({ style, decade, page: 1 + Math.floor(Math.random() * 3) });
          res = { records: shuffle(s.records), pages: 1, title: `Keep digging — ${style}, ${decade}` };
        } else {
          const s = await api.crate("starter");
          res = { records: shuffle(s.records), pages: 1, title: "Keep digging" };
        }
      } else {
        const key = activeCrate;
        if (!key) return;
        const s = await api.crate(key, p);
        res = { records: s.records, pages: s.pages, title: s.label };
      }
      if (my !== seq.current) return;
      setRecords((cur) => (append ? dedupe([...cur, ...res.records]) : res.records));
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
  }, [mode, params, activeCrate, hasToken, browse]);

  useEffect(() => { retries.current = 0; if (status) load(1, false); }, [load, status, params.get("dig")]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (next: { [k: string]: string }) => { setParams(next); window.scrollTo({ top: 0 }); };
  const dig = () => set({ dig: String(Date.now()) });

  const countLabel = useMemo(() => (records.length ? `${records.length} covers${pages > page ? " so far" : ""}` : ""), [records.length, pages, page]);

  return (
    <>
      <div className="dividers" role="tablist" aria-label="Crates">
        {(hasToken ? crates : []).map((c) => (
          <button key={c.key} role="tab" aria-selected={mode === "crate" && activeCrate === c.key} className={`divider ${mode === "crate" && activeCrate === c.key ? "active" : ""}`} onClick={() => set({ crate: c.key })}>{c.label}</button>
        ))}
        <button role="tab" aria-selected={mode === "crate" && activeCrate === "starter"} className={`divider ${mode === "crate" && activeCrate === "starter" ? "active" : ""}`} onClick={() => set({ crate: "starter" })}>Starter crate</button>
        <button className="divider dig" onClick={dig}>Keep digging</button>
      </div>
      <div className="crate-ledge" />

      <div className="browse">
        <form onSubmit={(e) => { e.preventDefault(); if (query.trim()) set({ q: query.trim() }); }}>
          <input className="field" placeholder="Search records, artists, catalogue numbers" value={query} onChange={(e) => setQuery(e.target.value)} />
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
            {browse.decades.map((d) => <button key={d} className={`chip ${params.get("decade") === d ? "on" : ""}`} onClick={() => set({ decade: d })}>{d}</button>)}
          </div>
          <div className="chips">
            {browse.styles.map((s) => <button key={s} className={`chip ${params.get("style") === s ? "on" : ""}`} onClick={() => set({ style: s })}>{s}</button>)}
          </div>
        </div>
      )}

      {status && !hasToken && (
        <div className="notice">
          <h3>Browsing by genre, era and label needs a Discogs token</h3>
          <p>Discogs only opens its search to authenticated apps. Create a free personal token at discogs.com → Settings → Developers, then on the claimed Space run <code>npx sf env set DISCOGS_TOKEN</code>. Until then the starter crate, artist walls, searching by Discogs URL, and every Top Ten and set still work.</p>
        </div>
      )}

      <div className="crate-title">
        <h1>{title || (loading ? "Flipping…" : "The crate")}</h1>
        <span className="count">{countLabel}</span>
      </div>

      {error && (
        <div className="notice error">
          <h3>{retryIn !== null ? "Discogs is busy" : "Couldn’t load that crate"}</h3>
          <p>{retryIn !== null ? `Too many requests in the last minute. Flipping again in ${retryIn}s…` : error}</p>
          {retryIn === null && <button className="btn" onClick={() => { retries.current = 0; load(page, false); }}>Try again</button>}
        </div>
      )}
      {!error && !loading && !records.length && status && (
        <div className="empty"><h2>Nothing in this crate yet</h2><p>Try another divider, search for a record, or hit Keep digging.</p></div>
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
