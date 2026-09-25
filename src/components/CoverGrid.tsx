import { useEffect, useState, type ReactNode } from "react";
import { loadPalette, type Record } from "../api";
import { useShell } from "../App";

export function Cover({ record, onClick, rank, className, children }: { record: Record; onClick?: () => void; rank?: number; className?: string; children?: ReactNode }) {
  const [loaded, setLoaded] = useState(false);
  const { openRecord } = useShell();
  useEffect(() => { loadPalette(record); }, [record]);
  return (
    <div className={`tile ${openRecord?.id === record.id ? "open" : ""} ${className ?? ""}`}>
      <button className="art" onClick={onClick} aria-label={`${record.artist} – ${record.title}`}>
        <img src={record.cover} alt="" loading="lazy" decoding="async" className={loaded ? "loaded" : ""} onLoad={() => setLoaded(true)} onError={(e) => { const img = e.currentTarget; if (img.src !== record.thumb && record.thumb) img.src = record.thumb; setLoaded(true); }} />
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
