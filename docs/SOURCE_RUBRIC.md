# Source selection policy & rubric

> How share-science decides which tip **sources** it tracks. This is an integrity document: the
> leaderboard is only as defensible as the answer to "why is X tracked and Y not?". Decided
> 2026-06-20 from a 5-lens ultracode review.

## Who decides
The **founder is the sole approver** (pre-launch). A source only becomes pollable when it passes the
rubric below **and** its ToS check is recorded in the admin (`/admin/sources` → *Mark ToS-checked*).
Retiring a source requires a **non-performance reason** — you may not drop a source just because its
track record looks bad (that would be cherry-picking and destroys the empirical claim).

## Eligibility rubric (every line must hold)
1. **Named & identifiable** — a real person or outlet with a stable handle. No anonymous/bot accounts (we score a *reputation*).
2. **Identity verified** — the feed/DID/handle actually resolves to the named person.
3. **Makes real calls** — specific, dated, **directional** (buy/bullish or sell/bearish), falsifiable share calls; ideally ≥3 historical examples.
4. **Datable** — a real public **publish timestamp** is obtainable (the look-ahead anchor; entry = first bar after it).
5. **Ingestable** — reachable via a supported channel (RSS / podcast RSS / Bluesky / manual) and the feed parses at vet time.
6. **ToS-clean** — its terms permit this use; **not** on the NO-GO list (Reddit, Seeking Alpha, Motley Fool — manual paste only). Recorded via `tos_checked`.
7. **No undisclosed conflict** — not a paid promoter; flag if conflicts are admitted.
8. **Not a duplicate identity** — the same person across channels is one entity (de-dup — *planned*, slice 4).
9. **A-priori admission** — the decision to track is made on the criteria above, **before** looking at how its returns turned out. This is the anti-survivorship-bias keystone.

## Process: discover → vet → ToS-check → activate → review
1. **Discover** — skim the wells per channel (finance Substacks, investing-podcast roundups, Bluesky finance lists, named media/broker voices). Capture candidates as you go.
2. **Vet** — run the rubric; validate the feed loads (the *Find feed* helper + the next poll's health signal).
3. **ToS-check** — eyeball the source's terms; click **Mark ToS-checked** (records who/when/note). **No record ⇒ the pollers never touch it** (hard gate).
4. **Activate** — once ToS-checked, the hourly cron polls it automatically.
5. **Review** — watch per-source **health** (failing feeds), **tip volume**, and **abstain rate** on `/admin/sources`. Retire only for a non-performance reason (dead feed, ToS change, off-topic, deletion request) — settled history is preserved.

## Visibility floor
A source appears on the **public leaderboard** only after **≥5 settled tips** (`MIN_PUBLIC_TIPS`). The
Wilson lower-bound score already discounts small samples; this floor prevents a noisy public debut on
1–2 lucky calls.

## What this is enforced by (today)
- **Hard ToS gate** — `rss.ts` / `bluesky.ts` / `podcast.ts` pollers select `... AND tos_checked = 1`.
- **ToS sign-off recorded** — `tos_checked_at` / `tos_checked_by` / `tos_note` (migration 0014); set via `/admin/set-tos`.
- **Per-source health** — `last_success_at` / `last_error` / `consecutive_failures` (migration 0014), set by the pollers, surfaced on `/admin/sources`.
- **Public floor** — `MIN_PUBLIC_TIPS = 5` in `pages.ts`.

## Planned (not yet built)
- **Lifecycle status** (`candidate → vetted → active → paused → retired` + reason) — slice 3.
- **Entity de-dup + conflict flag** (one person across channels; pumper flag) — slice 4.
- **Candidate/rejected pool + batch discovery tooling** — slice 5.
- **Bluesky deletion-honor sweep** (tombstone withdrawn posts) — slice 6.
