import { useRef, useState } from "react";

// Pointer-based drag to reorder. Works with mouse and touch; no HTML5 DnD quirks.
export function useReorder<T>(items: T[], onChange: (next: T[]) => void) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [over, setOver] = useState<{ index: number; after: boolean } | null>(null);
  const containerRef = useRef<HTMLElement | null>(null);

  const onPointerDown = (index: number) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    setDragIndex(index);
    let last: { index: number; after: boolean } | null = null;
    const move = (ev: PointerEvent) => {
      const root = containerRef.current; if (!root) return;
      const nodes = Array.from(root.querySelectorAll<HTMLElement>("[data-slot]"));
      let best: { index: number; after: boolean } | null = null;
      for (const n of nodes) {
        const r = n.getBoundingClientRect();
        if (ev.clientX >= r.left - 12 && ev.clientX <= r.right + 12 && ev.clientY >= r.top - 12 && ev.clientY <= r.bottom + 12) {
          const idx = Number(n.dataset.slot);
          const horizontal = r.width < r.height * 2.5;
          const after = horizontal ? ev.clientX > r.left + r.width / 2 : ev.clientY > r.top + r.height / 2;
          best = { index: idx, after };
        }
      }
      last = best; setOver(best);
    };
    const up = () => {
      el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); el.removeEventListener("pointercancel", up);
      if (last && last.index !== index) {
        const next = items.slice();
        const [moved] = next.splice(index, 1);
        let to = last.index + (last.after ? 1 : 0);
        if (index < to) to -= 1;
        next.splice(to, 0, moved);
        onChange(next);
      }
      setDragIndex(null); setOver(null);
    };
    el.addEventListener("pointermove", move); el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
  };

  const classFor = (index: number) => [dragIndex === index ? "dragging" : "", over && over.index === index && dragIndex !== index ? (over.after ? "drop-after" : "drop-before") : ""].join(" ");
  return { containerRef, onPointerDown, classFor, dragging: dragIndex !== null };
}
