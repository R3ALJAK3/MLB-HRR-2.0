#!/usr/bin/env node
/**
 * MLB HRR Generator v5 — All Free Data Sources
 * ─────────────────────────────────────────────
 * MLB Stats API     — lineups, pitcher stats, platoon splits, game logs, injuries
 * Baseball Savant   — xwOBA, barrel%, hard hit%, xERA (no key needed)
 * Open-Meteo        — weather per stadium (no key needed)
 * The Odds API      — Vegas O/U lines (free key, optional)
 */

import { Octokit } from "@octokit/rest";

const MLB = "https://statsapi.mlb.com/api/v1";
const TODAY_ET = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const TODAY_DISPLAY = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "America/New_York" });
const LEAGUE_XWOBA = 0.315; // 2025-26 MLB average xwOBA

// ── Stadium coordinates + dome status ─────────────────
const STADIUMS = {
  "Fenway Park":              { lat: 42.3467, lon: -71.0972, domed: false },
  "Yankee Stadium":           { lat: 40.8296, lon: -73.9262, domed: false },
  "Citi Field":               { lat: 40.7571, lon: -73.8458, domed: false },
  "Camden Yards":             { lat: 39.2839, lon: -76.6216, domed: false },
  "Tropicana Field":          { lat: 27.7683, lon: -82.6534, domed: true  },
  "PNC Park":                 { lat: 40.4469, lon: -80.0057, domed: false },
  "Great American Ball Park": { lat: 39.0979, lon: -84.5082, domed: false },
  "Progressive Field":        { lat: 41.4962, lon: -81.6852, domed: false },
  "Comerica Park":            { lat: 42.3390, lon: -83.0486, domed: false },
  "Guaranteed Rate Field":    { lat: 41.8300, lon: -87.6339, domed: false },
  "Wrigley Field":            { lat: 41.9484, lon: -87.6553, domed: false },
  "Kauffman Stadium":         { lat: 39.0517, lon: -94.4803, domed: false },
  "Target Field":             { lat: 44.9817, lon: -93.2779, domed: false },
  "American Family Field":    { lat: 43.0280, lon: -87.9712, domed: false },
  "Busch Stadium":            { lat: 38.6226, lon: -90.1928, domed: false },
  "Globe Life Field":         { lat: 32.7473, lon: -97.0845, domed: true  },
  "Minute Maid Park":         { lat: 29.7572, lon: -95.3555, domed: false },
  "Daikin Park":              { lat: 29.7572, lon: -95.3555, domed: false },
  "Angel Stadium":            { lat: 33.8003, lon: -117.8827, domed: false },
  "Dodger Stadium":           { lat: 34.0739, lon: -118.2400, domed: false },
  "Oracle Park":              { lat: 37.7786, lon: -122.3893, domed: false },
  "T-Mobile Park":            { lat: 47.5914, lon: -122.3325, domed: false },
  "Petco Park":               { lat: 32.7073, lon: -117.1569, domed: false },
  "Coors Field":              { lat: 39.7559, lon: -104.9942, domed: false },
  "loanDepot park":           { lat: 25.7781, lon: -80.2197,  domed: true  },
  "Chase Field":              { lat: 33.4453, lon: -112.0667, domed: true  },
  "Nationals Park":           { lat: 38.8729, lon: -77.0074,  domed: false },
  "Citizens Bank Park":       { lat: 39.9061, lon: -75.1665,  domed: false },
  "Truist Park":              { lat: 33.8908, lon: -84.4678,  domed: false },
  "Rogers Centre":            { lat: 43.6414, lon: -79.3894,  domed: true  },
  "Sutter Health Park":       { lat: 38.5803, lon: -121.5002, domed: false },
};

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
  "Chase Field": 1.02,
};

const TEAM_MAP = {
  "LAA":"Los Angeles Angels","NYY":"New York Yankees","BOS":"Boston Red Sox",
  "TOR":"Toronto Blue Jays","TB":"Tampa Bay Rays","BAL":"Baltimore Orioles",
  "CLE":"Cleveland Guardians","DET":"Detroit Tigers","CWS":"Chicago White Sox",
  "KC":"Kansas City Royals","MIN":"Minnesota Twins","HOU":"Houston Astros",
  "TEX":"Texas Rangers","SEA":"Seattle Mariners","ATH":"Athletics","OAK":"Athletics",
  "NYM":"New York Mets","ATL":"Atlanta Braves","PHI":"Philadelphia Phillies",
  "WSH":"Washington Nationals","MIA":"Miami Marlins","MIL":"Milwaukee Brewers",
  "CHC":"Chicago Cubs","STL":"St. Louis Cardinals","CIN":"Cincinnati Reds",
  "PIT":"Pittsburgh Pirates","LAD":"Los Angeles Dodgers","SF":"San Francisco Giants",
  "SD":"San Diego Padres","ARI":"Arizona Diamondbacks","COL":"Colorado Rockies",
};

const playerCache = {};

// ── Fetch helpers ──────────────────────────────────────
async function mlbFetch(path) {
  const res = await fetch(`${MLB}${path}`);
  if (!res.ok) throw new Error(`MLB API ${res.status}: ${path}`);
  return res.json();
}

async function safeFetch(url, opts = {}) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, ...opts });
    if (!res.ok) return null;
    return res;
  } catch { return null; }
}

// ── Baseball Savant CSV ────────────────────────────────
function parseCSV(text) {
  const lines = text.trim().split("\n");
  const headers = lines[0].split(",").map(h => h.trim().replace(/"/g, ""));
  return lines.slice(1).map(line => {
    const vals = line.split(",").map(v => v.trim().replace(/"/g, ""));
    const obj = {};
    headers.forEach((h, i) => obj[h] = vals[i] || "");
    return obj;
  });
}

let savantBatters = {}, savantPitchers = {};

async function fetchSavantData() {
  console.log("Fetching Baseball Savant data...");
  try {
    const batterURL = `https://baseballsavant.mlb.com/leaderboard/custom?year=2026&type=batter&filter=&min=10&selections=player_id,player_name,xba,xslg,xwoba,xobp,exit_velocity_avg,barrel_batted_rate,hard_hit_percent&csv=true`;
    const res = await safeFetch(batterURL);
    if (res) {
      const text = await res.text();
      const rows = parseCSV(text);
      rows.forEach(r => {
        if (r.player_id) {
          savantBatters[r.player_id] = {
            xwoba: parseFloat(r.xwoba) || null,
            exitVelo: parseFloat(r.exit_velocity_avg) || null,
            barrelPct: parseFloat(r.barrel_batted_rate) || null,
            hardHitPct: parseFloat(r.hard_hit_percent) || null,
            xba: parseFloat(r.xba) || null,
          };
        }
      });
      console.log(`  Savant batters: ${Object.keys(savantBatters).length} players`);
    }
  } catch(e) { console.log("  Savant batter error:", e.message); }

  try {
    const pitcherURL = `https://baseballsavant.mlb.com/leaderboard/custom?year=2026&type=pitcher&filter=&min=5&selections=player_id,player_name,xera,p_k_percent,p_bb_percent,exit_velocity_avg,barrel_batted_rate,hard_hit_percent&csv=true`;
    const res = await safeFetch(pitcherURL);
    if (res) {
      const text = await res.text();
      const rows = parseCSV(text);
      rows.forEach(r => {
        if (r.player_id) {
          savantPitchers[r.player_id] = {
            xera: parseFloat(r.xera) || null,
            kPct: parseFloat(r.p_k_percent) || null,
            bbPct: parseFloat(r.p_bb_percent) || null,
          };
        }
      });
      console.log(`  Savant pitchers: ${Object.keys(savantPitchers).length} players`);
    }
  } catch(e) { console.log("  Savant pitcher error:", e.message); }
}

// ── Weather via Open-Meteo ─────────────────────────────
async function fetchWeather(venue, gameTimeStr) {
  const coords = STADIUMS[venue];
  if (!coords || coords.domed) return { note: "Dome", risk: false, adjustment: 0 };
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}&hourly=temperature_2m,wind_speed_10m,wind_direction_10m,precipitation_probability&wind_speed_unit=mph&temperature_unit=fahrenheit&forecast_days=1&timezone=America%2FNew_York`;
    const res = await safeFetch(url);
    if (!res) return { note: "", risk: false, adjustment: 0 };
    const data = await res.json();

    // Get hour index matching game time
    const [ts, ap] = (gameTimeStr || "7:00 PM").split(" ");
    let [h, m] = ts.split(":").map(Number);
    if (ap === "PM" && h !== 12) h += 12;
    if (ap === "AM" && h === 12) h = 0;
    const idx = Math.min(h, 23);

    const temp = data.hourly?.temperature_2m?.[idx] ?? 72;
    const windSpd = data.hourly?.wind_speed_10m?.[idx] ?? 5;
    const windDir = data.hourly?.wind_direction_10m?.[idx] ?? 180;
    const precip = data.hourly?.precipitation_probability?.[idx] ?? 0;

    // Wind direction: 0=N, 90=E, 180=S, 270=W
    // "Blowing out" = wind coming FROM home plate direction (roughly S/SW for most parks)
    // Simplified: 180-315 degrees = blowing toward outfield = good for hitters
    const blowingOut = windDir >= 180 && windDir <= 315;
    const blowingIn  = windDir >= 0 && windDir <= 135;

    let adj = 0;
    let notes = [];

    if (windSpd > 15 && blowingOut) { adj += 0.3; notes.push(`↑${Math.round(windSpd)}mph out`); }
    else if (windSpd > 15 && blowingIn) { adj -= 0.3; notes.push(`↓${Math.round(windSpd)}mph in`); }
    else if (windSpd > 8) notes.push(`${Math.round(windSpd)}mph`);

    if (precip > 60) { adj -= 0.25; notes.push(`${precip}% rain`); }
    else if (precip > 30) notes.push(`${precip}% rain`);

    if (temp < 45) { adj -= 0.2; notes.push(`${Math.round(temp)}°F cold`); }
    else notes.push(`${Math.round(temp)}°F`);

    return {
      note: notes.join(", "),
      risk: precip > 60 || (precip > 40 && windSpd > 20),
      adjustment: Math.round(adj * 100) / 100,
      temp, windSpd, windDir, precip,
    };
  } catch(e) { return { note: "", risk: false, adjustment: 0 }; }
}

// ── Player full stats (season + splits + game log) ─────
async function getFullPlayerStats(playerId) {
  if (!playerId) return null;
  if (playerCache[playerId]) return playerCache[playerId];
  try {
    const [seasonRes, splitsRes, logRes] = await Promise.all([
      mlbFetch(`/people/${playerId}?hydrate=stats(group=hitting,type=season,season=2026)`).catch(() => null),
      mlbFetch(`/people/${playerId}/stats?stats=vsLeft,vsRight&season=2026&group=hitting`).catch(() => null),
      mlbFetch(`/people/${playerId}/stats?stats=gameLog&season=2026&group=hitting&limit=15`).catch(() => null),
    ]);

    const seasonStats = seasonRes?.people?.[0]?.stats?.find(s => s.type?.displayName === "season")?.splits?.[0]?.stat;
    const ops = seasonStats ? (parseFloat(seasonStats.obp||0) + parseFloat(seasonStats.slg||0)) : 0.720;
    const avg = parseFloat(seasonStats?.avg || 0.250);
    const obp = parseFloat(seasonStats?.obp || 0.320);
    const slg = parseFloat(seasonStats?.slg || 0.400);
    const pa  = parseInt(seasonStats?.plateAppearances || 0);

    // xwOBA → approx wRC+
    const sv = savantBatters[String(playerId)];
    const xwoba = sv?.xwoba || null;
    const wrcPlus = xwoba ? Math.round((xwoba / LEAGUE_XWOBA) * 100) : Math.round((ops / 0.720) * 100);

    // Platoon splits
    let vsLeftOPS = null, vsRightOPS = null;
    if (splitsRes?.stats) {
      for (const stat of splitsRes.stats) {
        const s = stat.splits?.[0]?.stat;
        if (!s) continue;
        const o = parseFloat(s.obp||0) + parseFloat(s.slg||0);
        if (stat.type?.displayName === "vsLeft") vsLeftOPS = o;
        if (stat.type?.displayName === "vsRight") vsRightOPS = o;
      }
    }

    // Game log analysis (last 15 games)
    const gameSplits = logRes?.stats?.[0]?.splits || [];
    let streak = 0, last10Hits = 0, last10AB = 0, last10OPS = null;
    let consecutiveHits = 0;
    for (const g of gameSplits.slice(0, 15)) {
      const s = g.stat;
      const h = parseInt(s.hits || 0);
      const ab = parseInt(s.atBats || 0);
      if (ab === 0) continue;
      last10Hits += h;
      last10AB += ab;
    }
    // Hit streak (consecutive games with a hit from most recent)
    for (const g of gameSplits) {
      if (parseInt(g.stat?.hits || 0) > 0) consecutiveHits++;
      else break;
    }
    streak = consecutiveHits;

    // Rolling avg last 10 games
    const last10Avg = last10AB > 0 ? Math.round((last10Hits / last10AB) * 1000) / 1000 : avg;

    // Hot/cold determination
    let streakType = "neutral";
    if (last10Avg > avg * 1.15 && last10AB >= 20) streakType = "hot";
    else if (last10Avg > avg * 1.08 && last10AB >= 15) streakType = "warm";
    else if (last10Avg < avg * 0.72 && last10AB >= 15) streakType = "cold";
    else if (last10Avg < avg * 0.85 && last10AB >= 20) streakType = "cool";

    const result = {
      ops, avg, obp, slg, pa, wrcPlus, xwoba,
      barrelPct: sv?.barrelPct || null,
      hardHitPct: sv?.hardHitPct || null,
      exitVelo: sv?.exitVelo || null,
      vsLeftOPS, vsRightOPS,
      hitStreak: streak,
      last10Avg,
      last10AB,
      streakType,
      hotStreak: streak >= 5 || streakType === "hot",
    };
    playerCache[playerId] = result;
    return result;
  } catch(e) { return null; }
}

// ── Pitcher enhanced stats ─────────────────────────────
async function getPitcherStats(pitcherId) {
  if (!pitcherId) return null;
  try {
    const data = await mlbFetch(`/people/${pitcherId}?hydrate=stats(group=pitching,type=season,season=2026)`);
    const stats = data.people?.[0]?.stats?.find(s => s.type?.displayName === "season")?.splits?.[0]?.stat;
    if (!stats) return null;
    const ip = parseFloat(stats.inningsPitched || 0);
    const era = parseFloat(stats.era || 4.50);
    const k9  = ip > 0 ? Math.round((parseInt(stats.strikeOuts||0) / ip) * 9 * 10) / 10 : 8.5;
    const sv  = savantPitchers[String(pitcherId)];
    const xera = sv?.xera || era; // fall back to ERA if no Savant data
    return { era: Math.round(era * 100) / 100, k9, xera: Math.round(xera * 100) / 100 };
  } catch { return null; }
}

// ── Injury list ────────────────────────────────────────
let injuredPlayers = new Set();
async function fetchInjuries() {
  try {
    const data = await mlbFetch(`/injuries?season=2026&sportId=1`);
    const injuries = data.injuries || [];
    injuries.forEach(inj => {
      const id = inj.player?.id;
      const status = (inj.status || "").toLowerCase();
      if (id && (status.includes("day-to-day") || status.includes("10-day") || status.includes("15-day") || status.includes("injured"))) {
        injuredPlayers.add(String(id));
      }
    });
    console.log(`  Injuries: ${injuredPlayers.size} players on IL/DTD`);
  } catch(e) { console.log("  Injury fetch error:", e.message); }
}

// ── Enhanced HRR model ─────────────────────────────────
function computeHRR(batter, oppPitcher, parkFactor, weatherAdj, teamImpliedRuns) {
  const id    = String(batter.id || "");
  const sv    = savantBatters[id] || {};
  const ops   = batter.ops || 0.720;
  const wrc   = batter.wrcPlus || 100;
  const order = batter.order || 5;

  // ── Talent score (30%) ──
  const opsScore  = Math.min(5, Math.max(1, (ops - 0.5) * 10));
  const wrcScore  = Math.min(5, Math.max(1, (wrc - 60) * 0.05));
  let talentScore = (opsScore + wrcScore) / 2;
  if ((sv.barrelPct || 0) > 10) talentScore += 0.2;
  if ((sv.hardHitPct || 0) > 45) talentScore += 0.15;
  talentScore = Math.min(5, talentScore);

  // ── Matchup score (30%) ──
  let matchup = 3.0;
  // Real platoon OPS if available
  const platoonOPS = (batter.bats === "L" && oppPitcher.hand === "R") ? batter.vsRightOPS
                   : (batter.bats === "R" && oppPitcher.hand === "L") ? batter.vsLeftOPS
                   : (batter.bats === "L" && oppPitcher.hand === "L") ? batter.vsLeftOPS
                   : batter.vsRightOPS;
  if (platoonOPS) {
    // Use real platoon OPS relative to league average
    const platoonAdv = (platoonOPS - 0.720) * 4;
    matchup += Math.max(-1.5, Math.min(1.5, platoonAdv));
  } else {
    // Fall back to generic platoon adjustment
    const sameSide = (batter.bats === "L" && oppPitcher.hand === "L") || (batter.bats === "R" && oppPitcher.hand === "R");
    if (!sameSide) matchup += 0.7; else matchup -= 0.5;
  }
  // Pitcher quality using xERA (better than ERA)
  const pitcherQuality = oppPitcher.xera || oppPitcher.era || 4.50;
  if (pitcherQuality < 3.0)       matchup -= 1.0;
  else if (pitcherQuality < 3.50) matchup -= 0.5;
  else if (pitcherQuality > 5.00) matchup += 0.5;
  else if (pitcherQuality > 5.50) matchup += 0.9;
  // K suppression
  if ((oppPitcher.k9 || 0) > 10.5) matchup -= 1.2;
  else if ((oppPitcher.k9 || 0) > 9.5) matchup -= 0.5;
  matchup = Math.max(0.5, Math.min(5, matchup));

  // ── Batting order / run environment (25%) ──
  const orderMultiplier = order <= 2 ? 4.5 : order <= 5 ? 4.0 : 2.8;
  // Vegas implied total adjustment
  let impliedAdj = 0;
  if (teamImpliedRuns) {
    if (teamImpliedRuns > 6.0) impliedAdj = 0.5;
    else if (teamImpliedRuns > 5.0) impliedAdj = 0.25;
    else if (teamImpliedRuns < 3.5) impliedAdj = -0.5;
    else if (teamImpliedRuns < 4.0) impliedAdj = -0.25;
  }

  // ── Park + weather (15%) ──
  const pf = parkFactor || 1.00;
  const envScore = Math.min(5, Math.max(1, (pf - 0.85) * 20 + (weatherAdj || 0)));

  // ── Base HRR ──
  let score = talentScore * 0.30
            + orderMultiplier * 0.25
            + matchup * 0.30
            + envScore * 0.15
            + impliedAdj;

  // ── Hot/cold streak multiplier ──
  if (batter.streakType === "hot")  score *= 1.12;
  else if (batter.streakType === "warm")  score *= 1.05;
  else if (batter.streakType === "cool")  score *= 0.95;
  else if (batter.streakType === "cold")  score *= 0.88;

  // ── Injury penalty ──
  if (injuredPlayers.has(id)) score *= 0.80;

  return Math.round(score * 100) / 100;
}

// ── Schedule ───────────────────────────────────────────
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

// ── Boxscore lineup ────────────────────────────────────
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
      lineup.push({
        id: String(id),
        name: p.person?.fullName || "Unknown",
        pos: p.position?.abbreviation || "DH",
        order: lineup.length + 1,
        bats: p.batSide?.code || "R",
      });
    }
    return lineup;
  } catch { return []; }
}

// ── Build game data ────────────────────────────────────
async function buildGameData(mlbGames, oddsLines) {
  const games = [];
  for (const [i, g] of mlbGames.entries()) {
    try {
      const gamePk     = g.gamePk;
      const awayTeam   = g.teams.away.team;
      const homeTeam   = g.teams.home.team;
      const awayPRaw   = g.teams.away.probablePitcher;
      const homePRaw   = g.teams.home.probablePitcher;
      const venue      = g.venue?.name || "Unknown";
      const parkFactor = PARK_FACTORS[venue] || 1.00;

      // Weather
      const gameTime = new Date(g.gameDate).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
      const weather  = await fetchWeather(venue, gameTime);

      // Pitchers
      const [awayPS, homePS] = await Promise.all([
        awayPRaw ? getPitcherStats(awayPRaw.id) : Promise.resolve(null),
        homePRaw ? getPitcherStats(homePRaw.id) : Promise.resolve(null),
      ]);
      const awayPitcher = {
        id: String(awayPRaw?.id || ""),
        name: awayPRaw?.fullName || "TBD",
        hand: awayPRaw?.pitchHand?.code || "R",
        era:  awayPS?.era  || 4.50,
        k9:   awayPS?.k9   || 8.5,
        xera: awayPS?.xera || 4.50,
      };
      const homePitcher = {
        id: String(homePRaw?.id || ""),
        name: homePRaw?.fullName || "TBD",
        hand: homePRaw?.pitchHand?.code || "R",
        era:  homePS?.era  || 4.50,
        k9:   homePS?.k9   || 8.5,
        xera: homePS?.xera || 4.50,
      };

      // Lineups
      console.log(`  Building: ${awayTeam.abbreviation} @ ${homeTeam.abbreviation} — SP: ${awayPitcher.name} vs ${homePitcher.name}`);
      let awayLineup = await getBoxscoreLineup(gamePk, awayTeam.id);
      let homeLineup = await getBoxscoreLineup(gamePk, homeTeam.id);
      if (!awayLineup.length) awayLineup = [{ id: "", name: "Lineup TBD", pos: "?", order: 1, bats: "R" }];
      if (!homeLineup.length) homeLineup = [{ id: "", name: "Lineup TBD", pos: "?", order: 1, bats: "R" }];

      // Enrich lineups with full player stats in parallel
      const enrichLineup = async (lineup) => {
        return Promise.all(lineup.map(async batter => {
          if (!batter.id || batter.name === "Lineup TBD") {
            return { ...batter, ops: 0.720, avg: 0.250, wrcPlus: 100, vsLeftOPS: null, vsRightOPS: null, hitStreak: 0, last10Avg: 0.250, streakType: "neutral", hotStreak: false, barrelPct: null, hardHitPct: null, injured: false };
          }
          const stats = await getFullPlayerStats(batter.id);
          return {
            ...batter,
            ops:        stats?.ops        || 0.720,
            avg:        stats?.avg        || 0.250,
            obp:        stats?.obp        || 0.320,
            slg:        stats?.slg        || 0.400,
            wrcPlus:    stats?.wrcPlus    || 100,
            xwoba:      stats?.xwoba      || null,
            barrelPct:  stats?.barrelPct  || null,
            hardHitPct: stats?.hardHitPct || null,
            exitVelo:   stats?.exitVelo   || null,
            vsLeftOPS:  stats?.vsLeftOPS  || null,
            vsRightOPS: stats?.vsRightOPS || null,
            hitStreak:  stats?.hitStreak  || 0,
            last10Avg:  stats?.last10Avg  || stats?.avg || 0.250,
            last10AB:   stats?.last10AB   || 0,
            streakType: stats?.streakType || "neutral",
            hotStreak:  stats?.hotStreak  || false,
            injured:    injuredPlayers.has(batter.id),
          };
        }));
      };

      [awayLineup, homeLineup] = await Promise.all([
        enrichLineup(awayLineup),
        enrichLineup(homeLineup),
      ]);

      // Find Vegas line for this game
      const oddsLine = findOddsLine({ away: { abbr: awayTeam.abbreviation }, home: { abbr: homeTeam.abbreviation } }, oddsLines);

      games.push({
        id: i + 1, gamePk, time: gameTime,
        stadium: `${venue} · ${g.venue?.city || homeTeam.locationName || ""}`,
        parkFactor, weatherNote: weather.note, weatherRisk: weather.risk,
        weatherAdj: weather.adjustment,
        oddsLine,
        away: { abbr: awayTeam.abbreviation, name: awayTeam.name, pitcher: awayPitcher, lineup: awayLineup },
        home: { abbr: homeTeam.abbreviation, name: homeTeam.name, pitcher: homePitcher, lineup: homeLineup },
      });
    } catch(err) {
      console.log(`  Skipped ${g.gamePk}: ${err.message}`);
    }
  }
  return games;
}

// ── Projections ────────────────────────────────────────
function enrichWithProjections(data) {
  const allPlayers = [];
  data.games.forEach(game => {
    // Get implied team runs from odds
    const awayImplied = game.oddsLine ? game.oddsLine.total / 2 : null;
    const homeImplied = game.oddsLine ? game.oddsLine.total / 2 : null;

    ["away", "home"].forEach(side => {
      const team      = game[side];
      const opp       = game[side === "away" ? "home" : "away"];
      const implied   = side === "away" ? awayImplied : homeImplied;
      team.lineup.forEach(batter => {
        const hrr = computeHRR(batter, opp.pitcher, game.parkFactor, game.weatherAdj, implied);
        batter.hrr      = hrr;
        batter.tier     = hrr >= 3.2 ? "A" : hrr >= 2.5 ? "B" : "C";
        batter.team     = team.abbr;
        batter.gameId   = game.id;
        batter.gamePk   = game.gamePk;
        batter.gameTime = game.time;
        allPlayers.push(batter);
      });
    });
  });

  allPlayers.sort((a, b) => b.hrr - a.hrr);
  data.topPlays    = allPlayers.slice(0, 15);
  data.allPlayers  = allPlayers;

  // Stacks weighted by implied team total
  const teamGroups = {};
  allPlayers.forEach(p => {
    const key = `${p.team}-${p.gameId}`;
    if (!teamGroups[key]) teamGroups[key] = [];
    teamGroups[key].push(p);
  });
  const stacks2 = [], stacks3 = [];
  Object.entries(teamGroups).forEach(([key, players]) => {
    const sorted = [...players].sort((a, b) => b.hrr - a.hrr);
    const [abbr] = key.split("-");
    const game = data.games.find(g => g.away.abbr === abbr || g.home.abbr === abbr);
    const opp  = game ? (game.away.abbr === abbr ? game.home.abbr : game.away.abbr) : "?";
    const impl = game?.oddsLine ? game.oddsLine.total / 2 : null;
    if (sorted.length >= 2) { const t = sorted.slice(0, 2); stacks2.push({ team: abbr, opp, time: t[0].gameTime, players: t, total: t.reduce((s,p)=>s+p.hrr,0), impliedRuns: impl }); }
    if (sorted.length >= 3) { const t = sorted.slice(0, 3); stacks3.push({ team: abbr, opp, time: t[0].gameTime, players: t, total: t.reduce((s,p)=>s+p.hrr,0), impliedRuns: impl }); }
  });
  data.stacks2 = stacks2.sort((a, b) => b.total - a.total).slice(0, 10);
  data.stacks3 = stacks3.sort((a, b) => b.total - a.total).slice(0, 10);
  return data;
}

// ── Vegas Odds ─────────────────────────────────────────
async function fetchOddsLines() {
  const key = process.env.ODDS_API_KEY;
  if (!key) { console.log("No ODDS_API_KEY — skipping Vegas lines"); return {}; }
  try {
    const url = `https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${key}&regions=us&markets=totals&oddsFormat=american&dateFormat=iso`;
    const res = await safeFetch(url);
    if (!res) return {};
    const data = await res.json();
    const lines = {};
    for (const game of data) {
      const bk = game.bookmakers?.find(b => b.key === "draftkings" || b.key === "fanduel") || game.bookmakers?.[0];
      const over = bk?.markets?.find(m => m.key === "totals")?.outcomes?.find(o => o.name === "Over");
      if (over?.point) {
        lines[`${game.away_team}_${game.home_team}`] = { total: over.point, bookmaker: bk.title };
      }
    }
    console.log(`Fetched odds for ${Object.keys(lines).length} games`);
    return lines;
  } catch(e) { console.log("Odds error:", e.message); return {}; }
}

function findOddsLine(game, oddsLines) {
  const away = TEAM_MAP[game.away?.abbr] || "";
  const home = TEAM_MAP[game.home?.abbr] || "";
  for (const [key, line] of Object.entries(oddsLines)) {
    if (key.includes(away) || key.includes(home)) return line;
  }
  return null;
}

// ── Gist read/write ────────────────────────────────────
async function readExistingGist(octokit, gistId) {
  try {
    const res = await octokit.gists.get({ gist_id: gistId });
    const raw = res.data.files?.["hrr-data.json"]?.content;
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed.date === TODAY_ET ? parsed : null;
  } catch { return null; }
}

async function uploadToGist(octokit, gistId, data) {
  console.log("Uploading to Gist...");
  await octokit.gists.update({
    gist_id: gistId,
    files: { "hrr-data.json": { content: JSON.stringify(data, null, 2) } },
  });
  console.log(`Gist updated: https://gist.github.com/${gistId}`);
}

// ── Main ───────────────────────────────────────────────
async function main() {
  const missing = ["GIST_ID", "GITHUB_TOKEN"].filter(v => !process.env[v]);
  if (missing.length) { console.error(`Missing env vars: ${missing.join(", ")}`); process.exit(1); }
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

  console.log(`\n=== MLB HRR Generator v5 — ${TODAY_DISPLAY} ===`);
  console.log(`All free data sources — zero AI costs\n`);

  // Parallel pre-fetches
  console.log("Pre-fetching global data...");
  await Promise.all([
    fetchSavantData(),
    fetchInjuries(),
  ]);

  const mlbGames = await getTodayGames();
  if (!mlbGames.length) { console.log("No games today."); process.exit(0); }

  const oddsLines = await fetchOddsLines();

  console.log(`\nBuilding data for ${mlbGames.length} games...`);
  const games = await buildGameData(mlbGames, oddsLines);

  // Vegas log
  games.forEach(g => {
    if (g.oddsLine) console.log(`  Vegas: ${g.away.abbr}@${g.home.abbr} O/U ${g.oddsLine.total} (${g.oddsLine.bookmaker})`);
  });

  const data     = { date: TODAY_ET, generatedAt: new Date().toISOString(), games };
  const enriched = enrichWithProjections(data);

  // Top 10 locking with per-player game-start detection
  const nowET = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const freshTop10 = enriched.allPlayers.slice(0, 10);
  const freshMap   = Object.fromEntries(freshTop10.map(p => [p.name+"_"+p.team, p]));
  const existing   = await readExistingGist(octokit, process.env.GIST_ID);

  if (existing?.dailyTop10?.length) {
    enriched.dailyTop10 = existing.dailyTop10.map(ep => {
      const started = ep.gamePk && mlbGames.some(g => g.gamePk === ep.gamePk && new Date(g.gameDate) < nowET);
      return started ? ep : (freshMap[ep.name+"_"+ep.team] || ep);
    });
    const locked = enriched.dailyTop10.filter((ep, idx) => {
      const started = ep.gamePk && mlbGames.some(g => g.gamePk === ep.gamePk && new Date(g.gameDate) < nowET);
      return started;
    }).length;
    console.log(`Top 10: ${locked} locked, ${10-locked} still flexible`);
  } else {
    enriched.dailyTop10 = freshTop10;
    console.log("Initial top 10 set");
  }

  // Track previously considered players
  const currentKeys  = new Set(enriched.dailyTop10.map(p => p.name+"_"+p.team));
  const prevTop10    = existing?.dailyTop10 || [];
  const prevConsidered = existing?.consideredToday || [];
  const alreadyConsidered = new Set(prevConsidered.map(p => p.name+"_"+p.team));
  const newlyDropped = prevTop10.filter(p => !currentKeys.has(p.name+"_"+p.team) && !alreadyConsidered.has(p.name+"_"+p.team));
  enriched.consideredToday = [
    ...prevConsidered,
    ...newlyDropped.map(p => ({ ...p, droppedAt: new Date().toISOString() }))
  ];
  if (newlyDropped.length) console.log(`Previously considered: +${newlyDropped.length} (${newlyDropped.map(p=>p.name).join(", ")})`);

  await uploadToGist(octokit, process.env.GIST_ID, enriched);

  const top = enriched.dailyTop10[0];
  console.log(`\n✓ Done! ${enriched.games.length} games · ${enriched.allPlayers.length} players`);
  console.log(`Top play: ${top?.name} (${top?.team}) HRR ${top?.hrr}`);
}

main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
