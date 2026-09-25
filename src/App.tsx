import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { api, getOwnerKey, setOwnerKey, type Playlist, type Record, type Status, type TopTen, type Track } from "./api";
import RecordSheet from "./components/RecordSheet";
import Picker from "./components/Picker";
import Crate from "./views/Crate";
import Artist from "./views/Artist";
import { TopTenEditor, TopTens } from "./views/TopTens";
import { PlaylistEditor, Playlists } from "./views/Playlists";

interface Shell {
  status: Status | null;
  refreshStatus: () => void;
  open: (r: Record, pool?: Record[]) => void;
  close: () => void;
  openRecord: Record | null;
  pool: Record[];
  toast: (msg: string) => void;
  addToTopTen: (r: Record) => void;
  addToPlaylist: (r: Record, t: Track) => void;
  addAllToPlaylist: (items: { record: Record; track: Track }[]) => void;
  unlock: () => void;
}

const ShellCtx = createContext<Shell | null>(null);
export const useShell = () => useContext(ShellCtx)!;

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [openRecord, setOpenRecord] = useState<Record | null>(null);
  const [pool, setPool] = useState<Record[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [picker, setPicker] = useState<null | { kind: "topten"; record: Record } | { kind: "playlist"; items: { record: Record; track: Track }[] }>(null);
  const navigate = useNavigate();

  const refreshStatus = useCallback(() => { api.status().then(setStatus).catch(() => setStatus(null)); }, []);
  useEffect(refreshStatus, [refreshStatus]);

  const toast = useCallback((m: string) => { setMsg(m); window.setTimeout(() => setMsg((cur) => (cur === m ? null : cur)), 2400); }, []);

  const unlock = useCallback(() => {
    const k = window.prompt("Enter the owner key for this crate (the OWNER_KEY set on the Space):", getOwnerKey());
    if (k === null) return;
    setOwnerKey(k.trim());
    refreshStatus();
  }, [refreshStatus]);

  const needUnlock = useCallback((): boolean => {
    if (status && !status.unlocked) { toast("Unlock the crate first"); unlock(); return true; }
    return false;
  }, [status, toast, unlock]);

  const shell = useMemo<Shell>(() => ({
    status, refreshStatus, openRecord, pool, toast, unlock,
    open: (r, p) => { setOpenRecord(r); if (p) setPool(p); },
    close: () => setOpenRecord(null),
    addToTopTen: (record) => { if (!needUnlock()) setPicker({ kind: "topten", record }); },
    addToPlaylist: (record, track) => { if (!needUnlock()) setPicker({ kind: "playlist", items: [{ record, track }] }); },
    addAllToPlaylist: (items) => { if (!needUnlock()) setPicker({ kind: "playlist", items }); },
  }), [status, refreshStatus, openRecord, pool, toast, unlock, needUnlock]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setPicker(null); setOpenRecord(null); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <ShellCtx.Provider value={shell}>
      <div className="app">
        <header className="bar">
          <NavLink to="/" className="wordmark"><i aria-hidden="true" />Crate Digger</NavLink>
          <nav>
            <NavLink to="/" end>Crate</NavLink>
            <NavLink to="/top-tens">Top Tens</NavLink>
            <NavLink to="/sets">Sets</NavLink>
          </nav>
          <span className="spacer" />
          <div className="status">
            {status && (
              <>
                <span>Discogs <b>{status.discogs.token ? "on" : "no token"}</b></span>
                <span>Spotify <b>{status.spotify.connected ? "connected" : status.spotify.configured ? "not connected" : "phase 2"}</b></span>
                <button className="btn quiet" onClick={unlock} title="Saving lists requires the owner key">
                  {status.unlocked ? (status.ownerKeySet ? "Unlocked" : "No key set") : "Locked"}
                </button>
              </>
            )}
          </div>
        </header>

        <Routes>
          <Route path="/" element={<Crate />} />
          <Route path="/artist/:id" element={<Artist />} />
          <Route path="/top-tens" element={<TopTens />} />
          <Route path="/top-tens/:id" element={<TopTenEditor />} />
          <Route path="/sets" element={<Playlists />} />
          <Route path="/sets/:id" element={<PlaylistEditor />} />
        </Routes>

        {openRecord && <RecordSheet record={openRecord} />}

        {picker?.kind === "topten" && (
          <Picker<TopTen>
            title="Add to a Top Ten"
            load={api.topTens}
            describe={(t) => `${t.items.length}/10`}
            create={(title) => api.createTopTen({ title, items: [picker.record] }).then((t) => { toast(`Started “${t.title}”`); navigate(`/top-tens/${t.id}`); })}
            choose={async (t) => {
              if (t.items.some((i) => i.id === picker.record.id)) return toast("Already in that list");
              if (t.items.length >= 10) return toast("That list is full — open it to swap something out");
              await api.updateTopTen(t.id, { items: [...t.items, picker.record] });
              toast(`Added to “${t.title}” at #${t.items.length + 1}`);
            }}
            onClose={() => setPicker(null)}
          />
        )}
        {picker?.kind === "playlist" && (
          <Picker<Playlist>
            title={picker.items.length === 1 ? "Add to a set" : `Add ${picker.items.length} tracks to a set`}
            load={api.playlists}
            describe={(p) => `${p.tracks.length} tracks`}
            create={(title) => api.createPlaylist({ title, tracks: picker.items.map((i) => ({ ...i, note: "" })) }).then((p) => { toast(`Started “${p.title}”`); navigate(`/sets/${p.id}`); })}
            choose={async (p) => {
              await api.updatePlaylist(p.id, { tracks: [...p.tracks, ...picker.items.map((i) => ({ ...i, note: "" }))] });
              toast(`Added to “${p.title}”`);
            }}
            onClose={() => setPicker(null)}
          />
        )}
        {msg && <div className="toast" role="status">{msg}</div>}
      </div>
    </ShellCtx.Provider>
  );
}

export function Wrap({ children }: { children: ReactNode }) { return <>{children}</>; }
