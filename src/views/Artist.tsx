import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, retryDelayMs, type ArtistDetail } from "../api";
import { useShell } from "../App";
import CoverGrid, { Art } from "../components/CoverGrid";
import { LyricsPanel } from "../components/LyricsPanel";
import { useNowPlayingLyrics } from "../components/Karaoke";

const compact = (n?: number) => (n === undefined ? "" : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n));

export default function Artist() {
  const { id } = useParams();
  const { play, nowPlaying, canPlay, addToTopTen, addToPlaylist, addAllToPlaylist, open, playbackMs, playbackPaused, seek } = useShell();
  const [artist, setArtist] = useState<ArtistDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const nowLyrics = useNowPlayingLyrics(nowPlaying ? { track: nowPlaying.track, albumTitle: nowPlaying.record.title } : null);

  useEffect(() => {
    if (attempt === 0) { setArtist(null); setError(null); }
    let timer: number | undefined;
    let live = true;
    api.artist(id!).then((a) => live && setArtist(a)).catch((e) => {
      if (!live) return;
      const delay = retryDelayMs(e);
      if (delay && attempt < 3) { setError(`Spotify is busy. Trying again in ${Math.ceil(delay / 1000)}s…`); timer = window.setTimeout(() => setAttempt((n) => n + 1), delay); }
      else setError(e.message);
    });
    return () => { live = false; if (timer) window.clearTimeout(timer); };
  }, [id, attempt]);
  useEffect(() => { setAttempt(0); }, [id]);

  if (error && !artist) return <div className="notice error"><h3>Couldn’t load this artist</h3><p>{error}</p></div>;
  if (!artist) return <div className="hint" style={{ paddingTop: 40 }}>Pulling their records…</div>;

  const pool = artist.records;
  return (
    <>
      {nowPlaying && (
        <section className="now-playing-panel">
          <header>
            <Art src={nowPlaying.record.thumb || nowPlaying.record.cover} alt="" />
            <div>
              <strong>Now playing</strong>
              <span>{nowPlaying.track.title} — {nowPlaying.track.artist || nowPlaying.record.artist}</span>
            </div>
            <button className="btn" onClick={() => setLyricsOpen((o) => !o)} aria-expanded={lyricsOpen}>
              {lyricsOpen ? "Hide lyrics" : "Show lyrics"}
            </button>
          </header>
          {lyricsOpen && (
            <LyricsPanel
              lyrics={nowLyrics === null ? "none" : nowLyrics}
              positionMs={playbackPaused ? null : playbackMs}
              onSeek={seek}
            />
          )}
        </section>
      )}

      <section className="artist-hero">
        {artist.image && <div className="bg" style={{ backgroundImage: `url("${artist.image}")` }} aria-hidden="true" />}
        <div className="inner">
          {artist.image && <Art className="portrait" src={artist.image} alt={artist.name} />}
          <div>
            <h1>{artist.name}</h1>
            <div className="meta">
              {artist.followers !== undefined && <span>{compact(artist.followers)} followers</span>}
              <span>{artist.records.length} records</span>
              {artist.genres.slice(0, 5).map((g) => <span key={g} className="genre">{g}</span>)}
              <a href={artist.url} target="_blank" rel="noopener" style={{ color: "inherit" }}>open in Spotify</a>
            </div>
          </div>
        </div>
      </section>

      {artist.topTracks.length > 0 && (
        <section className="top-tracks">
          <h2>Top tracks</h2>
          <ol>
            {artist.topTracks.map(({ track, record }, i) => {
              const on = nowPlaying?.track.spotifyUri === track.spotifyUri;
              return (
                <li key={track.spotifyUri ?? i}>
                  <span className="n">{i + 1}</span>
                  <button style={{ padding: 0, border: 0, background: "none", cursor: "pointer" }} onClick={() => open(record, pool)} aria-label={record.title}><Art src={record.thumb} alt="" /></button>
                  <div className="t"><strong>{track.title}</strong><span>{record.title}{record.year ? ` · ${record.year}` : ""}</span></div>
                  <div className="acts">
                    <button className={`play ${on ? "on" : ""}`} onClick={() => play(record, track)} title={canPlay ? "Play" : "Open in Spotify"} aria-label="Play">▶</button>
                    <button className="add" onClick={() => addToTopTen(record, track)}>+ top ten</button>
                    <button className="add" onClick={() => addToPlaylist(record, track)}>+ set</button>
                  </div>
                </li>
              );
            })}
          </ol>
          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            <button className="btn" onClick={() => addAllToPlaylist(artist.topTracks)}>Add all top tracks to a set</button>
          </div>
        </section>
      )}

      <section className="artist-albums">
        <h2>Records</h2>
        {artist.records.length ? <CoverGrid records={artist.records} /> : <p className="hint">Spotify lists no albums with covers for this artist.</p>}
      </section>
    </>
  );
}
