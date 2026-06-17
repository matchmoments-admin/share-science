# share-science

*(working title)* — Empirical tip-accountability engine — *"science applied to share tips."* Aggregate public
share tips, verify them by **outcome** (real 1-share US buys where affordable; paper-trade
everything else and all ASX), and publish a confidence-adjusted **track record + source
ratings**. Every published number ties back to an immutable ledger row.

**General information only — not financial advice.** See [`LEGAL.md`](./LEGAL.md). The product
*reports outcomes, never recommends.*

## Architecture (v1)

One Cloudflare Worker — "a cron + tables + one queue":

```
producers (GH Actions / Worker crons / human form)
   → INSERT OR IGNORE ingest_items (sha256 dedup, immutable detected_at)
   → queue tips-ingest
   → queue() consumer: extract (Claude strict-JSON) → resolve (D1 security master, ABSTAIN if unsure)
       → record tip → createPosition (real if affordable+US+confirmed, else paper)
   → daily Cron: value open positions (EODHD adjusted_close) → tip_returns → recompute source_ratings
   → publish: facts pack → LLM draft → assertFactual → human approve → beehiiv + edge-cached public pages
```

Full design + rationale: `~/.claude/plans/mellow-hatching-shell.md`.

## Layout
- `src/index.ts` — Worker entry (`fetch` / `queue` / `scheduled`).
- `src/lib/usage.ts` — spend metering + `withinBudget` gate.
- `src/lib/advisory.ts` — `assertFactual` + `assertNoRawPrices` compliance guards.
- `migrations/0001_init.sql` — the one canonical ledger.
- `data/*` — seed securities/aliases/sources.

## Dev
Local runtime is **deploy-only** on macOS 12.6 (workerd won't run). Verify with typecheck,
then deploy.

```bash
npm install
npm run typecheck
```

## Provision (one-time, your Cloudflare account)
```bash
npx wrangler d1 create share-science-db       # paste database_id into wrangler.toml
npx wrangler kv namespace create KV           # paste id into wrangler.toml
npx wrangler r2 bucket create share-science-raw-media
npx wrangler queues create tips-ingest
npx wrangler queues create tips-ingest-dlq
npm run migrate:remote                         # apply the schema
```

## Secrets (set when the relevant slice needs them)
```bash
npx wrangler secret put ADMIN_TOKEN            # gates /ingest/human (x-admin-token header)
npx wrangler secret put ANTHROPIC_API_KEY      # extraction
npx wrangler secret put EODHD_API_KEY          # prices + corporate actions
npx wrangler secret put ALPACA_KEY_ID
npx wrangler secret put ALPACA_SECRET_KEY      # real US buys (Slice 3)
npx wrangler secret put DEEPGRAM_API_KEY       # podcast ASR (Slice 4)
npx wrangler secret put BEEHIIV_API_KEY        # newsletter (Slice 2)
npx wrangler secret put INGEST_HMAC_SECRET     # podcast producer auth (Slice 4)
```

## Deploy
```bash
npm run deploy
curl -s https://<your-worker-host>/healthz
```

## Submit a tip (Slice 1 spine)
A hand-entered tip flows: `/ingest/human` → queue → extract (Claude) → resolve (security master,
abstains if unsure) → record tip. The daily Cron then opens a paper position at the next session's
open and tracks alpha vs the market benchmark, snapshotting returns at 30/90/365 days.

```bash
curl -s https://<your-worker-host>/ingest/human \
  -H "x-admin-token: $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"source_id":"founder-manual","text":"On the podcast she said CBA is a strong buy for the long term.","url":"https://example.com/ep1"}'
```

Requires `ANTHROPIC_API_KEY` (extraction) + `EODHD_API_KEY` (prices). The daily Cron runs at 06:00
UTC; to exercise it immediately on a deploy, trigger the scheduled handler from the Cloudflare
dashboard or `wrangler`'s scheduled test. Inspect progress in the `ops_events` table.
