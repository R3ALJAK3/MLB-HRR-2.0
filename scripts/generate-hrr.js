#!/usr/bin/env node
/**
 * MLB HRR Generator v6 — All Free Data Sources
 * ─────────────────────────────────────────────
 * MLB Stats API     — lineups, pitcher stats, platoon splits, game logs, injuries, BvP
 * Baseball Savant   — xwOBA, barrel%, hard hit%, xERA (no key needed)
 * Open-Meteo        — weather per stadium (no key needed)
 * The Odds API      — Vegas O/U + moneyline → asymmetric implied runs (free key)
 *
 * v6 changes: asymmetric implied runs, 9th batter fix, BvP career data,
 *             granular order multipliers, server-side H/R/RBI breakdown,
 *             stack adjacency correlation, retry logic, accuracy history,
 *             dynamic Savant year
 */

import { Octokit } from "@octokit/rest";

const MLB = "https://statsapi.mlb.com/api/v1";
const TODAY_ET = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const TODAY_DISPLAY = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "America/New_York" });
const CURRENT_YEAR = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }).split("-")[0];

// ── MODEL CONFIGURATION ──────────────────────────────
// All tunable constants in one place. Change values here, not in the functions.
const CONFIG = {
  // League averages (baseline references)
  LEAGUE_XWOBA:     0.315,
  LEAGUE_AVG_OPS:   0.720,
  DEFAULT_AVG:      0.250,
  DEFAULT_OBP:      0.320,
  DEFAULT_SLG:      0.400,
  DEFAULT_WRC:      100,
  DEFAULT_ERA:      4.50,
  DEFAULT_K9:       8.5,

  // HRR component weights (must sum to 1.0)
  WEIGHT_TALENT:    0.30,
  WEIGHT_MATCHUP:   0.30,
  WEIGHT_ORDER:     0.25,
  WEIGHT_PARK:      0.15,

  // Tier thresholds
  TIER_A:           3.20,
  TIER_B:           2.50,

  // Batting order multipliers (PA frequency × run production)
  ORDER_MULT: { 1: 4.8, 2: 4.4, 3: 4.2, 4: 4.0, 5: 3.6, 6: 3.2, 7: 2.8, 8: 2.5, 9: 2.2 },
  ORDER_MULT_DEFAULT: 2.5,

  // Talent score bonuses
  BARREL_THRESHOLD:   10,
  BARREL_BONUS:       0.2,
  HARDHIT_THRESHOLD:  45,
  HARDHIT_BONUS:      0.15,

  // Matchup adjustments
  MATCHUP_BASE:       3.0,
  PLATOON_SCALE:      4,       // multiplier for platoon OPS advantage
  PLATOON_CAP:        1.5,     // max platoon adjustment
  PLATOON_ADVANTAGE:  0.7,     // generic favorable platoon bonus
  PLATOON_PENALTY:    -0.5,    // generic same-side penalty
  PITCHER_ELITE_ERA:  3.0,     // xERA below this = strong penalty
  PITCHER_GOOD_ERA:   3.50,
  PITCHER_BAD_ERA:    5.00,
  PITCHER_AWFUL_ERA:  5.50,
  PITCHER_ELITE_ADJ:  -1.0,
  PITCHER_GOOD_ADJ:   -0.5,
  PITCHER_BAD_ADJ:    0.5,
  PITCHER_AWFUL_ADJ:  0.9,
  K9_HIGH:            10.5,
  K9_MED:             9.5,
  K9_HIGH_ADJ:        -1.2,
  K9_MED_ADJ:         -0.5,

  // Vegas implied run adjustments
  VEGAS_BOOST_HIGH:    6.0,    // implied runs above this → big boost
  VEGAS_BOOST_MED:     5.0,
  VEGAS_PEN_LOW:       4.0,
  VEGAS_PEN_VLOW:      3.5,
  VEGAS_ADJ_HIGH:      0.5,
  VEGAS_ADJ_MED:       0.25,
  VEGAS_ADJ_LOW:       -0.25,
  VEGAS_ADJ_VLOW:      -0.5,

  // BvP (batter vs pitcher) career adjustments — cap scales with sample size
  BVP_MIN_AB:          5,      // minimum AB to use BvP at all
  BVP_FULL_AB:         10,     // AB threshold for full scale (below = half scale)
  BVP_SCALE:           3,      // multiplier for BvP avg difference
  BVP_WEAK_SCALE_MULT: 0.5,   // weak sample (<10 AB) gets half scale
  BVP_CAP_BASE:        0.30,   // minimum cap at 5 AB
  BVP_CAP_PER_AB:      0.02,   // +0.02 cap per AB (17 AB → 0.64 cap)
  BVP_CAP_MAX:         0.80,   // hard ceiling regardless of sample (hit ~25 AB)

  // Streak multipliers
  STREAK_HOT:          1.12,
  STREAK_WARM:         1.05,
  STREAK_COOL:         0.95,
  STREAK_COLD:         0.88,

  // Streak detection thresholds (last10Avg vs season avg)
  STREAK_HOT_RATIO:    1.15,
  STREAK_HOT_MIN_AB:   20,
  STREAK_WARM_RATIO:   1.08,
  STREAK_WARM_MIN_AB:  15,
  STREAK_COLD_RATIO:   0.72,
  STREAK_COLD_MIN_AB:  15,
  STREAK_COOL_RATIO:   0.85,
  STREAK_COOL_MIN_AB:  20,
  HOT_STREAK_GAMES:    5,      // consecutive hit games for hotStreak flag

  // Injury penalty
  INJURY_MULT:         0.80,

  // Weather thresholds
  WIND_STRONG:         15,     // mph
  WIND_NOTABLE:        8,
  WIND_OUT_ADJ:        0.3,
  WIND_IN_ADJ:         -0.3,
  WIND_OUT_DIR_MIN:    180,
  WIND_OUT_DIR_MAX:    315,
  WIND_IN_DIR_MIN:     0,
  WIND_IN_DIR_MAX:     135,
  PRECIP_HIGH:         60,
  PRECIP_MED:          30,
  PRECIP_ADJ:          -0.25,
  COLD_TEMP:           45,
  COLD_ADJ:            -0.2,
  RAIN_RISK_PRECIP:    60,
  RAIN_RISK_COMBO_PRECIP: 40,
  RAIN_RISK_COMBO_WIND:   20,

  // Stack adjacency bonuses
  STACK_ADJ_CONSECUTIVE: 0.15,
  STACK_ADJ_ONE_APART:   0.05,

  // H/R/RBI breakdown weights by batting order
  BREAKDOWN: {
    1: { h: 0.42, r: 0.34, rbi: 0.24 },
    2: { h: 0.40, r: 0.30, rbi: 0.30 },
    3: { h: 0.37, r: 0.26, rbi: 0.37 },
    5: { h: 0.35, r: 0.22, rbi: 0.43 },  // covers 4-5
    9: { h: 0.40, r: 0.22, rbi: 0.38 },  // covers 6-9
  },
};

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
  return withRetry(async () => {
    const res = await fetch(`${MLB}${path}`);
    if (!res.ok) throw new Error(`MLB API ${res.status}: ${path}`);
    return res.json();
  }, path, 2, 1500);
}

async function safeFetch(url, opts = {}) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, ...opts });
    if (!res.ok) return null;
    return res;
  } catch(e) { console.log(`  safeFetch error (${url.slice(0,80)}): ${e.message}`); return null; }
}

// ── Retry wrapper for MLB API ─────────────────────────
async function withRetry(fn, label = "", retries = 2, delayMs = 1500) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === retries) throw e;
      console.log(`  Retry ${i + 1}/${retries} for ${label}: ${e.message}`);
      await new Promise(r => setTimeout(r, delayMs * (i + 1)));
    }
  }
}

// ── Safe numeric parse (NaN → default) ────────────────
function safeFloat(val, fallback = 0) {
  const n = parseFloat(val);
  return isFinite(n) ? n : fallback;
}

// ── Concurrency limiter ───────────────────────────────
// Processes async tasks with a max number of concurrent operations
function createLimiter(concurrency = 8) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (queue.length === 0 || active >= concurrency) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    next();
  });
}
const limit = createLimiter(8); // max 8 concurrent MLB API call chains

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
    const batterURL = `https://baseballsavant.mlb.com/leaderboard/custom?year=${CURRENT_YEAR}&type=batter&filter=&min=10&selections=player_id,player_name,xba,xslg,xwoba,xobp,exit_velocity_avg,barrel_batted_rate,hard_hit_percent&csv=true`;
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
    const pitcherURL = `https://baseballsavant.mlb.com/leaderboard/custom?year=${CURRENT_YEAR}&type=pitcher&filter=&min=5&selections=player_id,player_name,xera,p_k_percent,p_bb_percent,exit_velocity_avg,barrel_batted_rate,hard_hit_percent&csv=true`;
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
    const blowingOut = windDir >= CONFIG.WIND_OUT_DIR_MIN && windDir <= CONFIG.WIND_OUT_DIR_MAX;
    const blowingIn  = windDir >= CONFIG.WIND_IN_DIR_MIN && windDir <= CONFIG.WIND_IN_DIR_MAX;

    let adj = 0;
    let notes = [];

    if (windSpd > CONFIG.WIND_STRONG && blowingOut) { adj += CONFIG.WIND_OUT_ADJ; notes.push(`↑${Math.round(windSpd)}mph out`); }
    else if (windSpd > CONFIG.WIND_STRONG && blowingIn) { adj += CONFIG.WIND_IN_ADJ; notes.push(`↓${Math.round(windSpd)}mph in`); }
    else if (windSpd > CONFIG.WIND_NOTABLE) notes.push(`${Math.round(windSpd)}mph`);

    if (precip > CONFIG.PRECIP_HIGH) { adj += CONFIG.PRECIP_ADJ; notes.push(`${precip}% rain`); }
    else if (precip > CONFIG.PRECIP_MED) notes.push(`${precip}% rain`);

    if (temp < CONFIG.COLD_TEMP) { adj += CONFIG.COLD_ADJ; notes.push(`${Math.round(temp)}°F cold`); }
    else notes.push(`${Math.round(temp)}°F`);

    return {
      note: notes.join(", "),
      risk: precip > CONFIG.RAIN_RISK_PRECIP || (precip > CONFIG.RAIN_RISK_COMBO_PRECIP && windSpd > CONFIG.RAIN_RISK_COMBO_WIND),
      adjustment: Math.round(adj * 100) / 100,
      temp, windSpd, windDir, precip,
    };
  } catch(e) { console.log(`  fetchWeather error (${venue}): ${e.message}`); return { note: "", risk: false, adjustment: 0 }; }
}

// ── Player full stats (season + splits + game log) ─────
async function getFullPlayerStats(playerId) {
  if (!playerId) return null;
  if (playerCache[playerId]) return playerCache[playerId];
  try {
    const [seasonRes, splitsRes, logRes] = await Promise.all([
      mlbFetch(`/people/${playerId}?hydrate=stats(group=hitting,type=season,season=${CURRENT_YEAR})`).catch(() => null),
      mlbFetch(`/people/${playerId}/stats?stats=vsLeft,vsRight&season=${CURRENT_YEAR}&group=hitting`).catch(() => null),
      mlbFetch(`/people/${playerId}/stats?stats=gameLog&season=${CURRENT_YEAR}&group=hitting&limit=15`).catch(() => null),
    ]);

    const seasonStats = seasonRes?.people?.[0]?.stats?.find(s => s.type?.displayName === "season")?.splits?.[0]?.stat;
    const ops = seasonStats ? (safeFloat(seasonStats.obp, 0) + safeFloat(seasonStats.slg, 0)) : CONFIG.LEAGUE_AVG_OPS;
    const avg = safeFloat(seasonStats?.avg, CONFIG.DEFAULT_AVG);
    const obp = safeFloat(seasonStats?.obp, CONFIG.DEFAULT_OBP);
    const slg = safeFloat(seasonStats?.slg, CONFIG.DEFAULT_SLG);
    const pa  = parseInt(seasonStats?.plateAppearances || 0) || 0;

    // xwOBA → approx wRC+
    const sv = savantBatters[String(playerId)];
    const xwoba = sv?.xwoba || null;
    const wrcPlus = xwoba ? Math.round((xwoba / CONFIG.LEAGUE_XWOBA) * 100) : Math.round((ops / CONFIG.LEAGUE_AVG_OPS) * 100);

    // Platoon splits
    let vsLeftOPS = null, vsRightOPS = null;
    if (splitsRes?.stats) {
      for (const stat of splitsRes.stats) {
        const s = stat.splits?.[0]?.stat;
        if (!s) continue;
        const o = safeFloat(s.obp, 0) + safeFloat(s.slg, 0);
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
    if (last10Avg > avg * CONFIG.STREAK_HOT_RATIO && last10AB >= CONFIG.STREAK_HOT_MIN_AB) streakType = "hot";
    else if (last10Avg > avg * CONFIG.STREAK_WARM_RATIO && last10AB >= CONFIG.STREAK_WARM_MIN_AB) streakType = "warm";
    else if (last10Avg < avg * CONFIG.STREAK_COLD_RATIO && last10AB >= CONFIG.STREAK_COLD_MIN_AB) streakType = "cold";
    else if (last10Avg < avg * CONFIG.STREAK_COOL_RATIO && last10AB >= CONFIG.STREAK_COOL_MIN_AB) streakType = "cool";

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
      hotStreak: streak >= CONFIG.HOT_STREAK_GAMES || streakType === "hot",
    };
    playerCache[playerId] = result;
    return result;
  } catch(e) { console.log(`  getFullPlayerStats error (${playerId}): ${e.message}`); return null; }
}

// ── Pitcher enhanced stats ─────────────────────────────
async function getPitcherStats(pitcherId) {
  if (!pitcherId) return null;
  try {
    const data = await mlbFetch(`/people/${pitcherId}?hydrate=stats(group=pitching,type=season,season=${CURRENT_YEAR})`);
    const stats = data.people?.[0]?.stats?.find(s => s.type?.displayName === "season")?.splits?.[0]?.stat;
    if (!stats) return null;
    const ip = safeFloat(stats.inningsPitched, 0);
    const era = safeFloat(stats.era, CONFIG.DEFAULT_ERA);
    const k9  = ip > 0 ? Math.round((parseInt(stats.strikeOuts||0) / ip) * 9 * 10) / 10 : CONFIG.DEFAULT_K9;
    const sv  = savantPitchers[String(pitcherId)];
    const xera = sv?.xera || era; // fall back to ERA if no Savant data
    return { era: Math.round(era * 100) / 100, k9, xera: Math.round(xera * 100) / 100 };
  } catch(e) { console.log(`  getPitcherStats error (${pitcherId}): ${e.message}`); return null; }
}

// ── Injury list ────────────────────────────────────────
let injuredPlayers = new Set();
async function fetchInjuries() {
  try {
    const data = await mlbFetch(`/injuries?season=${CURRENT_YEAR}&sportId=1`);
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

// ── Batter vs Pitcher career stats ────────────────────
const bvpCache = {};
async function getBvPStats(batterId, pitcherId) {
  if (!batterId || !pitcherId) return null;
  const key = `${batterId}_${pitcherId}`;
  if (bvpCache[key] !== undefined) return bvpCache[key];
  try {
    const data = await withRetry(
      () => mlbFetch(`/people/${batterId}/stats?stats=vsPlayer&opposingPlayerId=${pitcherId}&group=hitting`),
      `BvP ${batterId}v${pitcherId}`
    );
    const splits = data.stats?.[0]?.splits || [];
    let totalAB = 0, totalH = 0, totalHR = 0, totalBB = 0, totalPA = 0;
    for (const s of splits) {
      totalAB += parseInt(s.stat?.atBats || 0);
      totalH  += parseInt(s.stat?.hits || 0);
      totalHR += parseInt(s.stat?.homeRuns || 0);
      totalBB += parseInt(s.stat?.baseOnBalls || 0);
      totalPA += parseInt(s.stat?.plateAppearances || 0);
    }
    if (totalAB < 5) { bvpCache[key] = null; return null; }
    const avg = totalH / totalAB;
    const obp = totalPA > 0 ? (totalH + totalBB) / totalPA : avg;
    const slg = totalAB > 0 ? (totalH + totalHR * 3) / totalAB : 0; // rough SLG
    const result = { ab: totalAB, avg: Math.round(avg * 1000) / 1000, ops: Math.round((obp + slg) * 1000) / 1000, hr: totalHR };
    bvpCache[key] = result;
    return result;
  } catch(e) { console.log(`  BvP fetch error (${batterId} vs ${pitcherId}): ${e.message}`); bvpCache[key] = null; return null; }
}

// ── Enhanced HRR model ─────────────────────────────────
function computeHRR(batter, oppPitcher, parkFactor, weatherAdj, teamImpliedRuns) {
  const id    = String(batter.id || "");
  const sv    = savantBatters[id] || {};
  const ops   = batter.ops || CONFIG.LEAGUE_AVG_OPS;
  const wrc   = batter.wrcPlus || CONFIG.DEFAULT_WRC;
  const order = batter.order || 5;

  // ── Talent score ──
  const opsScore  = Math.min(5, Math.max(1, (ops - 0.5) * 10));
  const wrcScore  = Math.min(5, Math.max(1, (wrc - 60) * 0.05));
  let talentScore = (opsScore + wrcScore) / 2;
  if ((sv.barrelPct || 0) > CONFIG.BARREL_THRESHOLD) talentScore += CONFIG.BARREL_BONUS;
  if ((sv.hardHitPct || 0) > CONFIG.HARDHIT_THRESHOLD) talentScore += CONFIG.HARDHIT_BONUS;
  talentScore = Math.min(5, talentScore);

  // ── Matchup score ──
  let matchup = CONFIG.MATCHUP_BASE;
  const platoonOPS = (batter.bats === "L" && oppPitcher.hand === "R") ? batter.vsRightOPS
                   : (batter.bats === "R" && oppPitcher.hand === "L") ? batter.vsLeftOPS
                   : (batter.bats === "L" && oppPitcher.hand === "L") ? batter.vsLeftOPS
                   : batter.vsRightOPS;
  if (platoonOPS) {
    const platoonAdv = (platoonOPS - CONFIG.LEAGUE_AVG_OPS) * CONFIG.PLATOON_SCALE;
    matchup += Math.max(-CONFIG.PLATOON_CAP, Math.min(CONFIG.PLATOON_CAP, platoonAdv));
  } else {
    const sameSide = (batter.bats === "L" && oppPitcher.hand === "L") || (batter.bats === "R" && oppPitcher.hand === "R");
    if (!sameSide) matchup += CONFIG.PLATOON_ADVANTAGE; else matchup += CONFIG.PLATOON_PENALTY;
  }
  // Pitcher quality using xERA
  const pitcherQuality = oppPitcher.xera || oppPitcher.era || CONFIG.DEFAULT_ERA;
  if (pitcherQuality < CONFIG.PITCHER_ELITE_ERA)      matchup += CONFIG.PITCHER_ELITE_ADJ;
  else if (pitcherQuality < CONFIG.PITCHER_GOOD_ERA)   matchup += CONFIG.PITCHER_GOOD_ADJ;
  else if (pitcherQuality > CONFIG.PITCHER_AWFUL_ERA)  matchup += CONFIG.PITCHER_AWFUL_ADJ;
  else if (pitcherQuality > CONFIG.PITCHER_BAD_ERA)    matchup += CONFIG.PITCHER_BAD_ADJ;
  // K suppression
  if ((oppPitcher.k9 || 0) > CONFIG.K9_HIGH) matchup += CONFIG.K9_HIGH_ADJ;
  else if ((oppPitcher.k9 || 0) > CONFIG.K9_MED) matchup += CONFIG.K9_MED_ADJ;
  matchup = Math.max(0.5, Math.min(5, matchup));

  // ── Batting order / run environment ──
  const orderMultiplier = CONFIG.ORDER_MULT[order] || CONFIG.ORDER_MULT_DEFAULT;
  let impliedAdj = 0;
  if (teamImpliedRuns) {
    if (teamImpliedRuns > CONFIG.VEGAS_BOOST_HIGH)     impliedAdj = CONFIG.VEGAS_ADJ_HIGH;
    else if (teamImpliedRuns > CONFIG.VEGAS_BOOST_MED) impliedAdj = CONFIG.VEGAS_ADJ_MED;
    else if (teamImpliedRuns < CONFIG.VEGAS_PEN_VLOW)  impliedAdj = CONFIG.VEGAS_ADJ_VLOW;
    else if (teamImpliedRuns < CONFIG.VEGAS_PEN_LOW)   impliedAdj = CONFIG.VEGAS_ADJ_LOW;
  }

  // ── Park + weather ──
  const pf = parkFactor || 1.00;
  const envScore = Math.min(5, Math.max(1, (pf - 0.85) * 20 + (weatherAdj || 0)));

  // ── Base HRR ──
  let score = talentScore  * CONFIG.WEIGHT_TALENT
            + orderMultiplier * CONFIG.WEIGHT_ORDER
            + matchup      * CONFIG.WEIGHT_MATCHUP
            + envScore     * CONFIG.WEIGHT_PARK
            + impliedAdj;

  // ── BvP career adjustment (cap scales with sample size) ──
  if (batter.bvp && batter.bvp.ab >= CONFIG.BVP_MIN_AB) {
    const ab = batter.bvp.ab;
    const scale = ab >= CONFIG.BVP_FULL_AB ? CONFIG.BVP_SCALE : CONFIG.BVP_SCALE * CONFIG.BVP_WEAK_SCALE_MULT;
    const cap = Math.min(CONFIG.BVP_CAP_MAX, CONFIG.BVP_CAP_BASE + ab * CONFIG.BVP_CAP_PER_AB);
    const bvpAdv = (batter.bvp.avg - (batter.avg || CONFIG.DEFAULT_AVG)) * scale;
    score += Math.max(-cap, Math.min(cap, bvpAdv));
  }

  // ── Hot/cold streak multiplier ──
  if (batter.streakType === "hot")       score *= CONFIG.STREAK_HOT;
  else if (batter.streakType === "warm") score *= CONFIG.STREAK_WARM;
  else if (batter.streakType === "cool") score *= CONFIG.STREAK_COOL;
  else if (batter.streakType === "cold") score *= CONFIG.STREAK_COLD;

  // ── Injury penalty ──
  if (injuredPlayers.has(id)) score *= CONFIG.INJURY_MULT;

  score = Math.round(score * 100) / 100;
  if (!isFinite(score)) {
    console.log(`  WARNING: NaN/Infinite HRR for ${batter.name || batter.id} — defaulting to ${CONFIG.TIER_B}`);
    score = CONFIG.TIER_B;
  }
  return score;
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
    for (const id of batterIds.slice(0, 9)) {
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
  } catch(e) { console.log(`  getBoxscoreLineup error (gamePk=${gamePk}, team=${teamId}): ${e.message}`); return []; }
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
        era:  awayPS?.era  || CONFIG.DEFAULT_ERA,
        k9:   awayPS?.k9   || CONFIG.DEFAULT_K9,
        xera: awayPS?.xera || CONFIG.DEFAULT_ERA,
      };
      const homePitcher = {
        id: String(homePRaw?.id || ""),
        name: homePRaw?.fullName || "TBD",
        hand: homePRaw?.pitchHand?.code || "R",
        era:  homePS?.era  || CONFIG.DEFAULT_ERA,
        k9:   homePS?.k9   || CONFIG.DEFAULT_K9,
        xera: homePS?.xera || CONFIG.DEFAULT_ERA,
      };

      // Lineups
      console.log(`  Building: ${awayTeam.abbreviation} @ ${homeTeam.abbreviation} — SP: ${awayPitcher.name} vs ${homePitcher.name}`);
      let awayLineup = await getBoxscoreLineup(gamePk, awayTeam.id);
      let homeLineup = await getBoxscoreLineup(gamePk, homeTeam.id);
      if (!awayLineup.length) awayLineup = [{ id: "", name: "Lineup TBD", pos: "?", order: 1, bats: "R" }];
      if (!homeLineup.length) homeLineup = [{ id: "", name: "Lineup TBD", pos: "?", order: 1, bats: "R" }];

      // Enrich lineups with full player stats + BvP (concurrency-limited)
      const enrichLineup = async (lineup, oppPitcherId) => {
        return Promise.all(lineup.map(batter => limit(async () => {
          if (!batter.id || batter.name === "Lineup TBD") {
            return { ...batter, ops: CONFIG.LEAGUE_AVG_OPS, avg: CONFIG.DEFAULT_AVG, wrcPlus: CONFIG.DEFAULT_WRC, vsLeftOPS: null, vsRightOPS: null, hitStreak: 0, last10Avg: CONFIG.DEFAULT_AVG, streakType: "neutral", hotStreak: false, barrelPct: null, hardHitPct: null, injured: false, bvp: null };
          }
          const [stats, bvp] = await Promise.all([
            getFullPlayerStats(batter.id),
            oppPitcherId ? getBvPStats(batter.id, oppPitcherId).catch(() => null) : Promise.resolve(null),
          ]);
          return {
            ...batter,
            ops:        stats?.ops        || CONFIG.LEAGUE_AVG_OPS,
            avg:        stats?.avg        || CONFIG.DEFAULT_AVG,
            obp:        stats?.obp        || CONFIG.DEFAULT_OBP,
            slg:        stats?.slg        || CONFIG.DEFAULT_SLG,
            wrcPlus:    stats?.wrcPlus    || CONFIG.DEFAULT_WRC,
            xwoba:      stats?.xwoba      || null,
            barrelPct:  stats?.barrelPct  || null,
            hardHitPct: stats?.hardHitPct || null,
            exitVelo:   stats?.exitVelo   || null,
            vsLeftOPS:  stats?.vsLeftOPS  || null,
            vsRightOPS: stats?.vsRightOPS || null,
            hitStreak:  stats?.hitStreak  || 0,
            last10Avg:  stats?.last10Avg  || stats?.avg || CONFIG.DEFAULT_AVG,
            last10AB:   stats?.last10AB   || 0,
            streakType: stats?.streakType || "neutral",
            hotStreak:  stats?.hotStreak  || false,
            injured:    injuredPlayers.has(batter.id),
            bvp:        bvp,
          };
        })));
      };

      [awayLineup, homeLineup] = await Promise.all([
        enrichLineup(awayLineup, homePRaw?.id),   // away batters face home pitcher
        enrichLineup(homeLineup, awayPRaw?.id),    // home batters face away pitcher
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

// ── H/R/RBI Breakdown by batting order ────────────────
function breakdownHRR(hrr, order) {
  const w = order <= 1 ? CONFIG.BREAKDOWN[1]
          : order <= 2 ? CONFIG.BREAKDOWN[2]
          : order <= 3 ? CONFIG.BREAKDOWN[3]
          : order <= 5 ? CONFIG.BREAKDOWN[5]
          : CONFIG.BREAKDOWN[9];
  return {
    hProj:   Math.round(hrr * w.h * 100) / 100,
    rProj:   Math.round(hrr * w.r * 100) / 100,
    rbiProj: Math.round(hrr * w.rbi * 100) / 100,
  };
}

// ── Projections ────────────────────────────────────────
function enrichWithProjections(data) {
  const allPlayers = [];
  data.games.forEach(game => {
    // Asymmetric implied team runs from odds
    const awayImplied = game.oddsLine?.awayImplied || (game.oddsLine ? game.oddsLine.total / 2 : null);
    const homeImplied = game.oddsLine?.homeImplied || (game.oddsLine ? game.oddsLine.total / 2 : null);

    // Track lineup availability per side
    game.awayLineupAvailable = game.away.lineup.length > 1 || (game.away.lineup[0]?.name !== "Lineup TBD");
    game.homeLineupAvailable = game.home.lineup.length > 1 || (game.home.lineup[0]?.name !== "Lineup TBD");

    ["away", "home"].forEach(side => {
      const team      = game[side];
      const opp       = game[side === "away" ? "home" : "away"];
      const implied   = side === "away" ? awayImplied : homeImplied;
      team.lineup.forEach(batter => {
        const isTBD = !batter.id || batter.name === "Lineup TBD";
        const hrr = computeHRR(batter, opp.pitcher, game.parkFactor, game.weatherAdj, implied);
        const bd  = breakdownHRR(hrr, batter.order);
        batter.hrr      = hrr;
        batter.hProj    = bd.hProj;
        batter.rProj    = bd.rProj;
        batter.rbiProj  = bd.rbiProj;
        batter.tier     = hrr >= CONFIG.TIER_A ? "A" : hrr >= CONFIG.TIER_B ? "B" : "C";
        batter.team     = team.abbr;
        batter.gameId   = game.id;
        batter.gamePk   = game.gamePk;
        batter.gameTime = game.time;
        batter.impliedRuns = implied;
        batter.isTBD    = isTBD;
        // Only include real players in rankings
        if (!isTBD) {
          allPlayers.push(batter);
        }
      });
    });
  });

  allPlayers.sort((a, b) => b.hrr - a.hrr);
  data.topPlays    = allPlayers.slice(0, 15);
  data.allPlayers  = allPlayers;

  // Stacks weighted by implied team total + adjacency bonus
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
    const impl = game?.oddsLine ? (game.away.abbr === abbr ? game.oddsLine.awayImplied : game.oddsLine.homeImplied) || game.oddsLine.total / 2 : null;
    
    // Adjacency bonus: consecutive batting order slots correlate
    const adjBonus = (stack) => {
      const orders = stack.map(p => p.order).sort((a, b) => a - b);
      let bonus = 0;
      for (let i = 1; i < orders.length; i++) {
        if (orders[i] - orders[i - 1] === 1) bonus += CONFIG.STACK_ADJ_CONSECUTIVE;
        else if (orders[i] - orders[i - 1] === 2) bonus += CONFIG.STACK_ADJ_ONE_APART;
      }
      return bonus;
    };
    
    if (sorted.length >= 2) {
      const t = sorted.slice(0, 2);
      const adj = adjBonus(t);
      stacks2.push({ team: abbr, opp, time: t[0].gameTime, players: t, total: Math.round((t.reduce((s, p) => s + p.hrr, 0) + adj) * 100) / 100, impliedRuns: impl, adjacencyBonus: adj });
    }
    if (sorted.length >= 3) {
      const t = sorted.slice(0, 3);
      const adj = adjBonus(t);
      stacks3.push({ team: abbr, opp, time: t[0].gameTime, players: t, total: Math.round((t.reduce((s, p) => s + p.hrr, 0) + adj) * 100) / 100, impliedRuns: impl, adjacencyBonus: adj });
    }
  });
  data.stacks2 = stacks2.sort((a, b) => b.total - a.total).slice(0, 10);
  data.stacks3 = stacks3.sort((a, b) => b.total - a.total).slice(0, 10);
  return data;
}

// ── Vegas Odds — asymmetric implied runs ──────────────
function oddsToProb(americanOdds) {
  if (americanOdds > 0) return 100 / (americanOdds + 100);
  return Math.abs(americanOdds) / (Math.abs(americanOdds) + 100);
}

async function fetchOddsLines() {
  const key = process.env.ODDS_API_KEY;
  if (!key) { console.log("No ODDS_API_KEY — skipping Vegas lines"); return {}; }
  try {
    const url = `https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${key}&regions=us&markets=totals,h2h&oddsFormat=american&dateFormat=iso`;
    const res = await safeFetch(url);
    if (!res) return {};
    const data = await res.json();
    const lines = {};
    for (const game of data) {
      const bk = game.bookmakers?.find(b => b.key === "draftkings" || b.key === "fanduel") || game.bookmakers?.[0];
      if (!bk) continue;
      const over = bk.markets?.find(m => m.key === "totals")?.outcomes?.find(o => o.name === "Over");
      const h2h = bk.markets?.find(m => m.key === "h2h")?.outcomes || [];
      const total = over?.point || null;
      
      // Compute asymmetric implied runs from moneyline
      let awayImplied = total ? total / 2 : null;
      let homeImplied = total ? total / 2 : null;
      if (total && h2h.length >= 2) {
        const awayLine = h2h.find(o => o.name === game.away_team);
        const homeLine = h2h.find(o => o.name === game.home_team);
        if (awayLine?.price != null && homeLine?.price != null) {
          const awayProb = oddsToProb(awayLine.price);
          const homeProb = oddsToProb(homeLine.price);
          const totalProb = awayProb + homeProb;
          if (totalProb > 0) {
            awayImplied = Math.round(total * (awayProb / totalProb) * 100) / 100;
            homeImplied = Math.round(total * (homeProb / totalProb) * 100) / 100;
          }
        }
      }
      
      if (total) {
        lines[`${game.away_team}_${game.home_team}`] = {
          total, bookmaker: bk.title,
          awayImplied, homeImplied,
          awayTeam: game.away_team, homeTeam: game.home_team,
        };
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
  } catch(e) { console.log(`  readExistingGist error: ${e.message}`); return null; }
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

  console.log(`\n=== MLB HRR Generator v6 — ${TODAY_DISPLAY} ===`);
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
    if (g.oddsLine) {
      const ai = g.oddsLine.awayImplied?.toFixed(1) || "?";
      const hi = g.oddsLine.homeImplied?.toFixed(1) || "?";
      console.log(`  Vegas: ${g.away.abbr}@${g.home.abbr} O/U ${g.oddsLine.total} → ${g.away.abbr} ${ai} / ${g.home.abbr} ${hi} (${g.oddsLine.bookmaker})`);
    }
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

  // ── Accuracy history — compute previous day's results on day change ──
  enriched.accuracyHistory = existing?.accuracyHistory || [];
  if (existing && existing.date !== TODAY_ET && existing.dailyTop10?.length) {
    console.log("Computing accuracy for previous day...");
    try {
      const prevDate = existing.date;
      const schedRes = await mlbFetch(`/schedule?sportId=1&date=${prevDate}&hydrate=team,linescore`);
      const prevGames = schedRes.dates?.[0]?.games || [];
      const finalGames = prevGames.filter(g => g.status?.abstractGameState === "Final");
      
      if (finalGames.length > 0) {
        const actualResults = {};
        for (const g of finalGames) {
          try {
            const bs = await mlbFetch(`/game/${g.gamePk}/boxscore`);
            for (const side of ["away", "home"]) {
              const td = bs.teams?.[side];
              if (!td) continue;
              const abbr = td.team?.abbreviation;
              for (const p of Object.values(td.players || {})) {
                const s = p.stats?.batting;
                if (!s || (parseInt(s.atBats || 0)) === 0) continue;
                const key = (p.person?.fullName || "") + "_" + abbr;
                actualResults[key] = parseInt(s.hits || 0) + parseInt(s.runs || 0) + parseInt(s.rbi || 0);
              }
            }
          } catch(e) { console.log(`  Accuracy boxscore error (gamePk=${g.gamePk}): ${e.message}`); }
        }
        
        // Compute top 10 accuracy
        let hits = 0, total = 0, diffs = [];
        for (const p of existing.dailyTop10 || []) {
          const key = p.name + "_" + p.team;
          const actual = actualResults[key];
          if (actual != null) {
            total++;
            if (actual >= Math.round(p.hrr)) hits++;
            diffs.push(actual - p.hrr);
          }
        }
        
        // Tier accuracy
        let tierAHits = 0, tierATotal = 0, tierBHits = 0, tierBTotal = 0;
        for (const p of existing.allPlayers || []) {
          const key = p.name + "_" + p.team;
          const actual = actualResults[key];
          if (actual != null) {
            if (p.tier === "A") { tierATotal++; if (actual >= Math.round(p.hrr)) tierAHits++; }
            if (p.tier === "B") { tierBTotal++; if (actual >= Math.round(p.hrr)) tierBHits++; }
          }
        }
        
        const dayAccuracy = {
          date: prevDate,
          top10HitRate: total > 0 ? Math.round((hits / total) * 1000) / 10 : null,
          top10AvgDiff: diffs.length > 0 ? Math.round(diffs.reduce((a, b) => a + b, 0) / diffs.length * 100) / 100 : null,
          tierAHitRate: tierATotal > 0 ? Math.round((tierAHits / tierATotal) * 1000) / 10 : null,
          tierBHitRate: tierBTotal > 0 ? Math.round((tierBHits / tierBTotal) * 1000) / 10 : null,
          gamesCompleted: finalGames.length,
        };
        enriched.accuracyHistory.push(dayAccuracy);
        // Keep last 30 days
        if (enriched.accuracyHistory.length > 30) enriched.accuracyHistory = enriched.accuracyHistory.slice(-30);
        console.log(`  ${prevDate}: Top 10 hit rate ${dayAccuracy.top10HitRate}%, avg diff ${dayAccuracy.top10AvgDiff}`);
      }
    } catch (e) { console.log("  Accuracy calc error:", e.message); }
  }

  await uploadToGist(octokit, process.env.GIST_ID, enriched);

  const top = enriched.dailyTop10[0];
  console.log(`\n✓ Done! ${enriched.games.length} games · ${enriched.allPlayers.length} players`);
  console.log(`Top play: ${top?.name} (${top?.team}) HRR ${top?.hrr}`);
}

main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
