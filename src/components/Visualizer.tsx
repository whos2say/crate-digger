import { useEffect, useRef, useState } from "react";
import { api, type AudioBeats, type Lyrics, type Track } from "../api";

/** Fetch beat data for the current track and cache it. Returns null when Spotify's audio-analysis
 *  endpoint is unavailable (403 on modern client-credentials tokens), so the visualizer can fall
 *  back to lyric-line timings. */
export function useBeats(trackUri: string | undefined): AudioBeats | null {
  const [beats, setBeats] = useState<AudioBeats | null>(null);
  useEffect(() => {
    if (!trackUri) { setBeats(null); return; }
    const id = trackUri.split(":").pop()!;
    let live = true;
    api.beats(id).then((b) => { if (live) setBeats(b); }).catch(() => { if (live) setBeats(null); });
    return () => { live = false; };
  }, [trackUri]);
  return beats;
}

export type VisualStyle = "pulse" | "waveform" | "particles" | "orbit";

/** One <canvas> that animates to the beat. Four styles:
 *   - pulse: expanding rings on every beat, colored by the current section's tempo
 *   - waveform: a rolling sine whose amplitude spikes on beats
 *   - particles: a swarm that bursts outward on every beat
 *   - orbit: dots circling around the album cover, spinning faster on louder sections
 *  When `beats` is null (no audio-analysis), synced lyric line timestamps drive the pulses so it
 *  still looks alive.
 */
export default function Visualizer({ style, playbackMs, paused, beats, lyrics, coverUrl }: {
  style: VisualStyle;
  playbackMs: number;
  paused: boolean;
  beats: AudioBeats | null;
  lyrics: Lyrics | "loading" | null;
  coverUrl?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number>();
  const stateRef = useRef({ lastBeatIdx: -1, pulses: [] as { t: number; strength: number }[], particles: [] as { x: number; y: number; vx: number; vy: number; life: number }[], phase: 0 });
  const posRef = useRef({ playbackMs, paused, startedAt: performance.now() });
  useEffect(() => { posRef.current = { playbackMs, paused, startedAt: performance.now() }; }, [playbackMs, paused]);
  const coverRef = useRef<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!coverUrl) { coverRef.current = null; return; }
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => { coverRef.current = img; };
    img.src = coverUrl;
  }, [coverUrl]);

  // Beat sources: prefer audio-analysis; else synthesize from synced lyric lines at 500ms apart.
  const beatSource: number[] = beats?.beats?.length
    ? beats.beats
    : (lyrics && lyrics !== "loading" && lyrics.synced?.length ? lyrics.synced.flatMap((l) => [l.ms, l.ms + 500, l.ms + 1000]) : []);
  const beatsRef = useRef<number[]>(beatSource);
  useEffect(() => { beatsRef.current = beatSource; stateRef.current.lastBeatIdx = -1; }, [beatSource.length, beats, lyrics]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const cvs = canvasRef.current;
    if (!cvs) return;
    const ctx = cvs.getContext("2d")!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    const resize = () => {
      const rect = cvs.getBoundingClientRect();
      cvs.width = Math.floor(rect.width * dpr); cvs.height = Math.floor(rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize); ro.observe(cvs);

    const frame = () => {
      const { playbackMs: base, paused: pz, startedAt } = posRef.current;
      const elapsed = pz ? 0 : (performance.now() - startedAt);
      const now = base + elapsed;
      const rect = cvs.getBoundingClientRect();
      const w = rect.width, h = rect.height;
      ctx.clearRect(0, 0, w, h);

      // Detect any beats that happened since the last frame.
      const s = stateRef.current;
      while (s.lastBeatIdx + 1 < beatsRef.current.length && beatsRef.current[s.lastBeatIdx + 1] <= now) {
        s.lastBeatIdx++;
        s.pulses.push({ t: now, strength: 1 });
        if (style === "particles") {
          const cx = w / 2, cy = h / 2;
          for (let i = 0; i < 24; i++) { const a = (i / 24) * Math.PI * 2; const speed = 2 + Math.random() * 3; s.particles.push({ x: cx, y: cy, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, life: 1 }); }
        }
      }
      s.pulses = s.pulses.filter((p) => now - p.t < 1500);
      s.particles = s.particles.filter((p) => p.life > 0);
      s.phase += 0.04;

      // Palette from the current section's tempo/loudness, or a warm default.
      const section = (beats?.sections ? [...beats.sections].reverse().find((sec) => sec.start <= now) : undefined);
      const tempo = section?.tempo ?? beats?.tempo ?? 120;
      const loud = section?.loudness ?? -12;
      const hue = ((tempo - 60) * 4) % 360;
      const bright = Math.max(0.25, Math.min(0.7, 0.5 + (loud + 20) * 0.02));

      if (style === "pulse") {
        const cx = w / 2, cy = h / 2;
        // Background wash
        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.hypot(w, h) / 2);
        grad.addColorStop(0, `hsla(${hue}, 60%, ${bright * 100}%, 0.15)`);
        grad.addColorStop(1, `hsla(${(hue + 40) % 360}, 40%, 8%, 0)`);
        ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h);
        for (const p of s.pulses) {
          const age = (now - p.t) / 1500; // 0..1
          const r = 30 + age * Math.min(w, h) * 0.6;
          const alpha = (1 - age) * 0.6;
          ctx.strokeStyle = `hsla(${hue}, 70%, ${bright * 100}%, ${alpha})`;
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
        }
      } else if (style === "waveform") {
        const spike = s.pulses.length ? Math.max(...s.pulses.map((p) => Math.max(0, 1 - (now - p.t) / 500))) : 0;
        const amp = h * 0.15 * (0.5 + spike);
        ctx.strokeStyle = `hsla(${hue}, 70%, ${bright * 100}%, 0.85)`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let x = 0; x <= w; x += 3) {
          const y = h / 2 + Math.sin((x / w) * Math.PI * 8 + s.phase * 3) * amp * (0.6 + Math.sin((x / w) * Math.PI * 2 + s.phase) * 0.4);
          x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
      } else if (style === "particles") {
        for (const p of s.particles) {
          p.x += p.vx; p.y += p.vy; p.vx *= 0.98; p.vy *= 0.98; p.life -= 0.015;
          const alpha = Math.max(0, p.life);
          ctx.fillStyle = `hsla(${hue}, 80%, ${bright * 100}%, ${alpha})`;
          ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill();
        }
      } else if (style === "orbit") {
        const cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.35;
        if (coverRef.current) {
          const size = R * 1.4, pulse = s.pulses[s.pulses.length - 1];
          const scale = pulse ? 1 + Math.max(0, 1 - (now - pulse.t) / 400) * 0.08 : 1;
          ctx.save(); ctx.translate(cx, cy); ctx.rotate(s.phase * 0.05); ctx.globalAlpha = 0.85;
          ctx.drawImage(coverRef.current, -size / 2 * scale, -size / 2 * scale, size * scale, size * scale);
          ctx.restore();
        }
        const speed = (tempo / 120) * 0.02;
        for (let i = 0; i < 40; i++) {
          const a = (i / 40) * Math.PI * 2 + s.phase * speed;
          const rr = R + Math.sin(s.phase * 2 + i) * 20;
          const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
          ctx.fillStyle = `hsla(${(hue + i * 8) % 360}, 80%, ${bright * 100}%, 0.7)`;
          ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
        }
      }
      rafRef.current = requestAnimationFrame(frame);
    };
    rafRef.current = requestAnimationFrame(frame);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); ro.disconnect(); };
  }, [style, beats]);

  return <canvas ref={canvasRef} className="visualizer-canvas" aria-hidden="true" />;
}
