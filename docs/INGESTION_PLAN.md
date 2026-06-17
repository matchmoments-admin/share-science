# Ingestion v1 — Simple Start (plan)

> Output of a 5-agent ultraplan (build review + podcast-transcript / Bluesky / Reddit-web research + synthesis), 2026-06-17. This is the plan for **Slice 4** (getting real tips flowing automatically).

## 1. GOAL

**Ingestion v1 = get real, dated, ToS-clean tips flowing automatically from a handful of named, identified finance sources into the existing pipeline — at near-zero cost and minimal new code.** Stand up the smallest set of producers that reliably obtain a tip's verbatim **text** + accurate **public-publish timestamp** + stable **source identity**, content-hash for dedup, and enqueue a `TipIngestMessage`. No firehose, no scraping, no own-ASR. Extraction/resolution/trading stay untouched. Success = at least one automated source posting to the live leaderboard with look-ahead-free entry pricing. Optimise **SIMPLE > CHEAP > ToS-CLEAN**.

## 2. Current build review

- Spine is live + reusable: `/ingest/human` → content-hash dedup in `ingest_items` → Queue → Claude extract → abstaining security resolve → daily Cron paper position at first bar after `detected_at` → 30/90/365d alpha → Wilson-ranked leaderboard + JSON + newsletter.
- **Producer contract** (`TipIngestMessage`): `{ source_id (must pre-exist in sources FK), source_type, text (verbatim), url?, detected_at (REAL public time) }`; system generates `id` + `content_hash = sha256(source_id|text)`.
- **`detected_at` is load-bearing** — immutable, drives "first bar strictly after". A producer supplying paste-time instead of publish-time breaks look-ahead-free pricing.
- **Two gaps block automation:** (1) no `/ingest/producer` endpoint (only the admin-token human path); (2) `INGEST_HMAC_SECRET` declared but unused. Everything else is built + reusable.

## 3. Recommended simple start (per channel)

### Podcasts — AVOID Deepgram (confirmed unnecessary at the start)
Per-episode 3-tier transcript resolver, smallest-first:
1. **RSS `<podcast:transcript>` tag — $0, cleanest** (publisher's own feed).
2. **Taddy API — ~$0.025/transcript, explicit commercial terms** (free 500/mo covers prototype). ~80 eps/mo ≈ **$2/mo**.
3. **(optional) YouTube Data API — free** — only for shows that upload their *own* caption track.
- **Do not use:** Apple private endpoint, Spotify (no API), unofficial YouTube `timedtext` scraping.
- **Deepgram = tier-4, deferred** — only audio-only stragglers with no tag/Taddy/own-captions. A hand-picked set won't hit it.

### Bluesky — poll a curated author list, unauthenticated
- `app.bsky.feed.getAuthorFeed` on `public.api.bsky.app`, **no auth, free** (verified 200). Per post: `record.text`, `record.createdAt` (→ `detected_at`), `author.did` (source id), `post.uri` (link-back). `filter=posts_no_replies`. ~3,000 req/5min/IP limit (we use hundreds/day).
- Skip `searchPosts`/cashtag discovery for now (403'd; finance volume nascent). Curate accounts.
- **ToS obligation:** honor deletions — periodic `getPosts` existence sweep → purge/tombstone. Read-only, never interact.

### Reddit — human-curated paste only ($0)
- Free Data API and `.rss`/`.json` are **NO-GO commercially** (use-based tiering; Nov-2025 pre-approval policy; active litigation incl. vs Anthropic). Not a loophole.
- **GO:** founder skims named subreddits ~10–15 min/day, pastes notable calls into `/ingest/human` **with the post's real publish timestamp**. Automate only if a contract is ever justified.

### Web / blogs / newsletters — automated RSS, allow-listed
1. **Named Substack finance newsletters — best automated source** (clean `/feed`, full content + real `pubDate`).
2. **Independent blogs (WordPress/Ghost `/feed`)** — same.
3. **Seeking Alpha / Motley Fool — NO-GO automated** (RSS personal/non-commercial) → human paste.
- **Copyright safe zone:** store facts (security + direction + date) + a 1–2 sentence quote + link-back; never reproduce full articles.

### Concrete starter set
- **5 named podcasts** (RSS-tag → Taddy resolver, audit feeds first).
- **~10–20 named Bluesky finance accounts** (getAuthorFeed cron).
- **3–5 named Substack/blog tipsters** (ToS eyeballed) via RSS cron.
- **Reddit + Seeking Alpha + Motley Fool** via manual `/ingest/human`.

## 4. What to build (minimal, smallest-first)

All producers feed the **same** dedup → `ingest_items` → Queue path. Build the shared seam once.
1. **`POST /ingest/producer` + HMAC** (`src/index.ts` ~50 LOC + `verifyHmacSig` ~30 LOC). Producer supplies `detected_at`; auth `x-ingest-hmac-sha256` over raw body with `INGEST_HMAC_SECRET`. Guard: reject future / >~7-day-old `detected_at` (flag, don't silently price stale bars).
2. **Source seeds** (`migrations/0003_producers.sql`) — one row per named source (bluesky DID / podcast feed / substack pub) + a `tos_checked` field.
3. **Bluesky cron poller** (hourly Cron): per DID `getAuthorFeed?filter=posts_no_replies`, page past last-seen cursor, map → shared `ingest()` fn (in-Worker, no HMAC needed). + deletion sweep.
4. **RSS cron poller** (same Cron): per allow-listed feed, `detected_at = pubDate`, send `User-Agent`/`From`, honor `ETag`/`If-Modified-Since`/`robots.txt`. Reused for Substack + podcasts.
5. **Podcast transcript resolver** (per episode, behind the RSS poller): tier-1 RSS tag → tier-2 Taddy → tier-3 YouTube. Emits the same payload.

> In-Worker pollers call the shared `ingest()` fn directly (skip HMAC); `/ingest/producer`+HMAC exists for any out-of-Worker producer (future GitHub Action). No external runner needed to start.

## 5. Build sequence (tracer bullets → first automated real tip)
1. **Shared seam:** factor dedup-and-enqueue out of `handleIngestHuman` into a reusable `ingest()`; add `POST /ingest/producer` + HMAC + `detected_at` guard. Deploy, curl-smoke.
2. **Bluesky tracer:** seed 1 account DID + hourly cron → confirm a real post flows to a paper position on `/sources/{id}`.
3. **RSS tracer:** seed 1 Substack feed + RSS poller → confirm a newsletter tip lands. Add Bluesky deletion sweep.
4. **Podcast tracer + scale-out:** wire the 3-tier resolver for 1 podcast (after feed audit), then widen to the full starter set. Reddit/SA/Fool stay manual.

## 6. Cost delta vs today
- Bluesky $0 · RSS/Substack $0 · podcast transcripts **$0–$2/mo** (RSS tag free; Taddy free tier then ~$0.025/transcript) · Claude extraction unchanged per-tip (~3c), bounded by `MAX_DAILY_COST_CENTS`.
- **Net new run-rate: ~$0–$2/month.**
- **Spend triggers:** (1) thin Taddy coverage → more Deepgram fall-through (mitigate by auditing feeds first); (2) a looping poller → extra extraction, capped by the budget gate.

## 7. Open questions (research further)
1. **Feed audit (do first, ~1 afternoon):** for each named podcast — RSS `<podcast:transcript>`? in Taddy? own YouTube captions? Confirms the $0–$2/mo number before building.
2. **Per-source ToS sign-off:** eyeball each Substack/blog footer; record in `tos_checked`. (Lawyer review pre-launch, on the LEGAL.md track.)
3. **Deletion-honor cadence** for Bluesky; tombstone vs hard-purge (affects opened positions / leaderboard history).
4. **`detected_at` accept window** — reject future; warn/quarantine if older than N days, without dropping legitimately-delayed podcast episodes.
5. **The actual named starter list** — founder's hand-pick of highest-signal finance sources per channel.
