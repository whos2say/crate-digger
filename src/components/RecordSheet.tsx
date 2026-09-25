import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, getPalette, loadPalette, paletteDistance, type Record, type RecordDetail, type Track } from "../api";
import { useShell } from "../App";

export default function RecordSheet({ record }: { record: Record }) {
  const { close, addToTopTen, addToPlaylist, pool, open } = useShell();
  const [detail, setDetail] = useState<RecordDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState<{ id: string; title: string } | null>(null);
  const [similar, setSimilar] = useState<Record[] | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    setDetail(null); setError(null); setPlaying(null); setSimilar(null);
    let live = true;
    api.record(record.id).then((d) => live && setDetail(d)).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [record.id]);

  useEffect(() => { document.body.style.overflow = "hidden"; return () => { document.body.style.overflow = ""; }; }, []);

  const r = detail ?? record;
  const cover = detail?.cover || record.cover;

  const findSimilar = async () => {
    const me = getPalette(record) ?? (await loadPalette(record));
    if (!me) return;
    const candidates = pool.filter((p) => p.id !== record.id);
    await Promise.all(candidates.slice(0, 120).map(loadPalette));
    const ranked = candidates
      .map((c) => ({ c, d: getPalette(c) ? paletteDistance(me, getPalette(c)!) : 9 }))
      .sort((a, b) => a.d - b.d).slice(0, 8).map((x) => x.c);
    setSimilar(ranked);
  };

  const browse = (params: { [k: string]: string }) => { close(); navigate("/?" + new URLSearchParams(params)); };

  return (
    <>
      <div className="sheet-scrim" onClick={close} />
      <aside className="sheet" aria-label={`${r.artist} – ${r.title}`}>
        <div className="hero">
          <img src={cover} alt={`${r.artist} – ${r.title} cover`} />
          <button className="close" onClick={close} aria-label="Close">×</button>
        </div>
        <div className="body">
          <h2>{r.title}</h2>
          <p className="artist">
            {detail?.artistId || record.artistId
              ? <Link to={`/artist/${detail?.artistId ?? record.artistId}`} onClick={close}>{r.artist}</Link>
              : r.artist}
          </p>
          <dl className="facts">
            {r.year && <><dt>Year</dt><dd>{r.year}</dd></>}
            {r.label && <><dt>Label</dt><dd><button className="linkish" onClick={() => browse({ label: r.label! })} style={{ textDecoration: "underline", textUnderlineOffset: 3 }}>{r.label}</button></dd></>}
            {detail?.country && <><dt>Country</dt><dd>{detail.country}</dd></>}
            {detail?.formats?.length ? <><dt>Format</dt><dd>{detail.formats.join(" / ")}</dd></> : null}
            {(r.genres.length || r.styles.length) ? (
              <><dt>Sounds like</dt><dd className="tags">
                {r.genres.map((g) => <button key={"g" + g} onClick={() => browse({ genre: g })}>{g}</button>)}
                {r.styles.map((s) => <button key={"s" + s} onClick={() => browse({ style: s })}>{s}</button>)}
              </dd></>
            ) : null}
          </dl>
          <p className="via">via {r.source === "discogs" ? "Discogs" : "Spotify"} · <a href={r.url} target="_blank" rel="noopener">open the record</a></p>

          <div className="actions">
            <button className="btn primary" onClick={() => addToTopTen(record)}>Add to a Top Ten</button>
            <button className="btn" onClick={findSimilar} disabled={!pool.length}>More covers like this</button>
          </div>

          {similar && (
            <>
              <h3>Similar looking, from this crate</h3>
              <div className="grid dense" style={{ padding: "8px 0 0" }}>
                {similar.map((s) => (
                  <div key={s.id} className="tile">
                    <button className="art" onClick={() => open(s, pool)} aria-label={`${s.artist} – ${s.title}`}><img src={s.thumb} alt="" className="loaded" /></button>
                    <div className="label"><strong>{s.title}</strong><span>{s.artist}</span></div>
                  </div>
                ))}
                {!similar.length && <p className="notes">Nothing close by. Dig a bigger crate first.</p>}
              </div>
            </>
          )}

          <h3>Tracks</h3>
          {error && <p className="notes">{error}</p>}
          {!detail && !error && <p className="notes">Reading the back of the sleeve…</p>}
          {detail && !detail.tracks.length && <p className="notes">Discogs has no tracklist for this one.</p>}
          {detail && detail.tracks.length > 0 && (
            <ol className="tracks">
              {detail.tracks.map((t, i) => (
                <TrackRow key={i} track={t} playing={playing?.id === t.youtube} onPlay={() => setPlaying(t.youtube ? { id: t.youtube, title: t.title } : null)} onAdd={() => addToPlaylist(record, t)} />
              ))}
            </ol>
          )}
          {detail && detail.tracks.length > 0 && !detail.tracks.some((t) => t.youtube) && (
            <p className="notes">{detail.videos.length ? "Discogs lists videos for this release but none match a track name. " : "No previews on Discogs for this release. "}Spotify previews arrive in phase 2.</p>
          )}
          {detail?.notes && (<><h3>Sleeve notes</h3><p className="notes">{detail.notes.replace(/\[.*?\]/g, "").slice(0, 900)}</p></>)}
        </div>
        {playing && (
          <div className="player">
            <iframe title={playing.title} src={`https://www.youtube-nocookie.com/embed/${playing.id}?autoplay=1&rel=0`} allow="autoplay; encrypted-media" />
            <div className="now">{playing.title}<small>Preview via YouTube, linked from Discogs</small></div>
            <button className="btn quiet" style={{ color: "inherit" }} onClick={() => setPlaying(null)}>Stop</button>
          </div>
        )}
      </aside>
    </>
  );
}

function TrackRow({ track, playing, onPlay, onAdd }: { track: Track; playing: boolean; onPlay: () => void; onAdd: () => void }) {
  return (
    <li>
      <span className="pos">{track.position}</span>
      <span>{track.title}</span>
      <span className="dur">{track.duration}</span>
      <span style={{ display: "flex", gap: 4 }}>
        <button className={`play ${playing ? "on" : ""}`} disabled={!track.youtube} onClick={onPlay} title={track.youtube ? "Preview" : "No preview"} aria-label="Preview">▶</button>
        <button className="add" onClick={onAdd}>+ set</button>
      </span>
    </li>
  );
}
