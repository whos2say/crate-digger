import { useEffect, useMemo, useRef } from "react";
import type { Lyrics } from "../api";

/** Shared per-track lyrics panel. Used by the record sheet, the artist wall's "Now playing" card,
 *  and the karaoke overlay's fallback view. Plain lyrics render as flowing text; synced lyrics
 *  render one line per row, with the current line highlighted from the player's position and
 *  auto-scrolled into view. When `onSeek` is set, clicking a synced line jumps playback there. */
export function LyricsPanel({ lyrics, positionMs, onSeek }: {
  lyrics: Lyrics | "loading" | "none" | undefined | null;
  /** Player position in ms when this track is currently playing; null otherwise. */
  positionMs: number | null;
  onSeek?: (ms: number) => void;
}) {
  if (!lyrics || lyrics === "loading") return <div className="lyrics"><p className="notes">Looking this up on LRCLIB…</p></div>;
  if (lyrics === "none") return <div className="lyrics"><p className="notes">LRCLIB has no lyrics for this track.</p></div>;
  const activeIdx = useMemo(() => {
    if (!lyrics.synced?.length || positionMs === null) return -1;
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
            <li key={i} data-idx={i} className={`${i === activeIdx ? "on" : ""} ${onSeek ? "seek" : ""}`}
                onClick={onSeek ? () => onSeek(line.ms) : undefined}
                title={onSeek ? "Jump to this line" : undefined}>
              {line.text || <span aria-hidden>♪</span>}
            </li>
          ))}
        </ol>
      ) : (
        <pre className="lyric-plain">{lyrics.plain}</pre>
      )}
      <p className="via">via <a href={lyrics.url ?? "https://lrclib.net"} target="_blank" rel="noopener">LRCLIB</a></p>
    </div>
  );
}
