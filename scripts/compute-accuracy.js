#!/usr/bin/env node
/**
 * compute-accuracy.js — Nightly accuracy calculation
 * ───────────────────────────────────────────────────
 * Runs separately from generate-hrr.js to fix the silent-failure problem
 * where one bad accuracy calc per day = permanent data loss.
 *
 * Schedule: 4 AM, 5 AM, 6 AM ET (3 retries via cron)
 * The first run that finds yesterday is unprocessed will process it.
 * Subsequent runs detect "already processed" and exit cleanly.
 *
 * Architecture:
 *   - Reads yesterday's snapshot from snapshots/{date}.json (history Gist)
 *   - Fetches all final boxscores for yesterday
 *   - Computes hit rates with played-filter (separate DNP tracking)
 *   - Appends to accuracy-history.json (history Gist)
 *
 * Uses TWO Gists:
 *   - LIVE Gist (GIST_ID): for daily snapshots (read-write)
 *   - HISTORY Gist (GIST_ID_HISTORY): for accumulated history (write)
 *
 * If GIST_ID_HISTORY is not set, falls back to using LIVE Gist for both
 * (Option 1 mode). This keeps the script working even before you set up
 * the second Gist.
 */

import { Octokit } from "@octokit/rest";
import { yesterdayET, fetchBoxscoresForDate, normName } from "./lib/shared.js";

const HISTORY_FILE = "accuracy-history.json";
const HISTORY_RETENTION_DAYS = 90;

// ── Gist read/write helpers ───────────────────────────
async function readGistFile(octokit, gistId, filename) {
  try {
    const res = await octokit.gists.get({ gist_id: gistId });
    const raw = res.data.files?.[filename]?.content;
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    console.log(`  Could not read ${filename} from gist ${gistId}: ${e.message}`);
    return null;
  }
}

async function writeGistFile(octokit, gistId, filename, data) {
  await octokit.gists.update({
    gist_id: gistId,
    files: { [filename]: { content: JSON.stringify(data) } },
  });
  console.log(`  Wrote ${filename} to gist ${gistId}`);
}

// ── Find the snapshot for yesterday ───────────────────
async function loadYesterdaySnapshot(octokit, liveGistId, historyGistId, dateStr) {
  // Try history Gist first (snapshots/YYYY-MM-DD.json)
  const snapshotName = `snapshot-${dateStr}.json`;
  let snapshot = await readGistFile(octokit, historyGistId, snapshotName);
  if (snapshot) {
    console.log(`  Loaded snapshot from history gist: ${snapshotName}`);
    return snapshot;
  }

  // Fall back to live gist (legacy: hrr-data.json with date matching)
  const liveData = await readGistFile(octokit, liveGistId, "hrr-data.json");
  if (liveData && liveData.date === dateStr && liveData.dailyTop10?.length) {
    console.log(`  Loaded snapshot from live gist (legacy fallback)`);
    return {
      date: dateStr,
      dailyTop10: liveData.dailyTop10,
      allPlayers: liveData.allPlayers || [],
      consideredToday: liveData.consideredToday || [],
    };
  }

  return null;
}

// ── Match player from snapshot to boxscore results ────
function findActual(boxscoreResults, name, team) {
  const exactKey = `${name}_${team}`;
  if (boxscoreResults[exactKey]) return boxscoreResults[exactKey];

  // Fuzzy match by normalized name + team
  const normTarget = normName(name);
  for (const [key, val] of Object.entries(boxscoreResults)) {
    const [bname, bteam] = key.split("_");
    if (bteam === team && normName(bname) === normTarget) return val;
  }
  // Last resort: name only (handles team trade mid-day)
  for (const [key, val] of Object.entries(boxscoreResults)) {
    const [bname] = key.split("_");
    if (normName(bname) === normTarget) return val;
  }
  return null;
}

// ── Compute accuracy for a snapshot ───────────────────
function computeAccuracy(snapshot, boxscoreData) {
  const { results, gamesScheduled, gamesFinal, gamesProcessed } = boxscoreData;

  // ── Top 10 hit rate (played-filter applied) ──
  const top10 = (snapshot.dailyTop10 || []).filter(p => p.name && p.name !== "Lineup TBD" && !p.isTBD);
  let top10Hits = 0, top10Played = 0, top10DNP = 0;
  const top10Diffs = [];
  const top10Detailed = [];

  for (const p of top10) {
    const actual = findActual(results, p.name, p.team);
    if (!actual) {
      top10DNP++;
      top10Detailed.push({ ...summarizePick(p), actual: null, played: false, reason: "no_boxscore" });
      continue;
    }
    if (!actual.played) {
      top10DNP++;
      top10Detailed.push({ ...summarizePick(p), actual: actual.actual, played: false, atBats: actual.atBats, reason: "no_pa" });
      continue;
    }
    top10Played++;
    const hit = actual.actual >= Math.round(p.hrr);
    if (hit) top10Hits++;
    top10Diffs.push(actual.actual - p.hrr);
    top10Detailed.push({ ...summarizePick(p), actual: actual.actual, played: true, atBats: actual.atBats, hit });
  }

  // ── Tier accuracy (played-filter applied) ──
  const allPlayers = (snapshot.allPlayers || []).filter(p => p.name && p.name !== "Lineup TBD" && !p.isTBD);
  let tierAHits = 0, tierATotal = 0, tierBHits = 0, tierBTotal = 0;
  for (const p of allPlayers) {
    const actual = findActual(results, p.name, p.team);
    if (!actual || !actual.played) continue;
    if (p.tier === "A") {
      tierATotal++;
      if (actual.actual >= Math.round(p.hrr)) tierAHits++;
    } else if (p.tier === "B") {
      tierBTotal++;
      if (actual.actual >= Math.round(p.hrr)) tierBHits++;
    }
  }

  const top10HitRate = top10Played > 0 ? Math.round((top10Hits / top10Played) * 1000) / 10 : null;
  const top10AvgDiff = top10Diffs.length > 0
    ? Math.round(top10Diffs.reduce((a, b) => a + b, 0) / top10Diffs.length * 100) / 100
    : null;
  const top10DNPRate = top10.length > 0 ? Math.round((top10DNP / top10.length) * 1000) / 10 : null;

  return {
    date: snapshot.date,
    computedAt: new Date().toISOString(),

    // Headline metrics (with played-filter)
    top10HitRate,
    top10AvgDiff,
    tierAHitRate: tierATotal > 0 ? Math.round((tierAHits / tierATotal) * 1000) / 10 : null,
    tierBHitRate: tierBTotal > 0 ? Math.round((tierBHits / tierBTotal) * 1000) / 10 : null,

    // Diagnostic metrics — these are the new ones that catch the
    // "9.4 confidence → 0 actual" pattern
    top10Played,
    top10DNP,
    top10DNPRate,                      // % of top picks who didn't get a PA
    top10Total: top10.length,
    tierAPlayed: tierATotal,
    tierBPlayed: tierBTotal,

    gamesScheduled,
    gamesCompleted: gamesFinal,
    gamesProcessed,
    totalPlayers: allPlayers.length,

    // Compact top 10 with actual results — same shape as legacy
    top10: top10Detailed,
  };
}

function summarizePick(p) {
  return {
    name: p.name,
    team: p.team,
    pos: p.pos,
    order: p.order,
    hrr: p.hrr,
    tier: p.tier,
    confidence: p.confidence ?? p.dataConfidence ?? null,
    playProbability: p.playProbability ?? null,
    pickScore: p.pickScore ?? null,
  };
}

// ── Main ──────────────────────────────────────────────
async function main() {
  const missing = ["GIST_ID", "GITHUB_TOKEN"].filter(v => !process.env[v]);
  if (missing.length) {
    console.error(`Missing env vars: ${missing.join(", ")}`);
    process.exit(1);
  }

  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  const liveGistId = process.env.GIST_ID;
  const historyGistId = process.env.GIST_ID_HISTORY || liveGistId;
  const sameGist = historyGistId === liveGistId;

  const targetDate = process.env.ACCURACY_DATE || yesterdayET();

  console.log(`\n=== compute-accuracy.js — target date: ${targetDate} ===`);
  console.log(`Live gist:    ${liveGistId}`);
  console.log(`History gist: ${historyGistId}${sameGist ? " (same as live)" : ""}\n`);

  // ── Step 1: Check if already processed ──
  const history = (await readGistFile(octokit, historyGistId, HISTORY_FILE)) || { entries: [] };
  if (!Array.isArray(history.entries)) history.entries = [];

  const alreadyDone = history.entries.find(e => e.date === targetDate);
  if (alreadyDone && !process.env.FORCE_RECOMPUTE) {
    console.log(`✓ Already processed ${targetDate} (top10HitRate: ${alreadyDone.top10HitRate}%)`);
    console.log(`  Set FORCE_RECOMPUTE=1 to override`);
    process.exit(0);
  }

  // ── Step 2: Load snapshot ──
  const snapshot = await loadYesterdaySnapshot(octokit, liveGistId, historyGistId, targetDate);
  if (!snapshot) {
    console.error(`✗ No snapshot found for ${targetDate}. Cannot compute accuracy.`);
    console.error(`  Expected: snapshot-${targetDate}.json in history gist OR matching date in live gist.`);
    process.exit(1);
  }

  if (!snapshot.dailyTop10?.length) {
    console.error(`✗ Snapshot for ${targetDate} has no dailyTop10. Skipping.`);
    process.exit(0);
  }

  // ── Step 3: Fetch boxscores ──
  const boxscoreData = await fetchBoxscoresForDate(targetDate);
  if (boxscoreData.gamesFinal === 0) {
    console.error(`✗ No final games for ${targetDate}. Will retry on next run.`);
    process.exit(2);  // exit code 2 → retry-worthy
  }

  // ── Step 4: Compute ──
  const dayAccuracy = computeAccuracy(snapshot, boxscoreData);

  console.log(`\n=== Results for ${targetDate} ===`);
  console.log(`  Top 10 hit rate (played):     ${dayAccuracy.top10HitRate}% (${dayAccuracy.top10Played}/${dayAccuracy.top10Total} played)`);
  console.log(`  Top 10 DNP rate:              ${dayAccuracy.top10DNPRate}% (${dayAccuracy.top10DNP} did not play)`);
  console.log(`  Top 10 avg diff:              ${dayAccuracy.top10AvgDiff >= 0 ? "+" : ""}${dayAccuracy.top10AvgDiff}`);
  console.log(`  Tier A hit rate:              ${dayAccuracy.tierAHitRate}% (n=${dayAccuracy.tierAPlayed})`);
  console.log(`  Tier B hit rate:              ${dayAccuracy.tierBHitRate}% (n=${dayAccuracy.tierBPlayed})`);

  // Sanity check: warn if DNP rate is unusually high
  if (dayAccuracy.top10DNPRate && dayAccuracy.top10DNPRate >= 30) {
    console.log(`\n  ⚠ HIGH DNP RATE — ${dayAccuracy.top10DNPRate}% of top picks did not play`);
    console.log(`     This indicates the lineup-prediction or play_probability is too lenient.`);
  }

  // ── Step 5: Append + write ──
  history.entries = history.entries.filter(e => e.date !== targetDate);  // remove dupes
  history.entries.push(dayAccuracy);
  history.entries.sort((a, b) => a.date.localeCompare(b.date));

  // Retention
  if (history.entries.length > HISTORY_RETENTION_DAYS) {
    const removed = history.entries.length - HISTORY_RETENTION_DAYS;
    history.entries = history.entries.slice(-HISTORY_RETENTION_DAYS);
    console.log(`  Pruned ${removed} oldest entries (retention: ${HISTORY_RETENTION_DAYS} days)`);
  }

  history.lastUpdated = new Date().toISOString();
  await writeGistFile(octokit, historyGistId, HISTORY_FILE, history);

  console.log(`\n✓ Done. ${history.entries.length} days in history.`);
}

main().catch(err => {
  console.error("Fatal:", err.message);
  console.error(err.stack);
  process.exit(1);
});
