# CLAUDE.md — share-science working agreement

> Operating manual for Claude Code in this repo. Keep it short; the full build spec lives in
> `~/.claude/plans/mellow-hatching-shell.md` and `docs/`.

## What this is
share-science is an **empirical tip-accountability engine** on **Cloudflare**: one Worker (`src/`)
+ D1 (`share-science-db`), R2 (`share-science-raw-media`), KV, and Queues (`tips-ingest` + DLQ).
It ingests public share/stock **tips**, resolves the security, **paper-trades the outcome**, and
publishes a **confidence-adjusted source leaderboard** + weekly newsletter. **General information
only — reports outcomes, never recommends. Not financial advice.**

Live: `https://shareo.co` (+ `www.`; custom domains on CF account matchmoments, region OC/Sydney). The `share-science.matchmoments.workers.dev` URL stays on as a fallback (`workers_dev = true`).

## Commands
- `npm run typecheck` — tsc. `npm test` — stats unit goldens (node test runner).
- `npm run deploy` — `wrangler deploy`. Local runtime is **deploy-only** (macOS 12.6 can't run workerd) — verify via typecheck + tests, then deploy and smoke-test live.
- Migrations: `npx wrangler d1 execute share-science-db --remote --file=migrations/NNNN_x.sql` (in order; additive only).
- Admin (token-gated, `x-admin-token`): `POST /admin/run-daily`, `/admin/run-weekly`, `/admin/poll`, `/admin/seed-securities?exchange=AU|US`, `GET /admin/digest?week=`.

## Critical rules

### 🛑 Automation safety (crons, queues, pollers, any scheduled/background job) — NON-NEGOTIABLE
Every cron / queue consumer / poller / background job MUST, before it ships:
1. **Be planned + verified + tested** for correctness AND for behaviour **at 100× current scale** — not just today's tiny data. State the expected work per run (rows, external calls, tokens) and what happens when that grows.
2. **Bound the work per invocation.** Hard caps on items processed per run (`LIMIT`/cursor pagination), max external calls, and `max_tokens`. A single invocation must stay well under the Workers **subrequest limit (1000)** and CPU/time limits. Never iterate an unbounded table making N external calls.
3. **Cap cost.** Any paid call (LLM, transcription, market data) goes through `withinBudget()` (`MAX_DAILY_COST_CENTS`) and `recordSpend()`. Over budget ⇒ defer/`needs_review`, never run. No job may incur large/unbounded spend or compute.
4. **Be idempotent + dedup'd.** Re-runs must not double-insert, double-trade, or re-pay for the same work (content-hash dedup, `INSERT OR IGNORE`, idempotency keys, poll cursors). Re-polling a feed must NOT re-extract.
5. **Fail gracefully + isolated.** Per-item `try/catch` — one bad item logs to `ops_events` and is skipped, never crashes the whole run. Queue errors → `retry()` → DLQ after max retries.
6. **Memoize/batch shared work.** Don't fetch the same price/benchmark/record N times in one run; cache within the run and batch DB writes (`env.DB.batch`).
7. **Observable.** Every run logs a summary to `ops_events`; surface depth/age/abstain-rate on `/healthz`.

If a job can't meet all seven, it doesn't ship — cap it, paginate it, or move the heavy part to the queue (which bounds per-message work). When in doubt, smaller caps + more runs.

### Other invariants
- **Report outcomes, never recommend.** Backward-looking, factual, impersonal. `assertFactual` gates every published/drafted surface. No "buy/sell/best pick", no forward steers, no own model portfolio. (Keeps us unlicensed — see `LEGAL.md`.)
- **Never leak raw prices.** Public payloads pass `assertNoRawPrices`; `PUBLIC_PRICES=off` keeps us on the EODHD personal tier (publish derived returns/alpha only). Flipping it on = commercial licence (~$399/mo) — a deliberate, revenue-gated decision, not an accident.
- **Empirical integrity.** Immutable `detected_at` (drives look-ahead-free entry = first bar AFTER detection); adjusted-price return math + frozen unadjusted entry as evidence; keep delistings; alpha-vs-benchmark, not raw return. A quiet adjustment bug discredits the whole product.
- **A bad parse never auto-trades.** `resolve.ts` is the only writer of `security_id`; abstain (NULL) ⇒ no position.
- **Migrations additive + apply-once.** `CREATE … IF NOT EXISTS`, `ALTER TABLE ADD COLUMN`, idempotent seeds (`INSERT OR IGNORE`). Continue the `000N_` sequence.

## Ship workflow
Branch off main for non-trivial work → `npm run typecheck` + `npm test` green → self-review (run `/code-review` for anything touching money/tax math, the ingest/trade/track path, auth, or a new cron) → commit (descriptive WHY; `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`) → apply migrations in order → `npm run deploy` → smoke-test live (`/healthz` + the touched surface) → report. Backlog lives in GitHub Issues (see `docs/`).

## Resource map
- D1 `share-science-db` (id in `wrangler.toml`), KV, R2 `share-science-raw-media`, Queue `tips-ingest`(+`-dlq`).
- Secrets (`wrangler secret put`): `ADMIN_TOKEN`, `ANTHROPIC_API_KEY`, `EODHD_API_KEY`; later `TADDY_API_KEY`+`TADDY_USER_ID`, `INGEST_HMAC_SECRET`, `BEEHIIV_API_KEY`.
- Vars: `PUBLIC_PRICES` (off), `MAX_DAILY_COST_CENTS` (500), `EXTRACT_MODEL` (default claude-opus-4-8).
