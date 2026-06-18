/**
 * Brand design tokens — extracted from the landing page (src/lib/landing.ts) so every server-rendered
 * surface (public pages, admin console) shares one source of truth for colour, type, radius, shadow.
 *
 * Warm monochrome "Stake/Shareo" palette · Anton display · Hanken Grotesk body · JetBrains Mono for
 * figures. Import BRAND_HEAD into any <head> and reference the CSS variables below.
 */

/** Google Fonts <link> tags for the brand typefaces. */
export const BRAND_FONTS =
  '<link rel="preconnect" href="https://fonts.googleapis.com">' +
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
  '<link href="https://fonts.googleapis.com/css2?family=Anton&family=Hanken+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600&display=swap" rel="stylesheet">';

/** :root custom properties — the design tokens. */
export const BRAND_TOKENS = `:root{
  /* surface */
  --paper:#E8E7E1; --paper-2:#F4F3EF; --card:#ffffff; --ink:#1A1916; --ink-dark:#1A1916;
  /* text */
  --text:#1A1916; --text-2:#4A4944; --muted:#6A6960; --muted-2:#8A897F; --faint:#9C9A90;
  --on-dark:#E8E7E1; --on-dark-muted:#B0AFA6; --on-dark-faint:#6E6D64;
  /* lines + state */
  --line:rgba(26,25,22,.10); --line-soft:rgba(26,25,22,.07);
  --good:#1a7f37; --bad:#B0322C; --bad-soft:#E8A6A2;
  /* type */
  --font-display:'Anton',Impact,sans-serif; --font-body:'Hanken Grotesk',-apple-system,system-ui,sans-serif;
  --font-mono:'JetBrains Mono',ui-monospace,monospace;
  /* radius */
  --r-sm:10px; --r-md:14px; --r-lg:18px; --r-pill:999px;
  /* shadow */
  --shadow-sm:0 16px 36px rgba(26,25,22,.10); --shadow-lg:0 34px 70px rgba(26,25,22,.18);
  /* space scale */
  --s-1:.5rem; --s-2:.85rem; --s-3:1.25rem; --s-4:2rem; --s-5:3rem;
}`;

/** Convenience: fonts + a normalize + token block, drop straight into <head>. */
export const BRAND_HEAD = `${BRAND_FONTS}<style>${BRAND_TOKENS}
*{box-sizing:border-box}
body{margin:0;font-family:var(--font-body);color:var(--text);background:var(--paper);-webkit-font-smoothing:antialiased}
a{color:inherit}
.display{font-family:var(--font-display);font-weight:400;text-transform:uppercase;letter-spacing:.01em;line-height:.95}
.mono{font-family:var(--font-mono);font-variant-numeric:tabular-nums}
.pos{color:var(--good)} .neg{color:var(--bad)} .muted{color:var(--muted)}
@media (prefers-color-scheme: dark){:root{--paper:#161513;--paper-2:#1d1c19;--card:#201f1b;--text:#ECEBE5;--text-2:#C8C7BF;--muted:#9C9A90;--line:rgba(255,255,255,.12);--line-soft:rgba(255,255,255,.07)}}
</style>`;
