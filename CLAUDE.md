# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # install dependencies
npm run dev          # run full pipeline locally (loads .env via dotenv)
npm start            # run pipeline assuming env vars set externally (CI)
npm run validate     # syntax-check generate-hrr.js without executing
```

To run the accuracy script manually:
```bash
node -r dotenv/config scripts/compute-accuracy.js
```

To target a specific date for accuracy:
```bash
ACCURACY_DATE=2026-05-01 node -r dotenv/config scripts/compute-accuracy.js
```

## Environment

Copy `.env.example` to `.env` and populate:
- `GIST_ID` — main HRR output gist (hrr-data.json)
- `GIST_ID_HISTORY` — history snapshot gist
- `GIST_ID_DEV` — isolated dev/test gist (used automatically when `process.env.CI !== 'true'` and this var is set, instead of the production gist)
- `GIST_TOKEN` — GitHub PAT with `gist` scope
- `ODDS_API_KEY` — The Odds API key (free tier works)

## Architecture

**Data flow:**

1. GitHub Actions triggers `scripts/generate-hrr.js` at 7 scheduled times daily
2. Script fetches live data from MLB Stats API, Baseball Savant, Open-Meteo, and The Odds API
3. Computes HRR (Hits + Runs + RBIs) projections; writes JSON to the public Gist
4. `index.html` (GitHub Pages dashboard) reads from that Gist — no backend
5. Nightly `scripts/compute-accuracy.js` runs 3×/night (retries for late box scores), grades yesterday's picks, writes results to the history Gist

**Script responsibilities:**

| File | Role |
|---|---|
| `scripts/generate-hrr.js` | Projection engine — schedule, lineups, odds, HRR formula, Gist write |
| `scripts/compute-accuracy.js` | Accuracy grader — loads snapshot, fetches boxscores, grades vs. threshold ladder, prunes 90-day history |
| `scripts/lib/shared.js` | Shared utilities: `mlbFetch`, `safeFetch`, `withRetry`, `createLimiter`, `fetchBoxscoresForDate`, `normName`, date helpers |
| `scripts/lib/confidence.js` | Confidence scoring + quality gates: `computeDataConfidence`, `computePlayProbability`, `computePickScore`, `passesQualityGate` |
| `index.html` | Vanilla HTML/JS dashboard (no build step) |

## HRR Formula

Weighted formula with four components — all weights in `CONFIG` (generate-hrr.js):
- **Talent 30%** — xwOBA, barrel%, hard hit%, xERA
- **Matchup 30%** — opposing pitcher ERA tiers, handedness splits
- **Batting order 25%** — multipliers 1st (4.8×) → 9th (2.2×)
- **Park/weather 15%** — park factor, wind, temperature

Tier A ≥ 3.2, Tier B ≥ 2.5.

## Confidence Scoring (v8)

`CONF_CONFIG` in `scripts/lib/confidence.js` is the single source of truth for all scoring thresholds.

Top-10 selection gates: `data_confidence ≥ 9.0` AND `play_probability ≥ 0.70`.

`computePickScore` formula: `HRR × (0.70 + dataConfidence × 0.03) × playProbability`

Three lever-2 quality filters exist in `CONF_CONFIG` (defaulting off: `CONF_USE_OPP_ERA`, `CONF_USE_EXCLUDE_COLD`). Enable one at a time and monitor accuracy for 3–5 days before enabling the next.

## Reliability Patterns

- `withRetry(fn, label, retries=2, delayMs=1500)` — exponential backoff for MLB API calls
- `safeFetch(url, opts)` — 8s timeout, no retry; used for optional data (Savant, weather)
- `createLimiter(concurrency=8)` — caps concurrent outbound requests
- `normName(n)` — Unicode normalization for fuzzy batter name matching against boxscores
- `compute-accuracy.js` is idempotent: first successful run wins; pass `FORCE_RECOMPUTE=1` to override
- Accuracy script exits with code `2` when games aren't finalized yet (workflow retries silently)
