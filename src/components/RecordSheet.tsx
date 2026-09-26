import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, getOwnerKey, getPalette, loadPalette, paletteDistance, retryDelayMs, type Record, type RecordDetail, type Track } from "../api";
import { useShell } from "../App";
import { pausePlayer, playUri } from "../lib/spotify";
import { Art } from "./CoverGrid";

type Playing =
  | { lane: "youtube"; id: string; title: string }
  | { lane: "preview"; url: string; title: string; link?: string }
  | { lane: "sdk"; uri: string; title: string; link?: string };

export default function RecordSheet({ record }: { record: Record }) {
  const { close, addToTopTen, addToPlaylist, pool, open, status, toast } = useShell();
  const [detail, setDetail] = useState<RecordDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState<Playing | null>(null);
  const [similar, setSimilar] = useState<Record[] | null>(null);
  const [matching, setMatching] = useState(false);
  const navigate = useNavigate();
  const spotifyOn = !!status?.spotify.connected;
  // Full tracks need the connected account to be Premium and this browser to hold the owner key.
  const premium = spotifyOn && status?.spotify.user?.product === "premium" && (!!getOwnerKey() || !status?.ownerKeySet);

  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (attempt === 0) { setDetail(null); setError(null); setPlaying(null); setSimilar(null); }
    let live = true;
    let timer: number | undefined;
    api.record(record.id).then((d) => live && setDetail(d)).catch((e) => {
      if (!live) return;
      const delay = retryDelayMs(e);
      if (delay && attempt < 3) { setError(`Busy — reading the sleeve again in ${Math.ceil(delay / 1000)}s…`); timer = window.setTimeout(() => setAttempt((n) => n + 1), delay); }
      else setError(e.message);
    });
    return () => { live = false; if (timer) window.clearTimeout(timer); if (attempt === 0) pausePlayer(); };
  }, [record.id, attempt]);
  useEffect(() => { setAttempt(0); }, [record.id]);

  // With Spotify connected, look each track up (a few at a time) so the play buttons light up.
  const matchedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!detail || !spotifyOn || matchedFor.current === detail.id || !detail.tracks.length) return;
    matchedFor.current = detail.id;
    let live = true;
    setMatching(true);
    const queue = detail.tracks.map((t, i) => ({ t, i })).filter(({ t }) => !t.spotifyUri);
    const worker = async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        try {
          const m = await api.spotifyMatch({ title: job.t.title, artist: detail.artist, album: detail.title, duration: job.t.duration });
          if (!live) return;
          if (m) setDetail((cur) => cur && cur.id === detail.id ? { ...cur, tracks: cur.tracks.map((x, j) => (j === job!.i ? { ...x, spotifyUri: m.uri, spotifyUrl: m.url, previewUrl: m.previewUrl } : x)) } : cur);
        } catch { /* leave the row as it was */ }
      }
    };
    Promise.all([worker(), worker(), worker()]).finally(() => live && setMatching(false));
    return () => { live = false; };
  }, [detail, spotifyOn]);

  const play = async (t: Track) => {
    if (premium && t.spotifyUri) {
      setPlaying({ lane: "sdk", uri: t.spotifyUri, title: t.title, link: t.spotifyUrl });
      try { await playUri(t.spotifyUri); }
      catch (e) {
        // Premium playback failed (no device, SDK blocked): fall back to whatever preview exists.
        if (t.previewUrl) setPlaying({ lane: "preview", url: t.previewUrl, title: t.title, link: t.spotifyUrl });
        else if (t.youtube) setPlaying({ lane: "youtube", id: t.youtube, title: t.title });
        else { setPlaying(null); toast(e instanceof Error ? e.message : "Could not play"); }
      }
      return;
    }
    pausePlayer();
    if (t.previewUrl) setPlaying({ lane: "preview", url: t.previewUrl, title: t.title, link: t.spotifyUrl });
    else if (t.youtube) setPlaying({ lane: "youtube", id: t.youtube, title: t.title });
  };
  const stop = () => { pausePlayer(); setPlaying(null); };
  const isPlaying = (t: Track) => !!playing && (
    (playing.lane === "sdk" && playing.uri === t.spotifyUri) ||
    (playing.lane === "preview" && playing.url === t.previewUrl) ||
    (playing.lane === "youtube" && playing.id === t.youtube));

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

  const browse = (params: { [k: string]: string }) => { close(); navigate("/?" + new URLSearchParams(params)); };

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
                    <button className="art" onClick={() => open(s, pool)} aria-label={`${s.artist} – ${s.title}`}><Art src={s.thumb} alt="" className="loaded" /></button>
                    <div className="label"><strong>{s.title}</strong><span>{s.artist}</span></div>
                  </div>
                ))}
                {!similar.length && <p className="notes">Nothing close by. Dig a bigger crate first.</p>}
              </div>
            </>
          )}

          <h3>Tracks{spotifyOn && matching ? <small className="via" style={{ marginLeft: 8 }}>matching on Spotify…</small> : null}</h3>
          {error && <p className="notes">{error}</p>}
          {!detail && !error && <p className="notes">Reading the back of the sleeve…</p>}
          {detail && !detail.tracks.length && <p className="notes">Discogs has no tracklist for this one.</p>}
          {detail && detail.tracks.length > 0 && (
            <ol className="tracks">
              {detail.tracks.map((t, i) => (
                <TrackRow key={i} track={t} playing={isPlaying(t)} premium={premium} onPlay={() => play(t)} onAdd={() => addToPlaylist(record, t)} />
              ))}
            </ol>
          )}
          {detail && detail.tracks.length > 0 && !matching && !detail.tracks.some((t) => t.youtube || t.previewUrl || (premium && t.spotifyUri)) && (
            <p className="notes">{detail.videos.length ? "Discogs lists videos for this release but none match a track name. " : "No previews on Discogs for this release. "}{spotifyOn ? "Spotify has no previews for these either." : "Connect Spotify (top-right) for previews."}</p>
          )}
          {detail?.notes && (<><h3>Sleeve notes</h3><p className="notes">{detail.notes.replace(/\[.*?\]/g, "").slice(0, 900)}</p></>)}
        </div>
        {playing && (
          <div className="player">
            {playing.lane === "youtube" && <iframe title={playing.title} src={`https://www.youtube-nocookie.com/embed/${playing.id}?autoplay=1&rel=0`} allow="autoplay; encrypted-media" />}
            {playing.lane === "preview" && <audio src={playing.url} autoPlay controls onEnded={() => setPlaying(null)} style={{ height: 32, maxWidth: 220 }} />}
            {playing.lane === "sdk" && <span className="sp-dot" aria-hidden="true" />}
            <div className="now">
              {playing.title}
              <small>
                {playing.lane === "youtube" && "Preview via YouTube, linked from Discogs"}
                {playing.lane === "preview" && "30-second preview via Spotify"}
                {playing.lane === "sdk" && "Playing in full via Spotify Premium"}
                {playing.lane !== "youtube" && playing.link && <> · <a href={playing.link} target="_blank" rel="noopener">open in Spotify</a></>}
              </small>
            </div>
            <button className="btn quiet" style={{ color: "inherit" }} onClick={stop}>Stop</button>
          </div>
        )}
      </aside>
    </>
  );
}

function TrackRow({ track, playing, premium, onPlay, onAdd }: { track: Track; playing: boolean; premium: boolean; onPlay: () => void; onAdd: () => void }) {
  const can = !!(track.previewUrl || track.youtube || (premium && track.spotifyUri));
  const how = premium && track.spotifyUri ? "Play in full via Spotify" : track.previewUrl ? "30-second Spotify preview" : track.youtube ? "Preview via YouTube" : "No preview";
  return (
    <li>
      <span className="pos">{track.position}</span>
      <span>{track.title}{track.spotifyUri && <small className="sp-tag" title="Matched on Spotify">via Spotify</small>}</span>
      <span className="dur">{track.duration}</span>
      <span style={{ display: "flex", gap: 4 }}>
        <button className={`play ${playing ? "on" : ""}`} disabled={!can} onClick={onPlay} title={how} aria-label={how}>▶</button>
        <button className="add" onClick={onAdd}>+ set</button>
      </span>
    </li>
  );
}
