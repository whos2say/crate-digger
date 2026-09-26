import { useEffect, useMemo, useState } from "react";
import { api, type Lyrics, type Track } from "../api";

/** Fetch and cache lyrics for the currently playing track. Returns "loading" while fetching,
 *  the Lyrics object on hit, or null on miss. Auto-refetches when the track changes. */
export function useNowPlayingLyrics(now: { track: Track; albumTitle?: string } | null): Lyrics | "loading" | null {
  const [lyrics, setLyrics] = useState<Lyrics | "loading" | null>(null);
  const key = now?.track.spotifyUri ?? "";
  useEffect(() => {
    if (!now) { setLyrics(null); return; }
    setLyrics("loading");
    let live = true;
    api.lyrics({
      artist: now.track.artist ?? "",
      title: now.track.title,
      album: now.albumTitle,
      durationSec: durationToSec(now.track.duration),
    }).then((l) => { if (live) setLyrics(l ?? null); }).catch(() => { if (live) setLyrics(null); });
    return () => { live = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return lyrics;
}

function durationToSec(s?: string): number {
  if (!s) return 0;
  const m = s.match(/^(\d+):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

/** A three-line karaoke strip: previous line dimmed, current line big and centered, next line
 *  dimmed. Renders nothing when the current track has no synced lyrics. */
export function KaraokeStrip({ lyrics, positionMs, onSeek }: {
  lyrics: Lyrics | "loading" | null;
  positionMs: number;
  onSeek?: (ms: number) => void;
}) {
  const active = useMemo(() => {
    if (!lyrics || lyrics === "loading" || !lyrics.synced?.length) return -1;
    let lo = 0, hi = lyrics.synced.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (lyrics.synced[mid].ms <= positionMs) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  }, [lyrics, positionMs]);
  if (!lyrics || lyrics === "loading" || !lyrics.synced?.length) return null;
  const prev = active > 0 ? lyrics.synced[active - 1] : null;
  const curr = active >= 0 ? lyrics.synced[active] : { ms: 0, text: "" };
  const next = active + 1 < lyrics.synced.length ? lyrics.synced[active + 1] : null;
  return (
    <div className="karaoke" role="region" aria-label="Karaoke lyrics">
      <button className="karaoke-line prev" onClick={prev && onSeek ? () => onSeek(prev.ms) : undefined} disabled={!prev}>{prev?.text ?? ""}</button>
      <button className="karaoke-line curr" onClick={onSeek ? () => onSeek(curr.ms) : undefined}>{curr.text || <span aria-hidden>♪</span>}</button>
      <button className="karaoke-line next" onClick={next && onSeek ? () => onSeek(next.ms) : undefined} disabled={!next}>{next?.text ?? ""}</button>
    </div>
  );
}
