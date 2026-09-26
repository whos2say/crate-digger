import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getOwnerKey, type Record, type Status, type Track } from "../api";
import { connectPlayer, onPlayerState, pausePlayer, playUri, resumePlayer, seekPlayer } from "../lib/spotify";
import { Art } from "./CoverGrid";

export interface Playback {
  now: { record: Record; track: Track } | null;
  paused: boolean;
  position: number;
  duration: number;
  canPlay: boolean;
  play: (record: Record, track: Track) => void;
  toggle: () => void;
  stop: () => void;
  seek: (ms: number) => void;
  /** True during the moment between play() being called and the SDK signalling ready. */
  connecting: boolean;
}

/** One player for the whole app. Full tracks need Spotify Premium and the owner key in this browser. */
export function usePlayback(status: Status | null, toast: (m: string) => void): Playback {
  const [now, setNow] = useState<{ record: Record; track: Track } | null>(null);
  const [paused, setPaused] = useState(true);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [connecting, setConnecting] = useState(false);
  const wired = useRef(false);
  const canPlay = !!status?.spotify.connected && status.spotify.user?.product === "premium" && (!!getOwnerKey() || !status.ownerKeySet);

  const play = useCallback(async (record: Record, track: Track) => {
    if (!track.spotifyUri) { toast("That track isn't on Spotify"); return; }
    if (!canPlay) { window.open(track.spotifyUrl ?? record.url, "_blank", "noopener"); return; }
    setNow({ record, track }); setPaused(false); setPosition(0);
    try {
      setConnecting(true);
      await connectPlayer();
      if (!wired.current) {
        wired.current = true;
        onPlayerState((s) => { setPaused(s.paused); setPosition(s.position); setDuration(s.duration); });
      }
      await playUri(track.spotifyUri);
    } catch (e) {
      setNow(null);
      toast(e instanceof Error ? e.message : "Could not play");
      window.open(track.spotifyUrl ?? record.url, "_blank", "noopener");
    } finally { setConnecting(false); }
  }, [canPlay, toast]);

  const toggle = useCallback(() => { if (paused) resumePlayer(); else pausePlayer(); }, [paused]);
  const stop = useCallback(() => { pausePlayer(); setNow(null); }, []);
  const seek = useCallback((ms: number) => { seekPlayer(ms); setPosition(ms); }, []);

  // Tick the position while playing so the bar moves between SDK state events.
  useEffect(() => {
    if (paused || !now) return;
    const t = window.setInterval(() => setPosition((p) => Math.min(duration || p + 1000, p + 1000)), 1000);
    return () => window.clearInterval(t);
  }, [paused, now, duration]);

  return useMemo(() => ({ now, paused, position, duration, canPlay, play, toggle, stop, seek, connecting }), [now, paused, position, duration, canPlay, play, toggle, stop, seek, connecting]);
}

import { KaraokeStrip, useNowPlayingLyrics } from "./Karaoke";
import Visualizer, { useBeats, type VisualStyle } from "./Visualizer";

const fmt = (n: number) => `${Math.floor(n / 60000)}:${String(Math.floor((n % 60000) / 1000)).padStart(2, "0")}`;

const VISUAL_STYLES: VisualStyle[] = ["pulse", "waveform", "particles", "orbit"];

export default function Player({ playback }: { playback: Playback }) {
  const { now, paused, position, duration, toggle, stop, seek, connecting } = playback;
  const [karaokeOn, setKaraokeOn] = useState(false);
  const [visStyle, setVisStyle] = useState<VisualStyle | null>(null);
  const lyrics = useNowPlayingLyrics(now ? { track: now.track, albumTitle: now.record.title } : null);
  const beats = useBeats(now?.track.spotifyUri);
  if (!now) return null;
  const pct = duration ? Math.min(100, (position / duration) * 100) : 0;
  const hasSynced = !!(lyrics && lyrics !== "loading" && lyrics.synced?.length);

  const scrub = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    seek(Math.max(0, Math.min(duration, ((e.clientX - rect.left) / rect.width) * duration)));
  };

  // Visualizer cycles: none → pulse → waveform → particles → orbit → none.
  const nextStyle = () => setVisStyle((s) => {
    if (s === null) return VISUAL_STYLES[0];
    const i = VISUAL_STYLES.indexOf(s);
    return i === VISUAL_STYLES.length - 1 ? null : VISUAL_STYLES[i + 1];
  });

  return (
    <>
      {visStyle && (
        <div className="visualizer" role="region" aria-label="Music visualizer">
          <Visualizer
            style={visStyle}
            playbackMs={position}
            paused={paused}
            beats={beats}
            lyrics={lyrics}
            coverUrl={now.record.cover || now.record.thumb}
          />
        </div>
      )}
      {karaokeOn && hasSynced && <KaraokeStrip lyrics={lyrics} positionMs={position} onSeek={seek} />}
      <div className="now-playing" role="region" aria-label="Now playing">
        <Art src={now.record.thumb || now.record.cover} alt="" />
        <div className="np-text">
          <strong>{now.track.title}</strong>
          <span>{now.track.artist || now.record.artist} — {now.record.title}</span>
          <div className="np-bar" onClick={scrub} role="slider" aria-label="Seek" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} tabIndex={0}>
            <i style={{ width: `${pct}%` }} />
          </div>
        </div>
        <span className="np-time">{connecting ? "starting…" : `${fmt(position)} / ${fmt(duration)}`}</span>
        <button
          className={`np-btn quiet ${karaokeOn ? "on" : ""}`}
          onClick={() => setKaraokeOn((k) => !k)}
          disabled={!hasSynced}
          title={hasSynced ? (karaokeOn ? "Hide karaoke" : "Karaoke mode") : "No synced lyrics for this track"}
          aria-label="Toggle karaoke"
        >
          ♪
        </button>
        <button
          className={`np-btn quiet ${visStyle ? "on" : ""}`}
          onClick={nextStyle}
          title={visStyle ? `Visualizer: ${visStyle} — click for next` : "Turn on visualizer"}
          aria-label="Cycle visualizer"
        >
          ◐
        </button>
        <button className="np-btn" onClick={toggle} aria-label={paused ? "Play" : "Pause"}>{paused ? "▶" : "❚❚"}</button>
        <button className="np-btn quiet" onClick={stop} aria-label="Stop">✕</button>
      </div>
    </>
  );
}
