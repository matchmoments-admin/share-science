-- migrations/0002_seed.sql  (idempotent seed — securities spine, aliases, benchmarks, sources)
-- Apply after 0001_init.sql. Expand securities/aliases as coverage grows (or load from data/*.csv).

-- ── Securities (canonical spine) ─────────────────────────────────────
INSERT OR IGNORE INTO securities (id, ticker, exchange, isin, name, sec_type, domicile, currency, sector, is_active, created_at) VALUES
  ('AAPL.US','AAPL','XNAS','US0378331005','Apple Inc.','share','US','USD','Technology',1,'2026-06-17T00:00:00Z'),
  ('MSFT.US','MSFT','XNAS','US5949181045','Microsoft Corporation','share','US','USD','Technology',1,'2026-06-17T00:00:00Z'),
  ('NVDA.US','NVDA','XNAS','US67066G1040','NVIDIA Corporation','share','US','USD','Technology',1,'2026-06-17T00:00:00Z'),
  ('VOO.US','VOO','ARCX','US9229083632','Vanguard S&P 500 ETF','etf','US','USD','Index',1,'2026-06-17T00:00:00Z'),
  ('SPY.US','SPY','ARCX','US78462F1030','SPDR S&P 500 ETF Trust','etf','US','USD','Index',1,'2026-06-17T00:00:00Z'),
  ('CBA.AU','CBA','XASX','AU000000CBA7','Commonwealth Bank of Australia','share','AU','AUD','Financials',1,'2026-06-17T00:00:00Z'),
  ('BHP.AU','BHP','XASX','AU000000BHP4','BHP Group Limited','share','AU','AUD','Materials',1,'2026-06-17T00:00:00Z'),
  ('IVV.AU','IVV','XASX','AU000000IVV9','iShares S&P 500 ETF (AU)','etf','AU','AUD','Index',1,'2026-06-17T00:00:00Z'),
  ('A200.AU','A200','XASX','AU0000XVGZA3','Betashares Australia 200 ETF','etf','AU','AUD','Index',1,'2026-06-17T00:00:00Z');

-- ── Aliases (name + cashtag → security) ──────────────────────────────
INSERT OR IGNORE INTO security_aliases (alias, security_id, kind) VALUES
  ('apple','AAPL.US','name'),
  ('$aapl','AAPL.US','cashtag'),
  ('microsoft','MSFT.US','name'),
  ('$msft','MSFT.US','cashtag'),
  ('nvidia','NVDA.US','name'),
  ('$nvda','NVDA.US','cashtag'),
  ('vanguard s&p 500','VOO.US','name'),
  ('$voo','VOO.US','cashtag'),
  ('spdr s&p 500','SPY.US','name'),
  ('$spy','SPY.US','cashtag'),
  ('commonwealth bank','CBA.AU','name'),
  ('commbank','CBA.AU','name'),
  ('bhp','BHP.AU','name'),
  ('ishares s&p 500','IVV.AU','name'),
  ('betashares australia 200','A200.AU','name');

-- ── Benchmarks (one per market) ──────────────────────────────────────
INSERT OR IGNORE INTO benchmarks (id, name, security_id) VALUES
  ('US','S&P 500 (SPY)','SPY.US'),
  ('AU','ASX 200 (A200)','A200.AU');

-- ── Sources (curated tipsters) ───────────────────────────────────────
INSERT OR IGNORE INTO sources (id, name, medium, handle, home_url, created_at) VALUES
  ('founder-manual','Manual entry (founder)','web','manual','','2026-06-17T00:00:00Z'),
  ('example-podcast','Example Investing Podcast','podcast','example-investing','https://example.com/podcast','2026-06-17T00:00:00Z');
