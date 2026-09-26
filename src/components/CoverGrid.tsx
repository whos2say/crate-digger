import { useState, type ReactNode, type ImgHTMLAttributes } from "react";
import { directImage, proxiedImage, type Record } from "../api";
import { useShell } from "../App";

/** A cover image: straight from the CDN first, the worker's proxy if the CDN refuses, then the thumb. */
export function Art({ src, fallback, onSettled, ...rest }: { src: string; fallback?: string; onSettled?: () => void } & Omit<ImgHTMLAttributes<HTMLImageElement>, "src">) {
  const [stage, setStage] = useState(0);
  const candidates = [directImage(src), proxiedImage(src), ...(fallback ? [directImage(fallback), proxiedImage(fallback)] : [])].filter((u, i, a) => u && a.indexOf(u) === i);
  const current = candidates[Math.min(stage, candidates.length - 1)];
  return (
    <img
      {...rest}
      src={current}
      referrerPolicy="no-referrer"
      onLoad={(e) => { onSettled?.(); rest.onLoad?.(e); }}
      onError={(e) => { if (stage < candidates.length - 1) setStage(stage + 1); else { onSettled?.(); rest.onError?.(e); } }}
    />
  );
}

export function Cover({ record, onClick, rank, className, children }: { record: Record; onClick?: () => void; rank?: number; className?: string; children?: ReactNode }) {
  const [loaded, setLoaded] = useState(false);
  const { openRecord } = useShell();
  return (
    <div className={`tile ${openRecord?.id === record.id ? "open" : ""} ${className ?? ""}`}>
      <button className="art" onClick={onClick} aria-label={`${record.artist} – ${record.title}`}>
        <Art src={record.cover} fallback={record.thumb} alt="" loading="lazy" decoding="async" className={loaded ? "loaded" : ""} onSettled={() => setLoaded(true)} />
      </button>
      {rank !== undefined && <span className="rank" aria-hidden="true">{rank}</span>}
      <div className="label">
        <strong>{record.title}</strong>
        <span>{record.artist}{record.year ? ` · ${record.year}` : ""}</span>
      </div>
      {children}
    </div>
  );
}

export default function CoverGrid({ records, dense }: { records: Record[]; dense?: boolean }) {
  const { open } = useShell();
  return (
    <div className={`grid ${dense ? "dense" : ""}`}>
      {records.map((r) => <Cover key={r.id} record={r} onClick={() => open(r, records)} />)}
    </div>
  );
}
