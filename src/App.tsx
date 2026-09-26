import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { NavLink, Route, Routes, useNavigate, useSearchParams } from "react-router-dom";
import { api, getOwnerKey, setOwnerKey, type Playlist, type Record, type Status, type TopTen, type Track } from "./api";
import Player, { usePlayback } from "./components/Player";
import RecordSheet from "./components/RecordSheet";
import Picker from "./components/Picker";
import Crate from "./views/Crate";
import Artist from "./views/Artist";
import { TopTenEditor, TopTens } from "./views/TopTens";
import { PlaylistEditor, Playlists } from "./views/Playlists";

interface Shell {
  status: Status | null;
  /** Full-track playback through Spotify Premium; opens the track in Spotify when that isn't available. */
  play: (record: Record, track: Track) => void;
  nowPlaying: { record: Record; track: Track } | null;
  canPlay: boolean;
  refreshStatus: () => void;
  open: (r: Record, pool?: Record[]) => void;
  close: () => void;
  openRecord: Record | null;
  pool: Record[];
  toast: (msg: string) => void;
  addToTopTen: (r: Record, t?: Track) => void;
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
  const [picker, setPicker] = useState<null | { kind: "topten"; record: Record; track?: Track } | { kind: "playlist"; items: { record: Record; track: Track }[] }>(null);
  const navigate = useNavigate();

  const refreshStatus = useCallback(() => { api.status().then(setStatus).catch(() => setStatus(null)); }, []);
  useEffect(refreshStatus, [refreshStatus]);

  const toast = useCallback((m: string) => { setMsg(m); window.setTimeout(() => setMsg((cur) => (cur === m ? null : cur)), 2400); }, []);

  // Back from Spotify's consent screen: /?spotify=connected&as=Name or /?spotify=error&why=…
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    const outcome = params.get("spotify");
    if (!outcome) return;
    if (outcome === "connected") toast(`Spotify connected${params.get("as") ? ` as ${params.get("as")}` : ""}`);
    else toast(`Spotify: ${params.get("why") ?? "could not connect"}`);
    const next = new URLSearchParams(params); next.delete("spotify"); next.delete("as"); next.delete("why");
    setParams(next, { replace: true });
    refreshStatus();
  }, [params, setParams, toast, refreshStatus]);

  const connectSpotify = useCallback(() => {
    if (status && !status.unlocked) { toast("Unlock the crate first"); unlock(); return; }
    window.location.href = api.spotifyConnectUrl();
  }, [status, toast]); // eslint-disable-line react-hooks/exhaustive-deps

  const disconnectSpotify = useCallback(async () => {
    if (!window.confirm("Disconnect Spotify? Previews and export stop until you connect again.")) return;
    try { await api.spotifyDisconnect(); toast("Spotify disconnected"); refreshStatus(); }
    catch (e) { toast(e instanceof Error ? e.message : "Could not disconnect"); }
  }, [toast, refreshStatus]);

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

  const playback = usePlayback(status, toast);

  const shell = useMemo<Shell>(() => ({
    status, refreshStatus, openRecord, pool, toast, unlock,
    play: playback.play, nowPlaying: playback.now, canPlay: playback.canPlay,
    open: (r, p) => { setOpenRecord(r); if (p) setPool(p); },
    close: () => setOpenRecord(null),
    addToTopTen: (record, track) => { if (!needUnlock()) setPicker({ kind: "topten", record, track }); },
    addToPlaylist: (record, track) => { if (!needUnlock()) setPicker({ kind: "playlist", items: [{ record, track }] }); },
    addAllToPlaylist: (items) => { if (!needUnlock()) setPicker({ kind: "playlist", items }); },
  }), [status, refreshStatus, openRecord, pool, toast, unlock, needUnlock, playback]);

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
                <span title="Discogs powers the ‘read the sleeve’ panel">Sleeves <b>{status.discogs.token ? "on" : "off"}</b></span>
                {status.spotify.connected ? (
                  <span title={status.spotify.user?.product === "premium" ? "Premium: full tracks play in the crate" : "Free: 30-second previews"}>
                    Spotify <b className="sp-user">{status.spotify.user?.name ?? "connected"}</b>
                    {status.unlocked && <button className="btn quiet" style={{ marginLeft: 6 }} onClick={disconnectSpotify}>Disconnect</button>}
                  </span>
                ) : status.spotify.configured ? (
                  <button className="btn quiet" onClick={connectSpotify} title="Connect the Spotify account that owns the exported playlists">Connect Spotify</button>
                ) : (
                  <span title="Set SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET and APP_ORIGIN on the Space">Spotify <b>not set up</b></span>
                )}
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
            create={(title) => api.createTopTen({ title, items: [{ record: picker.record, track: picker.track }] }).then((t) => { toast(`Started “${t.title}”`); navigate(`/top-tens/${t.id}`); })}
            choose={async (t) => {
              const key = picker.track?.spotifyUri ?? picker.record.id;
              if (t.items.some((i) => (i.track?.spotifyUri ?? i.record.id) === key)) return toast("Already in that list");
              if (t.items.length >= 10) return toast("That list is full — open it to swap something out");
              await api.updateTopTen(t.id, { items: [...t.items, { record: picker.record, track: picker.track }] });
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
        <Player playback={playback} />
        {msg && <div className="toast" role="status">{msg}</div>}
      </div>
    </ShellCtx.Provider>
  );
}

export function Wrap({ children }: { children: ReactNode }) { return <>{children}</>; }
