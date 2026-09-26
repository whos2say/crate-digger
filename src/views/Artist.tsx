import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, retryDelayMs, type ArtistDetail, type Record, type Track } from "../api";
import { useShell } from "../App";
import CoverGrid, { Art } from "../components/CoverGrid";

export default function Artist() {
  const { id } = useParams();
  const { addAllToPlaylist, toast } = useShell();
  const [artist, setArtist] = useState<ArtistDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keyTracks, setKeyTracks] = useState<{ title: string; record: Record; track: Track }[]>([]);
  const [collecting, setCollecting] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setArtist(null); setError(null); setKeyTracks([]);
    let timer: number | undefined;
    api.artist(Number(id)).then(async (a) => {
      setArtist(a);
      // Key tracks: the openers of the first records, read from the sleeve backs (cached server-side).
      const picks: { title: string; record: Record; track: Track }[] = [];
      for (const r of a.records.slice(0, 6)) {
        try {
          const d = await api.record(r.id);
          const t = d.tracks.find((t) => t.youtube) ?? d.tracks[0];
          if (t) picks.push({ title: t.title, record: r, track: t });
        } catch { /* skip */ }
        setKeyTracks(picks.slice());
      }
    }).catch((e) => {
      const delay = retryDelayMs(e);
      if (delay && attempt < 3) { setError(`Discogs is busy. Trying again in ${Math.ceil(delay / 1000)}s…`); timer = window.setTimeout(() => setAttempt((n) => n + 1), delay); }
      else setError(e.message);
    });
    return () => { if (timer) window.clearTimeout(timer); };
  }, [id, attempt]);

  const addAll = async () => {
    if (!artist) return;
    setCollecting(true);
    const items: { record: Record; track: Track }[] = [];
    for (const r of artist.records) {
      try {
        const d = await api.record(r.id);
        for (const t of d.tracks) items.push({ record: r, track: t });
      } catch { /* skip */ }
    }
    setCollecting(false);
    if (!items.length) return toast("No tracklists found for these records");
    addAllToPlaylist(items);
  };

  if (error) return <div className="notice error"><h3>Couldn’t load this artist</h3><p>{error}</p></div>;
  if (!artist) return <div className="hint" style={{ paddingTop: 40 }}>Pulling their records…</div>;

  return (
    <>
      <div className="artist-head">
        {artist.image && <Art src={artist.image} alt="" />}
        <div>
          <h1>{artist.name}</h1>
          {artist.profile && <p>{artist.profile}</p>}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn primary" onClick={addAll} disabled={collecting || !artist.records.length}>{collecting ? "Reading tracklists…" : "Add all tracks to a set"}</button>
            <span className="saved" style={{ alignSelf: "center" }}>{artist.records.length} records with covers · via Discogs</span>
          </div>
        </div>
      </div>
      {keyTracks.length > 0 && (
        <div className="key-tracks">
          <h2>Key tracks</h2>
          <ol>{keyTracks.map((k, i) => <li key={i}><b>{k.title}</b> — {k.record.title}{k.record.year ? `, ${k.record.year}` : ""}</li>)}</ol>
        </div>
      )}
      <CoverGrid records={artist.records} dense />
    </>
  );
}
