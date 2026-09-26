import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, ApiError, type Playlist, type PlaylistTrack } from "../api";
import { useShell } from "../App";
import { useReorder } from "../lib/dnd";
import { ListCards } from "./TopTens";

export function Playlists() {
  const [lists, setLists] = useState<Playlist[] | null>(null);
  const { toast, status, unlock } = useShell();
  const navigate = useNavigate();
  useEffect(() => { api.playlists().then(setLists).catch((e) => { toast(e.message); setLists([]); }); }, [toast]);

  const create = async () => {
    if (status && !status.unlocked) { unlock(); return; }
    const title = window.prompt("Name the set", "Saturday, second room, 2am");
    if (!title) return;
    try { const p = await api.createPlaylist({ title }); navigate(`/sets/${p.id}`); }
    catch (e) { toast(e instanceof Error ? e.message : "Could not create"); if (e instanceof ApiError && e.status === 401) unlock(); }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Sets</h1><p>Working playlists with track-level control: order, cut, and a note on how each one comes in. Export a set to Spotify as a real playlist once Spotify is connected.</p></div>
        <button className="btn primary" onClick={create}>New set</button>
      </div>
      {lists === null && <p className="saved">Loading…</p>}
      {lists && !lists.length && <div className="empty" style={{ padding: "20px 0" }}><h2>No sets yet</h2><p>Open a cover, find a track, and press “+ set”. Or add an artist’s whole catalogue from their page.</p></div>}
      {lists && lists.length > 0 && (
        <ListCards lists={lists.map((p) => ({ id: p.id, title: p.title, blurb: p.blurb, covers: uniqueCovers(p.tracks), href: `/sets/${p.id}`, count: `${p.tracks.length} tracks` }))} />
      )}
    </div>
  );
}

function uniqueCovers(tracks: PlaylistTrack[]): string[] {
  const seen = new Set<string>(); const out: string[] = [];
  for (const t of tracks) if (!seen.has(t.record.id)) { seen.add(t.record.id); out.push(t.record.thumb); }
  return out;
}

export function PlaylistEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { toast, open, unlock, status } = useShell();
  const [list, setList] = useState<Playlist | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "dirty" | "error">("saved");
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<{ url: string; matched: number; missed: { title: string; artist: string }[] } | null>(null);
  const timer = useRef<number | null>(null);

  const exportToSpotify = async () => {
    if (!list) return;
    if (status && !status.unlocked) { unlock(); return; }
    if (saveState === "dirty" || saveState === "saving") { toast("Wait for the set to save first"); return; }
    setExporting(true);
    try {
      const r = await api.exportPlaylist(list.id);
      setList(r.playlist);
      setExportNote({ url: r.url, matched: r.matched, missed: r.missed });
      toast(r.missed.length ? `${r.matched} of ${list.tracks.length} tracks on Spotify` : "Set is on Spotify");
    } catch (e) { toast(e instanceof Error ? e.message : "Export failed"); if (e instanceof ApiError && e.status === 401) unlock(); }
    finally { setExporting(false); }
  };

  useEffect(() => { api.playlist(id!).then(setList).catch((e) => toast(e.message)); }, [id, toast]);

  const save = useCallback(async (next: Playlist) => {
    setSaveState("saving");
    try { await api.updatePlaylist(next.id, { title: next.title, blurb: next.blurb, tracks: next.tracks }); setSaveState("saved"); }
    catch (e) { setSaveState("error"); toast(e instanceof Error ? e.message : "Could not save"); if (e instanceof ApiError && e.status === 401) unlock(); }
  }, [toast, unlock]);

  const change = (patch: Partial<Playlist>, immediate = false) => {
    setList((cur) => {
      if (!cur) return cur;
      const next = { ...cur, ...patch };
      setSaveState("dirty");
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => save(next), immediate ? 0 : 700);
      return next;
    });
  };

  const { containerRef, onPointerDown, classFor } = useReorder<PlaylistTrack>(list?.tracks ?? [], (tracks) => change({ tracks }, true));

  if (!list) return <div className="hint" style={{ paddingTop: 40 }}>Opening the set…</div>;

  const remove = async () => {
    if (!window.confirm(`Delete “${list.title}”?`)) return;
    try { await api.deletePlaylist(list.id); navigate("/sets"); } catch (e) { toast(e instanceof Error ? e.message : "Could not delete"); }
  };

  const setNote = (i: number, note: string) => change({ tracks: list.tracks.map((t, j) => (j === i ? { ...t, note } : t)) });
  const total = list.tracks.reduce((s, t) => s + parseDuration(t.track.duration), 0);

  return (
    <>
      <div className="editor-head">
        <div>
          <input className="title" value={list.title} onChange={(e) => change({ title: e.target.value })} aria-label="Set title" />
          <textarea value={list.blurb} placeholder="What this set is for (optional)" onChange={(e) => change({ blurb: e.target.value })} aria-label="Blurb" />
        </div>
        <div className="tools">
          <span className="saved">{saveState === "saving" ? "Saving…" : saveState === "dirty" ? "Unsaved" : saveState === "error" ? "Not saved" : "Saved"}{total ? ` · ${Math.round(total / 60)} min` : ""}</span>
          {list.spotifyUrl && <a className="btn quiet" href={list.spotifyUrl} target="_blank" rel="noopener">Open in Spotify</a>}
          <button className="btn" disabled={!status?.spotify.connected || exporting || !list.tracks.length} onClick={exportToSpotify}
            title={status?.spotify.connected ? (list.spotifyPlaylistId ? "Update the Spotify playlist to match this set" : "Create a Spotify playlist from this set") : "Connect Spotify (top-right) to export"}>
            {exporting ? "Exporting…" : list.spotifyPlaylistId ? "Re-export to Spotify" : "Export to Spotify"}
          </button>
          <button className="btn quiet danger" onClick={remove}>Delete</button>
        </div>
      </div>
      <p className="hint">Drag the handle to reorder. The yellow line under each track is your intro note: how it comes in, what to watch for.</p>
      {exportNote && (
        <p className="export-result">
          {exportNote.matched} track{exportNote.matched === 1 ? "" : "s"} matched · <a href={exportNote.url} target="_blank" rel="noopener">open the playlist</a>
          {exportNote.missed.length > 0 && <> · not found on Spotify: {exportNote.missed.map((m) => `${m.artist} — ${m.title}`).join("; ")}</>}
        </p>
      )}
      {!list.tracks.length && <div className="empty"><h2>Empty set</h2><p>Open a cover in the crate and press “+ set” next to a track.</p></div>}
      <ol className="setlist" ref={(el) => { containerRef.current = el; }}>
        {list.tracks.map((t, i) => (
          <li key={`${t.record.id}:${t.track.position}:${i}`} data-slot={i} className={classFor(i)}>
            <span className="n">{i + 1}</span>
            <button className="art" onClick={() => open(t.record, list.tracks.map((x) => x.record))} aria-label={t.record.title}><img src={t.record.thumb} alt="" /></button>
            <div className="t">
              <strong>{t.track.title}</strong>
              <span>{t.record.artist} — {t.record.title}{t.record.year ? `, ${t.record.year}` : ""}{t.track.duration ? ` · ${t.track.duration}` : ""} · via {t.record.source === "discogs" ? "Discogs" : "Spotify"}{t.track.spotifyUri && <> · <a href={t.track.spotifyUrl} target="_blank" rel="noopener" style={{ color: "#1db954" }}>on Spotify</a></>}</span>
              <input className="note" value={t.note} placeholder="Intro note" onChange={(e) => setNote(i, e.target.value)} />
            </div>
            <div className="right" style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <button className="rm" onClick={() => change({ tracks: list.tracks.filter((_, j) => j !== i) }, true)}>Remove</button>
              <span className="grip" onPointerDown={onPointerDown(i)} style={{ touchAction: "none" }} aria-label="Drag to reorder" role="button">⠿</span>
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}

function parseDuration(d?: string): number {
  if (!d) return 0;
  const p = d.split(":").map(Number);
  if (p.some(isNaN)) return 0;
  return p.reduce((s, n) => s * 60 + n, 0);
}
