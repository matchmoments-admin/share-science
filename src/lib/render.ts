/** Tiny server-side HTML helpers — crawlable pages, no SPA, no framework. */
import { BRAND_HEAD } from './theme.js';

export function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Format a fraction (0.1368) as a signed percentage ("+13.68%"). */
export function pct(frac: number | null | undefined): string {
  if (frac === null || frac === undefined) return '–';
  const v = frac * 100;
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

/** Format a 0..100 score. */
export function score(s: number | null | undefined): string {
  return s === null || s === undefined ? '–' : s.toFixed(0);
}

/** Render an "as of YYYY-MM-DD" stamp for a figure; empty string when no date. */
export function asOf(date: string | null | undefined): string {
  const d = (date || '').slice(0, 10);
  return d ? `as of ${escapeHtml(d)}` : '';
}

/**
 * Outcomes here are PAPER-TRADED (hypothetical) — entries are simulated at the first market bar
 * after a call was detected; no real capital is at risk. Hypothetical performance has inherent
 * limitations and is not a guarantee of actual future or past results. Shown wherever scores appear.
 */
export const HYPOTHETICAL_NOTE =
  'Hypothetical, paper-traded outcomes — entries are simulated at the first market bar after a ' +
  'call was detected; no real capital is at risk. Past performance is no guarantee of future results.';

const DISCLAIMER =
  'General information only — a factual, backward-looking record of outcomes. ' +
  'NOT financial advice and NOT a recommendation to buy or sell anything. ' +
  'We report what happened after a source made a call; what you do with that is your decision. ' +
  HYPOTHETICAL_NOTE +
  ' Australia: this is general information only and does not take into account your objectives, ' +
  'financial situation or needs; consider its appropriateness and seek licensed advice before acting.';

export function layout(title: string, body: string): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Shareo</title>
${BRAND_HEAD}
<style>
  body { line-height: 1.55; }
  .wrap { max-width: 920px; margin: 0 auto; padding: 1.25rem 1.5rem 3rem; }
  header.top { display: flex; align-items: center; gap: 1rem; padding: 1.1rem 0; }
  .brand { font-family: var(--font-display); font-size: 1.5rem; text-transform: uppercase; letter-spacing: .01em; }
  .brand .dot { color: var(--faint); }
  nav { margin-left: auto; display: flex; gap: 1.1rem; font-size: .85rem; font-weight: 600; }
  nav a { text-decoration: none; color: var(--text-2); }
  nav a:hover { color: var(--text); }
  h1 { font-family: var(--font-display); font-weight: 400; text-transform: uppercase; font-size: clamp(1.8rem, 4vw, 2.6rem); line-height: .98; letter-spacing: .01em; margin: .6rem 0 .3rem; }
  h2 { font-family: var(--font-display); font-weight: 400; text-transform: uppercase; letter-spacing: .02em; font-size: 1.15rem; margin: 1.8rem 0 .5rem; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; font-variant-numeric: tabular-nums; }
  th, td { text-align: left; padding: .55rem .65rem; border-bottom: 1px solid var(--line); }
  th { font-size: .72rem; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); font-weight: 600; }
  tbody tr:hover { background: var(--line-soft); }
  .tier { font-family: var(--font-mono); font-size: .65rem; text-transform: uppercase; letter-spacing: .04em; padding: .12rem .45rem; border-radius: var(--r-pill); border: 1px solid var(--line); color: var(--muted); }
  .muted { color: var(--muted); font-size: .92rem; }
  blockquote { border-left: 3px solid var(--line); margin: 1rem 0; padding: .3rem 0 .3rem 1rem; }
  b { font-family: var(--font-mono); }
  footer { margin-top: 3rem; padding-top: 1.1rem; border-top: 1px solid var(--line); font-size: .78rem; color: var(--muted); line-height: 1.6; }
</style>
</head>
<body>
<div class="wrap">
<header class="top">
  <a href="/" class="brand" style="text-decoration:none">Shareo<span class="dot">.</span></a>
  <nav><a href="/leaderboard">Leaderboard</a><a href="/methodology">Methodology</a></nav>
</header>
${body}
<footer>${escapeHtml(DISCLAIMER)}</footer>
</div>
</body>
</html>`;
  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' },
  });
}

/** Wrap a signed-percentage cell with a colour class. */
export function pctCell(frac: number | null | undefined): string {
  if (frac === null || frac === undefined) return '<td>–</td>';
  return `<td class="${frac >= 0 ? 'pos' : 'neg'}">${pct(frac)}</td>`;
}
