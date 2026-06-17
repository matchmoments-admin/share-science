/** Tiny server-side HTML helpers — crawlable pages, no SPA, no framework. */

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
<title>${escapeHtml(title)} · share-science</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 -apple-system, system-ui, sans-serif; max-width: 880px; margin: 0 auto; padding: 1.5rem; }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
  a { color: inherit; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  th, td { text-align: left; padding: .5rem .6rem; border-bottom: 1px solid #8884; }
  th { font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; opacity: .7; }
  .pos { color: #1a7f37; } .neg { color: #c0392b; }
  .tier { font-size: .7rem; padding: .1rem .4rem; border-radius: .4rem; border: 1px solid #8886; }
  .muted { opacity: .65; font-size: .9rem; }
  footer { margin-top: 2.5rem; padding-top: 1rem; border-top: 1px solid #8884; font-size: .8rem; opacity: .7; }
  nav { font-size: .85rem; margin-bottom: 1rem; }
</style>
</head>
<body>
<nav><a href="/leaderboard">← Leaderboard</a> · <a href="/methodology">Methodology</a></nav>
${body}
<footer>${escapeHtml(DISCLAIMER)}</footer>
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
