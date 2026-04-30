#!/usr/bin/env node
/**
 * compute-accuracy.js v8 — threshold ladder
 * ──────────────────────────────────────────
 * v7 emitted a single hit rate based on `actual >= round(projected)`.
 * That metric is noisy and tied to where the projection happens to fall.
 *
 * v8 adds a fixed threshold ladder so each pick is graded against
 * sportsbook-style integer thresholds (HRR ≥ 1, ≥ 2, ≥ 3, ≥ 4).
 * The ≥2 rate is the headline metric — separates productive games
 * from quiet ones with manageable variance.
 *
 * v7 metrics are preserved unchanged for backward compatibility.
 *
 * Schedule: 4/5/6 AM ET via cron (idempotent — first success wins)
 */

import { Octokit } from "@octokit/rest";
import { yesterdayET, fetchBoxscoresForDate, normName } from "./lib/shared.js";

const HISTORY_FILE = "accuracy-history.json";
const HISTORY_RETENTION_DAYS = 90;

// Threshold ladder — the integer bars each pick is graded against
const THRESHOLDS = [1, 2, 3, 4];

// ── Gist read/write ──────────────────────────────────────
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

// ── Find snapshot ────────────────────────────────────────
async function loadYesterdaySnapshot(octokit, liveGistId, historyGistId, dateStr) {
  const snapshotName = `snapshot-${dateStr}.json`;
  let snapshot = await readGistFile(octokit, historyGistId, snapshotName);
  if (snapshot) {
    console.log(`  Loaded snapshot from history gist: ${snapshotName}`);
    return snapshot;
  }
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

// ── Match snapshot pick to boxscore result ───────────────
function findActual(boxscoreResults, name, team) {
  const exactKey = `${name}_${team}`;
  if (boxscoreResults[exactKey]) return boxscoreResults[exactKey];
  const normTarget = normName(name);
  for (const [key, val] of Object.entries(boxscoreResults)) {
    const [bname, bteam] = key.split("_");
    if (bteam === team && normName(bname) === normTarget) return val;
  }
  for (const [key, val] of Object.entries(boxscoreResults)) {
    const [bname] = key.split("_");
    if (normName(bname) === normTarget) return val;
  }
  return null;
}

// ── Threshold ladder calc for a population ───────────────
// Returns { played, dnp, total, byThreshold: { 1: { hits, rate }, 2: ... } }
function ladderFor(picks, results) {
  const played = [];
  let dnp = 0;
  for (const p of picks) {
    const actual = findActual(results, p.name, p.team);
    if (!actual || !actual.played) { dnp++; continue; }
    played.push({ pick: p, result: actual });
  }
  const byThreshold = {};
  for (const t of THRESHOLDS) {
    const hits = played.filter(({ result }) => result.actual >= t).length;
    const rate = played.length > 0 ? Math.round(hits / played.length * 1000) / 10 : null;
    byThreshold[t] = { hits, rate };
  }
  return { played: played.length, dnp, total: picks.length, byThreshold, playedDetail: played };
}

// ── Compute accuracy for a snapshot ──────────────────────
function computeAccuracy(snapshot, boxscoreData) {
  const { results, gamesScheduled, gamesFinal, gamesProcessed } = boxscoreData;

  const top10 = (snapshot.dailyTop10 || []).filter(p => p.name && p.name !== "Lineup TBD" && !p.isTBD);
  const allPlayers = (snapshot.allPlayers || []).filter(p => p.name && p.name !== "Lineup TBD" && !p.isTBD);

  // ── Top 10 ladder ──
  const top10Ladder = ladderFor(top10, results);

  // ── v7-compat metric: actual ≥ rounded(proj) ──
  let v7Hits = 0;
  const v7Diffs = [];
  const top10Detailed = [];
  for (const p of top10) {
    const actual = findActual(results, p.name, p.team);
    if (!actual) {
      top10Detailed.push({ ...summarizePick(p), actual: null, played: false, reason: "no_boxscore" });
      continue;
    }
    if (!actual.played) {
      top10Detailed.push({ ...summarizePick(p), actual: actual.actual, played: false, atBats: actual.atBats, reason: "no_pa" });
      continue;
    }
    const hit = actual.actual >= Math.round(p.hrr);
    if (hit) v7Hits++;
    v7Diffs.push(actual.actual - p.hrr);
    // Per-pick threshold flags so the dashboard can show a ladder per pick
    const thresholdHits = {};
    for (const t of THRESHOLDS) thresholdHits[t] = actual.actual >= t;
    top10Detailed.push({
      ...summarizePick(p),
      actual: actual.actual,
      played: true,
      atBats: actual.atBats,
      hit,
      thresholdHits,
    });
  }

  const top10HitRate = top10Ladder.played > 0 ? Math.round(v7Hits / top10Ladder.played * 1000) / 10 : null;
  const top10AvgDiff = v7Diffs.length > 0
    ? Math.round(v7Diffs.reduce((a, b) => a + b, 0) / v7Diffs.length * 100) / 100
    : null;
  const top10DNPRate = top10.length > 0
    ? Math.round((top10Ladder.dnp / top10.length) * 1000) / 10
    : null;

  // ── Tier ladders (played-filter applied) ──
  const tierAPlayers = allPlayers.filter(p => p.tier === "A");
  const tierBPlayers = allPlayers.filter(p => p.tier === "B");
  const tierALadder = ladderFor(tierAPlayers, results);
  const tierBLadder = ladderFor(tierBPlayers, results);

  // v7 tier compat (actual ≥ rounded proj)
  const tierHitsCount = (players) => {
    let hits = 0, total = 0;
    for (const p of players) {
      const a = findActual(results, p.name, p.team);
      if (!a || !a.played) continue;
      total++;
      if (a.actual >= Math.round(p.hrr)) hits++;
    }
    return total > 0 ? Math.round(hits / total * 1000) / 10 : null;
  };

  return {
    date: snapshot.date,
    computedAt: new Date().toISOString(),

    // ─── v7-compatible headline metrics (PRESERVED) ───
    top10HitRate,
    top10AvgDiff,
    top10Played: top10Ladder.played,
    top10DNP: top10Ladder.dnp,
    top10DNPRate,
    top10Total: top10.length,
    tierAHitRate: tierHitsCount(tierAPlayers),
    tierBHitRate: tierHitsCount(tierBPlayers),
    tierAPlayed: tierALadder.played,
    tierBPlayed: tierBLadder.played,

    // ─── v8 NEW: threshold ladder (HEADLINE = top10ThresholdRates[2]) ───
    top10ThresholdRates: {
      1: top10Ladder.byThreshold[1].rate,
      2: top10Ladder.byThreshold[2].rate,   // ← primary metric
      3: top10Ladder.byThreshold[3].rate,
      4: top10Ladder.byThreshold[4].rate,
    },
    top10ThresholdHits: {
      1: top10Ladder.byThreshold[1].hits,
      2: top10Ladder.byThreshold[2].hits,
      3: top10Ladder.byThreshold[3].hits,
      4: top10Ladder.byThreshold[4].hits,
    },
    tierAThresholdRates: {
      1: tierALadder.byThreshold[1].rate,
      2: tierALadder.byThreshold[2].rate,
      3: tierALadder.byThreshold[3].rate,
      4: tierALadder.byThreshold[4].rate,
    },
    tierBThresholdRates: {
      1: tierBLadder.byThreshold[1].rate,
      2: tierBLadder.byThreshold[2].rate,
      3: tierBLadder.byThreshold[3].rate,
      4: tierBLadder.byThreshold[4].rate,
    },

    // Game/player counts
    gamesScheduled,
    gamesCompleted: gamesFinal,
    gamesProcessed,
    totalPlayers: allPlayers.length,

    // Detailed top 10 (with per-pick threshold flags)
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

// ── Main ─────────────────────────────────────────────────
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

  console.log(`\n=== compute-accuracy.js v8 — target date: ${targetDate} ===`);
  console.log(`Live gist:    ${liveGistId}`);
  console.log(`History gist: ${historyGistId}${sameGist ? " (same as live)" : ""}\n`);

  const history = (await readGistFile(octokit, historyGistId, HISTORY_FILE)) || { entries: [] };
  if (!Array.isArray(history.entries)) history.entries = [];

  const alreadyDone = history.entries.find(e => e.date === targetDate);
  if (alreadyDone && !process.env.FORCE_RECOMPUTE) {
    // v7 entries don't have top10ThresholdRates — recompute if missing so dashboard ladder works
    if (!alreadyDone.top10ThresholdRates) {
      console.log(`  ${targetDate} already processed but missing threshold ladder — recomputing.`);
    } else {
      console.log(`✓ Already processed ${targetDate} (HRR≥2 hit rate: ${alreadyDone.top10ThresholdRates[2]}%)`);
      console.log(`  Set FORCE_RECOMPUTE=1 to override`);
      process.exit(0);
    }
  }

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

  const boxscoreData = await fetchBoxscoresForDate(targetDate);
  if (boxscoreData.gamesFinal === 0) {
    console.error(`✗ No final games for ${targetDate}. Will retry on next run.`);
    process.exit(2);
  }

  const dayAccuracy = computeAccuracy(snapshot, boxscoreData);

  console.log(`\n=== Results for ${targetDate} ===`);
  console.log(`  Played: ${dayAccuracy.top10Played}/${dayAccuracy.top10Total}  ·  DNP: ${dayAccuracy.top10DNPRate}%`);
  console.log(`  Threshold ladder (top 10):`);
  for (const t of THRESHOLDS) {
    const rate = dayAccuracy.top10ThresholdRates[t];
    const hits = dayAccuracy.top10ThresholdHits[t];
    const marker = t === 2 ? " ← HEADLINE" : "";
    console.log(`    HRR ≥ ${t}:  ${rate != null ? rate + "%" : "—"}  (${hits}/${dayAccuracy.top10Played})${marker}`);
  }
  console.log(`  v7-compat hit rate (actual ≥ round(proj)): ${dayAccuracy.top10HitRate}%`);
  console.log(`  Avg diff:                                  ${dayAccuracy.top10AvgDiff >= 0 ? "+" : ""}${dayAccuracy.top10AvgDiff}`);

  if (dayAccuracy.top10DNPRate >= 30) {
    console.log(`\n  ⚠ HIGH DNP RATE — ${dayAccuracy.top10DNPRate}% of top picks did not play`);
  }

  history.entries = history.entries.filter(e => e.date !== targetDate);
  history.entries.push(dayAccuracy);
  history.entries.sort((a, b) => a.date.localeCompare(b.date));

  if (history.entries.length > HISTORY_RETENTION_DAYS) {
    const removed = history.entries.length - HISTORY_RETENTION_DAYS;
    history.entries = history.entries.slice(-HISTORY_RETENTION_DAYS);
    console.log(`  Pruned ${removed} oldest entries`);
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
