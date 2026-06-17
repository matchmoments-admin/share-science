-- migrations/0004_alpaca.sql  (additive — broker order id for real Alpaca buys)
ALTER TABLE positions ADD COLUMN broker_order_id TEXT;
