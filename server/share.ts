// Public Top Ten page. Rendered on the server so link previews (iMessage, Slack, X) see the
// title, blurb and the #1 cover as og:image without running any JavaScript.

import type { TopTen } from "./types";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

export function renderShare(list: TopTen, origin: string): string {
  const url = `${origin}/s/${list.slug}`;
  const abs = (u: string) => (u.startsWith("/") ? origin + u : u);
  const hero = list.items[0]?.record.cover ? abs(list.items[0].record.cover) : "";
  const desc = list.blurb || list.items.map(({ record: r, track: t }, i) => `${i + 1}. ${t?.artist || r.artist} – ${t ? t.title : r.title}`).join("  ");
  const tiles = list.items.map(({ record: r, track: t }, i) => `
      <li class="tile">
        <a href="${esc(t?.spotifyUrl || r.url)}" target="_blank" rel="noopener">
          <img src="${esc(abs(r.cover))}" alt="${esc(r.artist)} – ${esc(r.title)}" loading="${i < 4 ? "eager" : "lazy"}" referrerpolicy="no-referrer">
        </a>
        <span class="rank" aria-hidden="true">${i + 1}</span>
        <div class="meta">
          <strong>${esc(t ? t.title : r.title)}</strong>
          <span>${esc(t?.artist || r.artist)}${t ? ` <em>${esc(r.title)}</em>` : r.year ? ` <em>${r.year}</em>` : ""}${!t && r.label ? ` <span class="lbl">${esc(r.label)}</span>` : ""}</span>
        </div>
      </li>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(list.title)} — Crate Digger</title>
<meta name="description" content="${esc(desc.slice(0, 300))}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Crate Digger">
<meta property="og:title" content="${esc(list.title)}">
<meta property="og:description" content="${esc(desc.slice(0, 300))}">
<meta property="og:url" content="${esc(url)}">
${hero ? `<meta property="og:image" content="${esc(hero)}"><meta property="og:image:width" content="600"><meta property="og:image:height" content="600"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${esc(hero)}">` : ""}
<meta name="twitter:title" content="${esc(list.title)}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300..700;1,9..144,300..700&family=Instrument+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root { color-scheme: light; --paper:#EFE9DC; --ink:#1B1712; --dim:#6B625A; --sticker:#F2C94C; }
  * { box-sizing:border-box }
  html, body { margin:0; background:var(--paper); color:var(--ink); font-family:"Instrument Sans", system-ui, sans-serif; }
  body { padding: max(28px, env(safe-area-inset-top)) 24px max(40px, env(safe-area-inset-bottom)); }
  .sheet { max-width: 1040px; margin: 0 auto; }
  header { display:flex; align-items:flex-end; justify-content:space-between; gap:24px; flex-wrap:wrap; border-bottom: 2px solid var(--ink); padding-bottom: 18px; margin-bottom: 28px; }
  h1 { font-family:"Fraunces", Georgia, serif; font-weight:500; font-size: clamp(34px, 5.5vw, 64px); line-height:.98; letter-spacing:-.02em; margin:0; max-width: 14ch; font-variation-settings:"opsz" 144; }
  .blurb { font-size:17px; line-height:1.45; color:var(--dim); max-width: 46ch; margin: 14px 0 0; }
  .by { font-size:13px; color:var(--dim); white-space:nowrap; }
  .by b { color:var(--ink); font-weight:600 }
  ol { list-style:none; margin:0; padding:0; display:grid; grid-template-columns: repeat(5, 1fr); gap: 22px 18px; }
  .tile { position:relative; }
  .tile img { display:block; width:100%; aspect-ratio:1; object-fit:cover; background:#d9d2c4; box-shadow: 0 1px 0 rgba(0,0,0,.25), 0 10px 22px -12px rgba(0,0,0,.45); }
  .rank { position:absolute; top:-10px; left:-10px; width:38px; height:38px; border-radius:50%; background:var(--sticker); color:var(--ink); font-family:"Fraunces", serif; font-weight:600; font-size:19px; display:grid; place-items:center; box-shadow: 0 2px 4px rgba(0,0,0,.25); transform: rotate(-8deg); }
  .meta { margin-top:10px; font-size:13px; line-height:1.35; }
  .meta strong { display:block; font-weight:600; }
  .meta span { color:var(--dim) } .meta em { font-style:normal; margin-left:.35em } .lbl { display:block }
  footer { margin-top:40px; font-size:12px; color:var(--dim); display:flex; justify-content:space-between; gap:12px; }
  footer a { color:inherit }
  .by .sp { display:inline-block; margin-top:8px; color:#1db954; text-decoration:none; font-weight:600 }
  @media (max-width: 780px) { ol { grid-template-columns: repeat(2, 1fr); gap:26px 18px } .rank { width:34px; height:34px; font-size:17px } }
  @media print { body { padding:0 } .tile img { box-shadow:none } }
</style>
</head>
<body>
<main class="sheet">
  <header>
    <div><h1>${esc(list.title)}</h1>${list.blurb ? `<p class="blurb">${esc(list.blurb)}</p>` : ""}</div>
    <p class="by">A Top Ten by <b>DJ Brendan</b>${list.spotifyUrl ? `<br><a class="sp" href="${esc(list.spotifyUrl)}" target="_blank" rel="noopener">▶ Listen on Spotify</a>` : ""}</p>
  </header>
  <ol>${tiles}</ol>
  <footer><span>Made with Crate Digger</span><span>Covers and metadata via Spotify${list.items.some((i) => i.record.source === "discogs") ? " and Discogs" : ""}</span></footer>
</main>
</body>
</html>`;
}
