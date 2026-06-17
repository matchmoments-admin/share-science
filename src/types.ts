/** Cloudflare bindings + vars. Keep in lockstep with wrangler.toml. */
export interface Env {
  DB: D1Database;
  RAW_MEDIA: R2Bucket;
  KV: KVNamespace;
  TIP_INGEST: Queue<TipIngestMessage>;

  // vars
  PUBLIC_PRICES: string; // "on" | "off" — gates raw-price display (default off)
  MAX_DAILY_COST_CENTS: string; // daily LLM/transcription spend ceiling
  EXTRACT_MODEL?: string; // override the extraction model (default claude-opus-4-8)
  ALPACA_MODE?: string; // "off" (default) | "paper" | "live" — gates broker execution
  ALPACA_NOTIONAL_USD?: string; // fixed $ size per real buy (default 5)
  TURNSTILE_SITE_KEY?: string; // public Turnstile widget key (var); when set, /api/subscribe shows the widget
  BEEHIIV_PUBLICATION_ID?: string; // pub_… id (var); paired with BEEHIIV_API_KEY for subscriber sync + post drafts

  // secrets (set via `wrangler secret put`; optional until the relevant slice)
  ANTHROPIC_API_KEY?: string;
  ADMIN_TOKEN?: string; // gates /ingest/human + admin routes (x-admin-token header)
  EODHD_API_KEY?: string;
  ALPACA_PAPER_KEY_ID?: string; // paper-api.alpaca.markets (set now)
  ALPACA_PAPER_SECRET_KEY?: string;
  ALPACA_KEY_ID?: string; // api.alpaca.markets — LIVE/actual (set only when going live)
  ALPACA_SECRET_KEY?: string;
  DEEPGRAM_API_KEY?: string;
  BEEHIIV_API_KEY?: string;
  TURNSTILE_SECRET_KEY?: string; // verifies the Turnstile token on /api/subscribe (fail-open if unset)
  TADDY_API_KEY?: string; // podcast transcripts (Taddy); paired with TADDY_USER_ID
  TADDY_USER_ID?: string;
  INGEST_HMAC_SECRET?: string; // verifies POST /ingest/producer from out-of-Worker producers
}

/** A normalised artefact dropped onto the tips-ingest queue by any producer. */
export interface TipIngestMessage {
  ingest_item_id: string;
  source_id: string;
  source_type: 'podcast' | 'x' | 'bluesky' | 'blog' | 'web' | 'youtube' | 'human';
  text: string;
  url?: string;
  detected_at: string; // immutable ISO-8601 UTC, stamped at first capture
}

/** A security row from the canonical spine. */
export interface Security {
  id: string;
  ticker: string;
  exchange: string;
  isin: string | null;
  name: string;
  sec_type: string;
  domicile: string | null;
  currency: string | null;
  is_active: number;
}

export type Direction = 'buy' | 'bullish' | 'sell' | 'bearish' | 'hold' | 'none';

/** Structured tip extracted from raw text by the LLM (pre entity-resolution). */
export interface ExtractedTip {
  is_recommendation: boolean;
  proposed_ticker: string | null;
  exchange_hint: string | null; // 'US' | 'AU' | 'UK' | ...
  company_name: string | null;
  direction: Direction;
  conviction: 'low' | 'medium' | 'high' | null;
  horizon: string | null;
  tip_type: 'short' | 'swing' | 'buy_hold' | null; // bucketed stated horizon (governs primary score)
  horizon_days_target: number | null; // parsed numeric horizon in days, null if unstated
  target_price: number | null; // stated price target (raw; internal only), null if unstated
  target_currency: string | null;
  rationale: string | null;
  evidence_span: string;
  speaker: string | null; // analyst/author who made THIS call (for per-speaker leaderboards later)
  confidence: number; // 0..1
}
