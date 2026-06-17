# LEGAL.md — compliance posture (the spine of the product)

> General information only. This is not legal advice. Engage an AFSL-specialist
> financial-services lawyer to sign off before public launch and before any raise.

## The line we never cross
**Report outcomes, never recommend.** We publish a *backward-looking, measured, attributed*
track record ("Source X tipped ABC on date D → +Y% alpha vs benchmark over 90d"). We never
say "buy this", never publish a "best picks now" list, never publish the founder's own picks
as picks, and never issue a forward steer. A "test" that concludes "→ so buy this" is still
advice. The label ("it's a test / for information / do what you want") does **not** protect
us — the **substance** does (factual, impersonal, general & regular circulation).

This keeps us unlicensed in AU (vs needing an AFSL — cf. Motley Fool AU, AFSL 400691, which
*recommends* and is therefore licensed) and inside the US publisher's exclusion (Lowe v. SEC),
the UK FCA journalist/factual-information exemptions, and EU MiFID II's information-vs-
recommendation line.

## Enforced in code
- `assertFactual(text)` — runs before any newsletter draft / public copy ships. Rejects
  recommendation / forward-looking language. Necessary-not-sufficient: a human still approves.
- `assertNoRawPrices(env, payload)` — every public payload. With `PUBLIC_PRICES=off`
  (default) we publish *derived* returns/alpha only, never raw prices/charts — staying on the
  EODHD **personal** tier. Flipping to raw-price display is a deliberate, licensed,
  commercial-tier decision, not an accident.

## Trading / conflict discipline
- Real buys: small fixed size, **founder's own money**, **disclosed**, entered at the same
  defined point as the paper method, inside a **publication blackout window**. We never
  recommend, so the buy-then-feature pump/front-running pattern does not apply — but the
  disclosure + blackout + tiny-size discipline is mandatory.
- ASX has no retail trading API → all ASX names are paper-traded.

## Funding / managed-investment-scheme (MIS) avoidance
- Any raise = **equity in the media/data OpCo only.**
- **Never** pool outside money into the trading capital and share trading returns — that is a
  managed investment scheme (Corporations Act s9) → AFSL + registration. The verification
  wallet stays tiny and founder-funded. (Code can't enforce a funding fact — this is a
  documented, audited constraint.)

## Data-source licence register
- **EODHD** — market data + corporate actions. Personal tier ≈ $100/mo; public display of
  raw prices/charts = redistribution → commercial tier (~$399+/mo). Held off by
  `PUBLIC_PRICES=off`. Get a written commercial quote (incl. ASX) before flipping it on.
- **Alpaca** — execution; publishing our own executed trades/returns is fine.
- **Podcast Index / podcast RSS** — public; transcribe + index + **snippets only**; never
  republish full transcripts; deep-link/embed handoff for audio (never self-host clips).
  Design to Australia's stricter no-fair-use floor (clears the US too).
- **Bluesky** — firehose free + commercial-clean.
- **Reddit** — commercial display is contract-gated; human-curated only until a contract or a
  derived-metrics-with-link-back posture is cleared with the lawyer.
- **X / Stocktwits** — out of scope (priced out / closed API).
