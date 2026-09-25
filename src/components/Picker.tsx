import { useEffect, useState } from "react";
import { ApiError } from "../api";
import { useShell } from "../App";

interface Props<T extends { id: string; title: string }> {
  title: string;
  load: () => Promise<T[]>;
  describe: (t: T) => string;
  choose: (t: T) => Promise<void>;
  create: (title: string) => Promise<void>;
  onClose: () => void;
}

export default function Picker<T extends { id: string; title: string }>({ title, load, describe, choose, create, onClose }: Props<T>) {
  const [items, setItems] = useState<T[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const { toast, unlock } = useShell();

  useEffect(() => { load().then(setItems).catch(() => setItems([])); }, [load]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); onClose(); }
    catch (e) { toast(e instanceof Error ? e.message : "Could not save"); if (e instanceof ApiError && e.status === 401) unlock(); }
    finally { setBusy(false); }
  };

  return (
    <div className="picker" onClick={onClose}>
      <div className="card" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <h3>{title}</h3>
        {items === null ? <p className="saved">Loading…</p> : items.length > 0 ? (
          <ul>
            {items.map((t) => (
              <li key={t.id}><button disabled={busy} onClick={() => run(() => choose(t))}>{t.title}<span>{describe(t)}</span></button></li>
            ))}
          </ul>
        ) : <p className="saved">No lists yet. Name a new one:</p>}
        <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) run(() => create(name.trim())); }}>
          <input className="field" placeholder="New list name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <button className="btn primary" disabled={busy || !name.trim()}>Create</button>
        </form>
        <div className="foot"><button className="btn quiet" onClick={onClose}>Cancel</button></div>
      </div>
    </div>
  );
}
