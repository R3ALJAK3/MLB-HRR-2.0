#!/usr/bin/env node
/**
 * MLB HRR Daily Generator v4
 * Uses FREE MLB Stats API only. Zero AI/Anthropic costs.
 */

import { Octokit } from "@octokit/rest";

const MLB_API = "https://statsapi.mlb.com/api/v1";
const TODAY_ET = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const TODAY_DISPLAY = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "America/New_York" });

const PARK_FACTORS = {
  "Coors Field": 1.38, "Great American Ball Park": 1.10, "Globe Life Field": 1.08,
  "Citizens Bank Park": 1.08, "Yankee Stadium": 1.08, "Minute Maid Park": 1.03,
  "Guaranteed Rate Field": 1.02, "Sutter Health Park": 0.93, "Petco Park": 0.93,
  "Dodger Stadium": 0.97, "Oracle Park": 0.92, "T-Mobile Park": 0.95,
  "American Family Field": 0.98, "PNC Park": 0.95, "Truist Park": 1.00,
  "Busch Stadium": 0.98, "Wrigley Field": 1.04, "Camden Yards": 1.02,
  "Fenway Park": 1.05, "Rogers Centre": 1.03, "Tropicana Field": 0.97,
  "Progressive Field": 0.97, "Comerica Park": 0.94, "Kauffman Stadium": 0.97,
  "Target Field": 0.99, "Angel Stadium": 0.97, "Daikin Park": 1.03,
  "loanDepot park": 0.95, "Citi Field": 0.97, "Nationals Park": 1.01,
};

// Cache player stats to avoid duplicate API calls
const playerStatsCache = {};

async function mlbFetch(path) {
  const res = await fetch(`${MLB_API}${path}`);
  if (!res.ok) throw new Error(`MLB API ${res.status}: ${path}`);
  return res.json();
}

async function getTodayGames() {
  console.log(`Fetching schedule for ${TODAY_ET}...`);
  const data = await mlbFetch(`/schedule?sportId=1&date=${TODAY_ET}&hydrate=team,venue,probablePitcher`);
  const games = [];
  for (const date of data.dates || []) {
    for (const game of date.games || []) {
      if (game.status?.abstractGameState === "Final") continue;
      games.push(game);
    }
  }
  console.log(`Found ${games.length} games`);
  return games;
}

async function getPitcherStats(pitcherId) {
  if (!pitcherId) return null;
  try {
    const data = await mlbFetch(`/people/${pitcherId}?hydrate=stats(group=pitching,type=season,season=2026)`);
    const stats = data.people?.[0]?.stats?.[0]?.splits?.[0]?.stat;
    if (!stats) return null;
    const ip = parseFloat(stats.inningsPitched || 0);
    const era = parseFloat(stats.era || 4.50);
    const k9 = ip > 0 ? Math.round((parseInt(stats.strikeOuts || 0) / ip) * 9 * 10) / 10 : 8.5;
    return { era: Math.round(era * 100) / 100, k9, xfip: Math.round(era * 100) / 100 };
  } catch { return null; }
}

async function getPlayerBattingStats(playerId) {
  if (!playerId) return null;
  if (playerStatsCache[playerId]) return playerStatsCache[playerId];
  try {
    const data = await mlbFetch(`/people/${playerId}?hydrate=stats(group=hitting,type=season,season=2026)`);
    const stats = data.people?.[0]?.stats?.[0]?.splits?.[0]?.stat;
    if (!stats) return null;
    const obp = parseFloat(stats.obp || 0);
    const slg = parseFloat(stats.slg || 0);
    const ops = Math.round((obp + slg) * 1000) / 1000;
    // Estimate wRC+ from OPS (rough approximation: league avg OPS ~.720 = wRC+ 100)
    const wrcPlus = Math.round(((ops / 0.720) * 100));
    const result = { ops: ops || 0.720, wrcPlus: wrcPlus || 100 };
    playerStatsCache[playerId] = result;
    return result;
  } catch { return null; }
}

async function getBoxscoreLineup(gamePk, teamId) {
  try {
    const data = await mlbFetch(`/game/${gamePk}/boxscore`);
    const side = data.teams?.away?.team?.id === teamId ? "away" : "home";
    const batterIds = data.teams?.[side]?.battingOrder || [];
    const players = data.teams?.[side]?.players || {};
    const lineup = [];
    for (const id of batterIds.slice(0, 8)) {
      const p = players[`ID${id}`];
      if (!p) continue;
      // Fetch real season stats for this player
      const stats = await getPlayerBattingStats(id);
      lineup.push({
        id,
        name: p.person?.fullName || "Unknown",
        pos: p.position?.abbreviation || "DH",
        order: lineup.length + 1,
        bats: p.batSide?.code || "R",
        ops: stats?.ops || 0.720,
        wrcPlus: stats?.wrcPlus || 100,
        hotStreak: false,
      });
    }
    return lineup;
  } catch { return []; }
}

async function checkHotStreaks(gamePk, teamId, lineup) {
  try {
    // Check last 10 games for each player to find 5+ game hit streaks
    for (const batter of lineup) {
      if (!batter.id) continue;
      try {
        const data = await mlbFetch(`/people/${batter.id}/stats?stats=gameLog&season=2026&group=hitting&limit=10`);
        const games = data.stats?.[0]?.splits || [];
        let streak = 0;
        for (const g of games) {
          if (parseInt(g.stat?.hits || 0) > 0) streak++;
          else break;
        }
        if (streak >= 5) {
          batter.hotStreak = true;
          console.log(`  HOT: ${batter.name} — ${streak} game hit streak`);
        }
      } catch {}
    }
  } catch {}
  return lineup;
}

function computeHRR(batter, oppPitcher, parkFactor) {
  const ops = batter.ops || 0.720;
  const wrc = batter.wrcPlus || 100;
  const talentScore = (Math.min(5, Math.max(1, (ops - 0.5) * 10)) + Math.min(5, Math.max(1, (wrc - 60) * 0.05))) / 2;
  const orderMultiplier = batter.order <= 2 ? 4.5 : batter.order <= 5 ? 4.0 : 2.8;
  let matchup = 3.0;
  const platoon = (batter.bats === "L" && oppPitcher.hand === "R") || (batter.bats === "R" && oppPitcher.hand === "L");
  if (platoon) matchup += 0.7; else matchup -= 0.5;
  if ((oppPitcher.k9 || 0) > 10.0) matchup -= 1.2;
  if ((oppPitcher.era || 4.5) > 4.5) matchup += 0.5;
  const envScore = Math.min(5, Math.max(1, (parkFactor - 0.85) * 20));
  let score = talentScore * 0.3 + orderMultiplier * 0.25 + matchup * 0.25 + envScore * 0.2;
  if (batter.hotStreak) score *= 1.1;
  return Math.round(score * 100) / 100;
}

function enrichWithProjections(data) {
  const allPlayers = [];
  data.games.forEach((game) => {
    ["away", "home"].forEach((side) => {
      const team = game[side];
      const oppPitcher = game[side === "away" ? "home" : "away"].pitcher;
      team.lineup.forEach((batter) => {
        const hrr = computeHRR(batter, oppPitcher, game.parkFactor);
        batter.hrr = hrr;
        batter.tier = hrr >= 3.2 ? "A" : hrr >= 2.5 ? "B" : "C";
        batter.team = team.abbr;
        batter.gameId = game.id;
        batter.gameTime = game.time;
        allPlayers.push(batter);
      });
    });
  });

  allPlayers.sort((a, b) => b.hrr - a.hrr);
  data.topPlays = allPlayers.slice(0, 15);
  data.allPlayers = allPlayers;

  const teamGroups = {};
  allPlayers.forEach((p) => {
    const key = `${p.team}-${p.gameId}`;
    if (!teamGroups[key]) teamGroups[key] = [];
    teamGroups[key].push(p);
  });

  const stacks2 = [], stacks3 = [];
  Object.entries(teamGroups).forEach(([key, players]) => {
    const sorted = [...players].sort((a, b) => b.hrr - a.hrr);
    const [abbr] = key.split("-");
    const game = data.games.find((g) => g.away.abbr === abbr || g.home.abbr === abbr);
    const opp = game ? (game.away.abbr === abbr ? game.home.abbr : game.away.abbr) : "?";
    if (sorted.length >= 2) { const t = sorted.slice(0, 2); stacks2.push({ team: abbr, opp, time: t[0].gameTime, players: t, total: t.reduce((s, p) => s + p.hrr, 0) }); }
    if (sorted.length >= 3) { const t = sorted.slice(0, 3); stacks3.push({ team: abbr, opp, time: t[0].gameTime, players: t, total: t.reduce((s, p) => s + p.hrr, 0) }); }
  });

  data.stacks2 = stacks2.sort((a, b) => b.total - a.total).slice(0, 10);
  data.stacks3 = stacks3.sort((a, b) => b.total - a.total).slice(0, 10);
  return data;
}

async function buildGameData(mlbGames) {
  const games = [];
  for (const [i, g] of mlbGames.entries()) {
    try {
      const gamePk = g.gamePk;
      const awayTeam = g.teams.away.team;
      const homeTeam = g.teams.home.team;
      const awayPitcherRaw = g.teams.away.probablePitcher;
      const homePitcherRaw = g.teams.home.probablePitcher;
      const venue = g.venue?.name || "Unknown";
      const parkFactor = PARK_FACTORS[venue] || 1.00;

      const awayPStats = awayPitcherRaw ? await getPitcherStats(awayPitcherRaw.id) : null;
      const homePStats = homePitcherRaw ? await getPitcherStats(homePitcherRaw.id) : null;

      const awayPitcher = {
        name: awayPitcherRaw?.fullName || "TBD",
        hand: awayPitcherRaw?.pitchHand?.code || "R",
        era: awayPStats?.era || 4.50,
        k9: awayPStats?.k9 || 8.5,
        xfip: awayPStats?.xfip || 4.50,
      };
      const homePitcher = {
        name: homePitcherRaw?.fullName || "TBD",
        hand: homePitcherRaw?.pitchHand?.code || "R",
        era: homePStats?.era || 4.50,
        k9: homePStats?.k9 || 8.5,
        xfip: homePStats?.xfip || 4.50,
      };

      console.log(`  Fetching lineups: ${awayTeam.abbreviation} @ ${homeTeam.abbreviation}...`);
      let awayLineup = await getBoxscoreLineup(gamePk, awayTeam.id);
      let homeLineup = await getBoxscoreLineup(gamePk, homeTeam.id);

      if (!awayLineup.length) awayLineup = [{ name: "Lineup TBD", pos: "?", order: 1, bats: "R", ops: 0.720, wrcPlus: 100, hotStreak: false }];
      if (!homeLineup.length) homeLineup = [{ name: "Lineup TBD", pos: "?", order: 1, bats: "R", ops: 0.720, wrcPlus: 100, hotStreak: false }];

      // Check hot streaks
      awayLineup = await checkHotStreaks(gamePk, awayTeam.id, awayLineup);
      homeLineup = await checkHotStreaks(gamePk, homeTeam.id, homeLineup);

      const gameTime = new Date(g.gameDate).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });

      games.push({
        id: i + 1,
        gamePk,
        time: gameTime,
        stadium: `${venue} · ${g.venue?.city || homeTeam.locationName || ""}`,
        parkFactor,
        weatherNote: "",
        weatherRisk: false,
        away: { abbr: awayTeam.abbreviation, name: awayTeam.name, pitcher: awayPitcher, lineup: awayLineup },
        home: { abbr: homeTeam.abbreviation, name: homeTeam.name, pitcher: homePitcher, lineup: homeLineup },
      });
      console.log(`  Done: ${awayTeam.abbreviation} @ ${homeTeam.abbreviation}`);
    } catch (err) {
      console.log(`  Skipped game ${g.gamePk}: ${err.message}`);
    }
  }
  return games;
}

async function uploadToGist(octokit, gistId, data) {
  console.log("Uploading to Gist...");
  await octokit.gists.update({
    gist_id: gistId,
    files: { "hrr-data.json": { content: JSON.stringify(data, null, 2) } },
  });
  console.log(`Gist updated: https://gist.github.com/${gistId}`);
}

async function main() {
  const missingVars = ["GIST_ID", "GITHUB_TOKEN"].filter((v) => !process.env[v]);
  if (missingVars.length) { console.error(`Missing env vars: ${missingVars.join(", ")}`); process.exit(1); }

  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

  console.log(`\n=== MLB HRR Generator v4 — ${TODAY_DISPLAY} ===`);
  console.log(`FREE MLB Stats API — zero AI costs\n`);

  const mlbGames = await getTodayGames();
  if (!mlbGames.length) { console.log("No games today."); process.exit(0); }

  const games = await buildGameData(mlbGames);

  const data = { date: TODAY_ET, generatedAt: new Date().toISOString(), games };
  const enriched = enrichWithProjections(data);

  await uploadToGist(octokit, process.env.GIST_ID, enriched);

  const topPlayer = enriched.topPlays[0];
  console.log(`\nDone! ${enriched.games.length} games · ${enriched.allPlayers.length} players`);
  console.log(`Top play: ${topPlayer?.name} (${topPlayer?.team}) HRR ${topPlayer?.hrr}`);
}

main().catch((err) => { console.error("Fatal error:", err.message); process.exit(1); });
