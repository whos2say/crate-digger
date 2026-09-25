import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiError, type Record, type TopTen } from "../api";
import { useShell } from "../App";
import { Cover } from "../components/CoverGrid";
import { useReorder } from "../lib/dnd";

export function TopTens() {
  const [lists, setLists] = useState<TopTen[] | null>(null);
  const { toast, status, unlock } = useShell();
  const navigate = useNavigate();
  useEffect(() => { api.topTens().then(setLists).catch((e) => { toast(e.message); setLists([]); }); }, [toast]);

  const create = async () => {
    if (status && !status.unlocked) { unlock(); return; }
    const title = window.prompt("Name the list", "Top 10 covers I'd play at sunrise");
    if (!title) return;
    try { const t = await api.createTopTen({ title }); navigate(`/top-tens/${t.id}`); }
    catch (e) { toast(e instanceof Error ? e.message : "Could not create"); if (e instanceof ApiError && e.status === 401) unlock(); }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Top Tens</h1><p>Ten covers, in order, with a title and a line or two. Each one gets a public page built for screenshots.</p></div>
        <button className="btn primary" onClick={create}>New Top Ten</button>
      </div>
      {lists === null && <p className="saved">Loading…</p>}
      {lists && !lists.length && <div className="empty" style={{ padding: "20px 0" }}><h2>No lists yet</h2><p>Start one here, or open any cover in the crate and choose “Add to a Top Ten”.</p></div>}
      {lists && lists.length > 0 && <ListCards lists={lists.map((l) => ({ id: l.id, title: l.title, blurb: l.blurb, covers: l.items.map((i) => i.thumb), href: `/top-tens/${l.id}`, count: `${l.items.length}/10` }))} />}
    </div>
  );
}

export function ListCards({ lists }: { lists: { id: string; title: string; blurb: string; covers: string[]; href: string; count: string }[] }) {
  return (
    <div className="list-cards">
      {lists.map((l) => (
        <Link key={l.id} to={l.href} className="list-card">
          <div className="fan">{Array.from({ length: 5 }, (_, i) => (l.covers[i] ? <img key={i} src={l.covers[i]} alt="" loading="lazy" /> : <i key={i} />))}</div>
          <div className="text"><h3>{l.title}</h3><p>{l.blurb || l.count}</p></div>
        </Link>
      ))}
    </div>
  );
}

export function TopTenEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { toast, open, unlock } = useShell();
  const [list, setList] = useState<TopTen | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "dirty" | "error">("saved");
  const timer = useRef<number | null>(null);

  useEffect(() => { api.topTen(id!).then(setList).catch((e) => toast(e.message)); }, [id, toast]);

  const save = useCallback(async (next: TopTen) => {
    setSaveState("saving");
    try { const saved = await api.updateTopTen(next.id, { title: next.title, blurb: next.blurb, items: next.items }); setList((cur) => (cur ? { ...cur, slug: saved.slug, updatedAt: saved.updatedAt } : saved)); setSaveState("saved"); }
    catch (e) { setSaveState("error"); toast(e instanceof Error ? e.message : "Could not save"); if (e instanceof ApiError && e.status === 401) unlock(); }
  }, [toast, unlock]);

  const change = (patch: Partial<TopTen>, immediate = false) => {
    setList((cur) => {
      if (!cur) return cur;
      const next = { ...cur, ...patch };
      setSaveState("dirty");
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => save(next), immediate ? 0 : 700);
      return next;
    });
  };

  const { containerRef, onPointerDown, classFor } = useReorder<Record>(list?.items ?? [], (items) => change({ items }, true));

  if (!list) return <div className="hint" style={{ paddingTop: 40 }}>Opening the list…</div>;
  const shareUrl = `${location.origin}/s/${list.slug}`;

  const remove = async () => {
    if (!window.confirm(`Delete “${list.title}”? The public page goes with it.`)) return;
    try { await api.deleteTopTen(list.id); navigate("/top-tens"); } catch (e) { toast(e instanceof Error ? e.message : "Could not delete"); }
  };

  return (
    <>
      <div className="editor-head">
        <div>
          <input className="title" value={list.title} onChange={(e) => change({ title: e.target.value })} aria-label="List title" />
          <textarea value={list.blurb} placeholder="A line or two about this list (optional)" onChange={(e) => change({ blurb: e.target.value })} aria-label="Blurb" />
        </div>
        <div className="tools">
          <span className="saved">{saveState === "saving" ? "Saving…" : saveState === "dirty" ? "Unsaved" : saveState === "error" ? "Not saved" : "Saved"}</span>
          <button className="btn" onClick={() => navigator.clipboard.writeText(shareUrl).then(() => toast("Link copied")).catch(() => window.prompt("Share link", shareUrl))} disabled={!list.items.length}>Copy share link</button>
          <a className="btn" href={shareUrl} target="_blank" rel="noopener">Open public page</a>
          <button className="btn quiet danger" onClick={remove}>Delete</button>
        </div>
      </div>
      <p className="hint">Drag covers to reorder. Add more from the crate: open a cover and choose “Add to a Top Ten”.</p>
      <div className="grid" ref={(el) => { containerRef.current = el; }}>
        {Array.from({ length: 10 }, (_, i) => {
          const r = list.items[i];
          if (!r) return <div key={"e" + i} className="tile slot-empty" data-slot={i}><div className="art">{i === list.items.length ? "Next up: pick a cover in the crate" : ""}</div><span className="rank" aria-hidden="true">{i + 1}</span></div>;
          return (
            <div key={r.id} data-slot={i} className={classFor(i)} onPointerDown={onPointerDown(i)} style={{ touchAction: "none" }}>
              <Cover record={r} rank={i + 1} onClick={() => open(r, list.items)}>
                <button className="btn quiet" style={{ marginTop: 4, padding: "4px 8px", fontSize: 12 }} onClick={() => change({ items: list.items.filter((x) => x.id !== r.id) }, true)}>Remove</button>
              </Cover>
            </div>
          );
        })}
      </div>
    </>
  );
}
