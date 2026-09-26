import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getOwnerKey, type Record, type Status, type Track } from "../api";
import { connectPlayer, onPlayerState, pausePlayer, playUri, resumePlayer } from "../lib/spotify";
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

  // Tick the position while playing so the bar moves between SDK state events.
  useEffect(() => {
    if (paused || !now) return;
    const t = window.setInterval(() => setPosition((p) => Math.min(duration || p + 1000, p + 1000)), 1000);
    return () => window.clearInterval(t);
  }, [paused, now, duration]);

  return useMemo(() => ({ now, paused, position, duration, canPlay, play, toggle, stop, connecting }), [now, paused, position, duration, canPlay, play, toggle, stop, connecting]);
}

const fmt = (n: number) => `${Math.floor(n / 60000)}:${String(Math.floor((n % 60000) / 1000)).padStart(2, "0")}`;

export default function Player({ playback }: { playback: Playback }) {
  const { now, paused, position, duration, toggle, stop, connecting } = playback;
  if (!now) return null;
  const pct = duration ? Math.min(100, (position / duration) * 100) : 0;
  return (
    <div className="now-playing" role="region" aria-label="Now playing">
      <Art src={now.record.thumb || now.record.cover} alt="" />
      <div className="np-text">
        <strong>{now.track.title}</strong>
        <span>{now.track.artist || now.record.artist} — {now.record.title}</span>
        <div className="np-bar" aria-hidden="true"><i style={{ width: `${pct}%` }} /></div>
      </div>
      <span className="np-time">{connecting ? "starting…" : `${fmt(position)} / ${fmt(duration)}`}</span>
      <button className="np-btn" onClick={toggle} aria-label={paused ? "Play" : "Pause"}>{paused ? "▶" : "❚❚"}</button>
      <button className="np-btn quiet" onClick={stop} aria-label="Stop">✕</button>
    </div>
  );
}
