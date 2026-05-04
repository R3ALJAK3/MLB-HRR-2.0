# MLB HRR 2.0

Daily fantasy baseball projection tool for Hits + Runs + RBIs (HRR), updated 6 times per day via GitHub Actions.

**Live dashboard:** https://r3aljak3.github.io/MLB-HRR-2.0

---

## How it works

A scheduled GitHub Actions workflow runs `scripts/generate-hrr.js` six times daily. The script:

1. Pulls the day's MLB schedule, lineups, and odds from MLB Stats API, Baseball Savant, and The Odds API
2. Builds HRR projections using a weighted formula (talent 30%, matchup 30%, batting order 25%, park/weather 15%)
3. Writes the output JSON to a public Gist
4. The dashboard (`index.html`, hosted on GitHub Pages) reads from that Gist

A separate nightly workflow (`scripts/compute-accuracy.js`) grades the previous day's predictions against actual results.

---

## Local development setup

If you've cloned this repo fresh and want to run it locally:

### Prerequisites

- Node.js 22+ installed
- A GitHub account with a Personal Access Token (gist scope)
- An [Odds API](https://the-odds-api.com) key (free tier works)

### Setup

1. Install dependencies:

```
   npm install
```

2. Create a `.env` file at the repo root by copying the template:

```
   copy .env.example .env
```

(On Mac/Linux: `cp .env.example .env`)

3. Open `.env` and fill in the values:
   - `GIST_ID` — ID of your main HRR data gist (the long hex string in the gist URL)
   - `GIST_ID_HISTORY` — ID of your history snapshot gist
   - `GIST_TOKEN` — GitHub PAT with `gist` scope
   - `GITHUB_TOKEN` — same value as `GIST_TOKEN` (yes, both are needed currently)
   - `ODDS_API_KEY` — your Odds API key

4. Run the pipeline locally:

```
   npm run dev
```

This generates projections, writes to your live Gist, and prints top picks. Takes 1-2 minutes.

---

## Available scripts

- `npm run dev` — runs the full pipeline locally with `.env` loaded
- `npm run validate` — syntax-checks `generate-hrr.js` without executing
- `npm start` — same as `dev` but assumes env vars are set externally (used by GitHub Actions)

---

## Project structure

```
MLB-HRR-2.0/
├── .github/workflows/    # GitHub Actions YAML files
│   ├── daily-hrr.yml         # Runs generate-hrr.js on schedule
│   └── nightly-accuracy.yml  # Runs compute-accuracy.js nightly
├── scripts/
│   ├── lib/                  # Shared helpers (shared.js, confidence.js)
│   ├── generate-hrr.js       # Main projection script (~1,200 lines)
│   └── compute-accuracy.js   # Nightly accuracy grader
├── index.html            # Dashboard UI (vanilla HTML/JS)
├── package.json          # Dependencies and npm scripts
└── .env.example          # Template for required env vars (do NOT commit .env)
```

---

## Secrets management

**Never commit `.env`.** It's already in `.gitignore`. Real secrets live in two places:

- Locally: `.env` file (untracked)
- Production: GitHub repo secrets at `Settings → Secrets and variables → Actions`

If you accidentally commit a token, regenerate it immediately at https://github.com/settings/tokens.

---

## Schedule

GitHub Actions runs `daily-hrr.yml` at 13:00, 15:00, 16:00, 17:00, 19:00, 21:00, 23:00 UTC.

`nightly-accuracy.yml` runs at 08:00, 09:00, 10:00 UTC (multiple retries in case MLB box scores aren't finalized yet).

All times trigger via cron. Manual triggers available via `Run workflow` button on the Actions tab.
