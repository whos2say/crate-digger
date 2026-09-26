import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, getPalette, loadPalette, paletteDistance, retryDelayMs, type Lyrics, type Record, type RecordDetail, type Sleeve, type Track } from "../api";
import { useShell } from "../App";
import { Art } from "./CoverGrid";

/** "3:42" → 222 seconds; returns 0 for unset. Used as a hint to LRCLIB. */
function durationToSec(s?: string): number {
  if (!s) return 0;
  const m = s.match(/^(\d+):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

export default function RecordSheet({ record }: { record: Record }) {
  const { close, addToTopTen, addToPlaylist, pool, open, status, play, nowPlaying, canPlay, playbackMs, playbackPaused } = useShell();
  const [detail, setDetail] = useState<RecordDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [similar, setSimilar] = useState<Record[] | null>(null);
  const [sleeve, setSleeve] = useState<Sleeve | null | "loading" | "none">(null);
  const [attempt, setAttempt] = useState(0);
  // Lyrics are per-track and lazy: one call the first time a track's lyrics are opened.
  // Cached in this sheet's state so toggling the panel doesn't refetch.
  const [lyricsById, setLyricsById] = useState<{ [key: string]: Lyrics | "loading" | "none" }>({});
  const [lyricsOpen, setLyricsOpen] = useState<{ [key: string]: boolean }>({});
  const navigate = useNavigate();
  const sleevesOn = !!status?.discogs.token;

  useEffect(() => {
    if (attempt === 0) { setDetail(null); setError(null); setSimilar(null); setSleeve(null); }
    let live = true;
    let timer: number | undefined;
    api.record(record.id).then((d) => live && setDetail(d)).catch((e) => {
      if (!live) return;
      const delay = retryDelayMs(e);
      if (delay && attempt < 3) { setError(`Busy — reading the tracklist again in ${Math.ceil(delay / 1000)}s…`); timer = window.setTimeout(() => setAttempt((n) => n + 1), delay); }
      else setError(e.message);
    });
    return () => { live = false; if (timer) window.clearTimeout(timer); };
  }, [record.id, attempt]);
  useEffect(() => { setAttempt(0); }, [record.id]);
  useEffect(() => { document.body.style.overflow = "hidden"; return () => { document.body.style.overflow = ""; }; }, []);

  const r = detail ?? record;
  const cover = detail?.cover || record.cover;

  const findSimilar = async () => {
    const me = getPalette(record) ?? (await loadPalette(record));
    if (!me) return;
    const candidates = pool.filter((p) => p.id !== record.id);
    // A few at a time: every cover is an image-proxy request, and a burst of 120 trips rate limits.
    const queue = candidates.slice(0, 60);
    await Promise.all(Array.from({ length: 6 }, async () => { for (let c = queue.shift(); c; c = queue.shift()) await loadPalette(c); }));
    const ranked = candidates
      .map((c) => ({ c, d: getPalette(c) ? paletteDistance(me, getPalette(c)!) : 9 }))
      .sort((a, b) => a.d - b.d).slice(0, 8).map((x) => x.c);
    setSimilar(ranked);
  };

  const readSleeve = async () => {
    setSleeve("loading");
    try { const s = await api.sleeve({ artist: record.artist.split(",")[0], title: record.title, year: record.year }); setSleeve(s ?? "none"); }
    catch (e) { setSleeve("none"); if (e instanceof Error) setError(e.message); }
  };

  const trackKey = (t: Track) => t.spotifyUri ?? `${t.position}:${t.title}`;

  const toggleLyrics = async (t: Track) => {
    const k = trackKey(t);
    setLyricsOpen((o) => ({ ...o, [k]: !o[k] }));
    if (lyricsById[k]) return; // fetch once
    setLyricsById((s) => ({ ...s, [k]: "loading" }));
    try {
      const l = await api.lyrics({
        artist: t.artist || detail?.artist || record.artist,
        title: t.title,
        album: detail?.title ?? record.title,
        durationSec: durationToSec(t.duration),
      });
      setLyricsById((s) => ({ ...s, [k]: l ?? "none" }));
    } catch { setLyricsById((s) => ({ ...s, [k]: "none" })); }
  };

  const browse = (params: { [k: string]: string }) => { close(); navigate("/?" + new URLSearchParams(params)); };
  const isPlaying = (t: Track) => !!t.spotifyUri && nowPlaying?.track.spotifyUri === t.spotifyUri;

  return (
    <>
      <div className="sheet-scrim" onClick={close} />
      <aside className="sheet" aria-label={`${r.artist} – ${r.title}`}>
        <div className="hero">
          <Art src={cover} fallback={record.thumb} alt={`${r.artist} – ${r.title} cover`} />
          <button className="close" onClick={close} aria-label="Close">×</button>
        </div>
        <div className="body">
          <h2>{r.title}</h2>
          <p className="artist">
            {record.artistId ? <Link to={`/artist/${record.artistId}`} onClick={close}>{r.artist}</Link> : r.artist}
          </p>
          <dl className="facts">
            {r.year && <><dt>Year</dt><dd>{r.year}</dd></>}
            {r.label && <><dt>Label</dt><dd><button className="linkish" onClick={() => browse({ label: r.label! })} style={{ textDecoration: "underline", textUnderlineOffset: 3 }}>{r.label}</button></dd></>}
            {record.kind && record.kind !== "album" && <><dt>Type</dt><dd style={{ textTransform: "capitalize" }}>{record.kind}</dd></>}
            {r.genres.length ? (
              <><dt>Sounds like</dt><dd className="tags">
                {r.genres.slice(0, 6).map((g) => <button key={g} onClick={() => browse({ genre: g })} style={{ textTransform: "capitalize" }}>{g}</button>)}
              </dd></>
            ) : null}
          </dl>
          <p className="via">via Spotify · <a href={r.url} target="_blank" rel="noopener">open the record</a></p>

          <div className="actions">
            <button className="btn primary" onClick={() => addToTopTen(record)}>Add to a Top Ten</button>
            <button className="btn" onClick={findSimilar} disabled={!pool.length}>More covers like this</button>
            {sleevesOn && sleeve === null && <button className="btn" onClick={readSleeve}>Read the sleeve</button>}
          </div>

          {sleeve === "loading" && <p className="notes">Looking this up on Discogs…</p>}
          {sleeve === "none" && <p className="notes">Discogs has no entry that matches this record.</p>}
          {sleeve && typeof sleeve === "object" && (
            <div className="sleeve">
              <h4>The back of the sleeve <small style={{ fontWeight: 400 }}>· via <a href={sleeve.url} target="_blank" rel="noopener">Discogs</a></small></h4>
              <dl>
                {sleeve.year && <><dt>Released</dt><dd>{sleeve.year}{sleeve.country ? `, ${sleeve.country}` : ""}</dd></>}
                {sleeve.label && <><dt>Label</dt><dd>{sleeve.label}{sleeve.catno ? ` · ${sleeve.catno}` : ""}</dd></>}
                {sleeve.formats?.length ? <><dt>Format</dt><dd>{sleeve.formats.join(" / ")}</dd></> : null}
                {(sleeve.genres.length || sleeve.styles.length) ? <><dt>Styles</dt><dd>{[...sleeve.genres, ...sleeve.styles].join(", ")}</dd></> : null}
              </dl>
              {sleeve.notes && <p>{sleeve.notes}</p>}
            </div>
          )}

          {similar && (
            <>
              <h3>Similar looking, from this crate</h3>
              <div className="grid dense" style={{ padding: "8px 0 0" }}>
                {similar.map((s) => (
                  <div key={s.id} className="tile">
                    <button className="art" onClick={() => open(s, pool)} aria-label={`${s.artist} – ${s.title}`}><Art src={s.thumb} alt="" className="loaded" /></button>
                    <div className="label"><strong>{s.title}</strong><span>{s.artist}</span></div>
                  </div>
                ))}
                {!similar.length && <p className="notes">Nothing close by. Dig a bigger crate first.</p>}
              </div>
            </>
          )}

          <h3>Tracks</h3>
          {error && <p className="notes">{error}</p>}
          {!detail && !error && <p className="notes">Reading the tracklist…</p>}
          {detail && !detail.tracks.length && <p className="notes">Spotify has no tracklist for this one.</p>}
          {detail && detail.tracks.length > 0 && (
            <ol className="tracks">
              {detail.tracks.map((t, i) => {
                const k = trackKey(t);
                const lyr = lyricsById[k];
                const open = !!lyricsOpen[k];
                return (
                  <li key={i} className={open ? "with-lyrics" : ""}>
                    <div className="row">
                      <span className="pos">{t.position}</span>
                      <span>{t.title}{t.artist && t.artist !== detail.artist && <small style={{ display: "block", opacity: 0.7 }}>{t.artist}</small>}</span>
                      <span className="dur">{t.duration}</span>
                      <span style={{ display: "flex", gap: 4 }}>
                        <button className={`play ${isPlaying(t) ? "on" : ""}`} onClick={() => play(record, t)} title={canPlay ? "Play" : "Open in Spotify"} aria-label="Play">▶</button>
                        <button className={`add ${open ? "on" : ""}`} onClick={() => toggleLyrics(t)} title="Show lyrics" aria-label="Lyrics" aria-expanded={open}>♪</button>
                        <button className="add" onClick={() => addToTopTen(record, t)} title="Add this track to a Top Ten">+ 10</button>
                        <button className="add" onClick={() => addToPlaylist(record, t)}>+ set</button>
                      </span>
                    </div>
                    {open && (
                      <LyricsPanel
                        lyrics={lyr}
                        // Only follow along when THIS track is the one currently playing.
                        positionMs={isPlaying(t) && !playbackPaused ? playbackMs : null}
                      />
                    )}
                  </li>
                );
              })}
            </ol>
          )}
          {detail && !canPlay && status?.spotify.connected && (
            <p className="notes">{status.spotify.user?.product === "premium" ? "Unlock the crate (top-right) to play full tracks here." : "Full playback needs Spotify Premium; ▶ opens the track in Spotify."}</p>
          )}
        </div>
      </aside>
    </>
  );
}

/** The per-track lyrics panel. Plain lyrics render as flowing text; synced lyrics render one line
 *  per row, with the current line highlighted from the player's position and auto-scrolled into
 *  view. `positionMs` is null unless THIS track is playing, so opening lyrics on any other track
 *  in the tracklist just shows the words without the ticker. */
function LyricsPanel({ lyrics, positionMs }: { lyrics: Lyrics | "loading" | "none" | undefined; positionMs: number | null }) {
  if (!lyrics || lyrics === "loading") return <div className="lyrics"><p className="notes">Looking this up on LRCLIB…</p></div>;
  if (lyrics === "none") return <div className="lyrics"><p className="notes">LRCLIB has no lyrics for this track.</p></div>;
  const activeIdx = useMemo(() => {
    if (!lyrics.synced?.length || positionMs === null) return -1;
    // Last line whose timestamp is ≤ current position. Binary search since lines are already sorted.
    let lo = 0, hi = lyrics.synced.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (lyrics.synced[mid].ms <= positionMs) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  }, [lyrics, positionMs]);
  const boxRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (activeIdx < 0 || !boxRef.current) return;
    const el = boxRef.current.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
    if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeIdx]);
  return (
    <div className="lyrics" ref={boxRef}>
      {lyrics.synced?.length ? (
        <ol className="lyric-lines">
          {lyrics.synced.map((line, i) => (
            <li key={i} data-idx={i} className={i === activeIdx ? "on" : ""}>{line.text || <span aria-hidden>♪</span>}</li>
          ))}
        </ol>
      ) : (
        <pre className="lyric-plain">{lyrics.plain}</pre>
      )}
      <p className="via">via <a href={lyrics.url ?? "https://lrclib.net"} target="_blank" rel="noopener">LRCLIB</a></p>
    </div>
  );
}
