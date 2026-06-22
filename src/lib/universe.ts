/**
 * Curated liquid US universe (~S&P-500 scale, hand-picked for coverage across sectors) for the
 * "Find Similar Shares" feature. Bounding the universe to ~150 liquid names (vs all ~10k US tickers)
 * keeps the one-time fundamentals backfill cheap (~150 × 10 EODHD credits ≈ 1,500) and the peer
 * quality high. All entries are US-listed; seeded with exchange 'US' (EODHD code) so eodhdSymbol()
 * resolves them to `{ticker}.US`. name = ticker as a placeholder; the fundamentals backfill
 * overwrites it with the real company name from EODHD General.Name.
 *
 * Deliberately dense in semis/memory (MU's neighbourhood) so the founder's MU lookup returns
 * face-valid peers (NVDA, AMD, WDC, STX, …) on day one.
 */
export const US_UNIVERSE: string[] = [
  // ── Semiconductors & memory (MU's neighbourhood) ──
  'MU', 'NVDA', 'AMD', 'INTC', 'AVGO', 'QCOM', 'TXN', 'AMAT', 'LRCX', 'KLAC',
  'WDC', 'STX', 'ADI', 'MCHP', 'MRVL', 'ON', 'NXPI', 'MPWR', 'SWKS', 'TER',
  // ── Mega-cap tech / software / internet ──
  'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NFLX', 'ORCL', 'CRM', 'ADBE', 'CSCO',
  'IBM', 'NOW', 'INTU', 'AMD', 'TXN', 'QCOM', 'PANW', 'SNPS', 'CDNS', 'ANET',
  'UBER', 'SHOP', 'PLTR', 'CRWD', 'DDOG', 'SNOW', 'WDAY', 'TEAM', 'NET', 'ZS',
  // ── Financials ──
  'JPM', 'BAC', 'WFC', 'GS', 'MS', 'C', 'AXP', 'V', 'MA', 'BLK',
  'SCHW', 'SPGI', 'PYPL', 'COF', 'USB', 'PNC', 'TFC', 'BK', 'CB', 'PGR',
  // ── Health care ──
  'JNJ', 'UNH', 'LLY', 'PFE', 'MRK', 'ABBV', 'TMO', 'ABT', 'DHR', 'BMY',
  'AMGN', 'GILD', 'CVS', 'MDT', 'ISRG', 'VRTX', 'REGN', 'ZTS', 'BSX', 'HCA',
  // ── Consumer staples & discretionary ──
  'PG', 'KO', 'PEP', 'COST', 'WMT', 'MCD', 'NKE', 'SBUX', 'TGT', 'HD',
  'LOW', 'DIS', 'CMG', 'BKNG', 'MAR', 'ABNB', 'LULU', 'EL', 'MDLZ', 'CL',
  // ── Energy & materials ──
  'XOM', 'CVX', 'COP', 'SLB', 'EOG', 'PSX', 'MPC', 'OXY', 'WMB', 'KMI',
  'LIN', 'FCX', 'NEM', 'NUE', 'DOW',
  // ── Industrials ──
  'CAT', 'BA', 'GE', 'HON', 'UPS', 'UNP', 'LMT', 'RTX', 'DE', 'MMM',
  'GD', 'NOC', 'EMR', 'ETN', 'ITW',
  // ── Communications / autos / utilities ──
  'T', 'VZ', 'TMUS', 'TSLA', 'F', 'GM', 'CMCSA', 'NEE', 'DUK', 'SO',
];
