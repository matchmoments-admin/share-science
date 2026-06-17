# SETUP — share-science provisioning runbook

Everything below runs against **your** Cloudflare account. macOS 12.6 can't run `workerd`, so the
flow is provision → deploy → smoke-test live (no local `wrangler dev`).

---

## 0. Prerequisites

```bash
cd /Users/brendanmilton/Desktop/share-science
npm install
npx wrangler login           # opens browser; authorises wrangler to your CF account
npx wrangler whoami          # confirm the right account is active
```

If you have multiple Cloudflare accounts, pin the right one (otherwise wrangler may pick the wrong
one): add `account_id = "<your-account-id>"` near the top of `wrangler.toml`, or
`export CLOUDFLARE_ACCOUNT_ID=<id>` for the session. `npx wrangler whoami` lists your account IDs.

**Accounts/keys to have ready** (only the first three are needed for Slice 1):
| Secret | Where to get it | Needed for |
|---|---|---|
| `ADMIN_TOKEN` | generate: `openssl rand -hex 32` | gating `/ingest/human` |
| `ANTHROPIC_API_KEY` | console.anthropic.com → API keys | tip extraction |
| `EODHD_API_KEY` | eodhd.com → register → API token (**use a plan that includes ASX** — All-In-One — if you track ASX tips; EOD All-World alone may not cover `.AU`) | prices + corporate actions |
| `ALPACA_KEY_ID` / `ALPACA_SECRET_KEY` | alpaca.markets → paper keys | Slice 3 (real US buys) |
| `DEEPGRAM_API_KEY` | deepgram.com → API keys | Slice 4 (podcast ASR) |
| `BEEHIIV_API_KEY` | beehiiv → Settings → API | Slice 2 (newsletter) |

---

## 1. Provision Cloudflare resources

```bash
npx wrangler d1 create share-science-db
npx wrangler kv namespace create KV
npx wrangler r2 bucket create share-science-raw-media
npx wrangler queues create tips-ingest
npx wrangler queues create tips-ingest-dlq
```

Each `create` prints an ID. Paste them into `wrangler.toml` (see §2):
- `d1 create` → `database_id` under `[[d1_databases]]`
- `kv namespace create` → `id` under `[[kv_namespaces]]`
- R2 + queues are referenced by **name** (already correct in the toml) — nothing to paste.

> Queues require the **Workers Paid** plan ($5/mo). D1, KV, R2 work on Free.

---

## 2. Fill in `wrangler.toml`

Replace the two placeholders with the IDs from §1:

```toml
[[d1_databases]]
binding = "DB"
database_name = "share-science-db"
database_id = "PASTE_D1_ID_HERE"        # ← from `wrangler d1 create`

[[kv_namespaces]]
binding = "KV"
id = "PASTE_KV_ID_HERE"                 # ← from `wrangler kv namespace create`
```

Leave the rest as-is. Tunable `[vars]` (non-secret, edit if you want):
```toml
[vars]
PUBLIC_PRICES = "off"          # keep off — derived returns only, stays on EODHD personal tier
MAX_DAILY_COST_CENTS = "500"   # daily LLM spend ceiling ($5)
# EXTRACT_MODEL = "claude-haiku-4-5"   # optional: cheaper extraction model (default claude-opus-4-8)
```

---

## 3. Apply migrations (schema + seed)

```bash
npm run migrate:remote
```

That runs `0001_init.sql` (the ledger) then `0002_seed.sql` (securities/aliases/benchmarks/sources).
Verify:
```bash
npx wrangler d1 execute share-science-db --remote --command \
  "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
npx wrangler d1 execute share-science-db --remote --command \
  "SELECT id, ticker, exchange FROM securities;"
```

---

## 4. Set secrets

```bash
npx wrangler secret put ADMIN_TOKEN        # paste your openssl-generated token
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put EODHD_API_KEY
# Slice 3+: ALPACA_KEY_ID, ALPACA_SECRET_KEY
# Slice 4:  DEEPGRAM_API_KEY, INGEST_HMAC_SECRET
# Slice 2:  BEEHIIV_API_KEY
```

---

## 5. Deploy

```bash
npm run deploy
```

Note the deployed host it prints (e.g. `https://share-science.<your-subdomain>.workers.dev`).

---

## 6. Smoke-test the Slice 1 spine

```bash
HOST=https://share-science.<your-subdomain>.workers.dev
TOKEN=<your ADMIN_TOKEN>

# (a) health
curl -s $HOST/healthz | jq

# (b) submit a tip
curl -s $HOST/ingest/human \
  -H "x-admin-token: $TOKEN" -H "content-type: application/json" \
  -d '{"source_id":"founder-manual","text":"On the show she called CBA a strong buy for the long term.","url":"https://example.com/ep1"}' | jq

# (c) within a few seconds, the queue consumer should have extracted + resolved the tip:
npx wrangler d1 execute share-science-db --remote --command \
  "SELECT security_id, direction, status, confidence FROM tips ORDER BY created_at DESC LIMIT 5;"

# (d) watch the pipeline's audit log:
npx wrangler d1 execute share-science-db --remote --command \
  "SELECT kind, detail, created_at FROM ops_events ORDER BY created_at DESC LIMIT 10;"
```

**The daily Cron** (open positions + value them) runs at 06:00 UTC. To exercise it without waiting,
trigger it from the Cloudflare dashboard (Workers → share-science → Settings → Triggers → the cron
→ run), or tail logs with `npx wrangler tail`. After it runs:
```bash
npx wrangler d1 execute share-science-db --remote --command \
  "SELECT mode, status, entry_at, entry_price_adj, return_pct, excess_return_pct FROM positions;"
```

> Want a one-tap manual trigger instead of the dashboard? Ask and I'll add a small admin route
> `POST /admin/run-daily` (token-gated) that runs the same job on demand — handy for testing.

---

## Cost while testing
v1 ≈ **$5 Workers base + ~$100/mo EODHD + a few cents of Claude per tip**. Keep `PUBLIC_PRICES=off`
so EODHD stays on the personal tier. The `MAX_DAILY_COST_CENTS` cap stops runaway extraction spend.
