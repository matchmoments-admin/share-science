-- 0008_risk_metrics.sql — per-position risk metrics derived from the existing valuations series.
-- max_drawdown_pct (positive fraction), volatility_pct (annualised), sharpe_proxy (annualised, rf≈0).
-- risk_metrics_as_of is the idempotency guard (one recompute per position per day). Additive.

ALTER TABLE positions ADD COLUMN max_drawdown_pct REAL;   -- worst peak-to-trough on the return curve (≥0)
ALTER TABLE positions ADD COLUMN volatility_pct REAL;     -- annualised stdev of period returns
ALTER TABLE positions ADD COLUMN sharpe_proxy REAL;       -- annualised mean/stdev of period excess returns
ALTER TABLE positions ADD COLUMN risk_metrics_as_of TEXT; -- YYYY-MM-DD of last risk recompute (idempotency)
