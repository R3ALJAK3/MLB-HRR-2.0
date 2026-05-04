#!/usr/bin/env node
/**
 * MLB HRR Generator v7 — Split confidence + nightly accuracy
 * ───────────────────────────────────────────────────────────
 * Changes from v6:
 *   - Accuracy calculation MOVED to compute-accuracy.js (separate cron)
 *   - Confidence split into data_confidence + play_probability
 *   - pickScore = HRR × confMult × playProbability (filters bench risk)
 *   - Top 10 requires both data_confidence ≥ 9.0 AND play_probability ≥ 0.7
 *   - Daily snapshot written to history Gist as snapshot-YYYY-MM-DD.json
 *   - Helper extraction to lib/shared.js for reuse
 *
 * Data sources (all free):
 *   MLB Stats API     — lineups, pitcher stats, splits, BvP, injuries
 *   Baseball Savant   — xwOBA, barrel%, hard hit%, xERA
 *   Open-Meteo        — weather per stadium
 *   The Odds API      — Vegas O/U + moneyline → asymmetric implied runs
 */

import { Octokit } from "@octokit/rest";
import {
  MLB,
  TODAY_ET,
  CURRENT_YEAR,
  mlbFetch,
  safeFetch,
  withRetry,
  safeFloat,
  createLimiter,
} from "./lib/shared.js";
import {
  CONF_CONFIG,
  computeDataConfidence,
  computePlayProbability,
  computePickScore,
  passesQualityGate,
  activeFilters,
} from "./lib/confidence.js";

const TODAY_DISPLAY = new Date().toLocaleDateString("en-US", {
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: "America/New_York",
});

// ── MODEL CONFIGURATION ──────────────────────────────
const CONFIG = {
  // League averages
  LEAGUE_XWOBA: 0.315,
  LEAGUE_AVG_OPS: 0.72,
  DEFAULT_AVG: 0.25,
  DEFAULT_OBP: 0.32,
  DEFAULT_SLG: 0.4,
  DEFAULT_WRC: 100,
  DEFAULT_ERA: 4.5,
  DEFAULT_K9: 8.5,

  // HRR component weights (must sum to 1.0)
  WEIGHT_TALENT: 0.3,
  WEIGHT_MATCHUP: 0.3,
  WEIGHT_ORDER: 0.25,
  WEIGHT_PARK: 0.15,

  // Tier thresholds
  TIER_A: 3.2,
  TIER_B: 2.5,

  // Batting order multipliers
  ORDER_MULT: {
    1: 4.8,
    2: 4.4,
    3: 4.2,
    4: 4.0,
    5: 3.6,
    6: 3.2,
    7: 2.8,
    8: 2.5,
    9: 2.2,
  },
  ORDER_MULT_DEFAULT: 2.5,

  // Talent score bonuses
  BARREL_THRESHOLD: 10,
  BARREL_BONUS: 0.2,
  HARDHIT_THRESHOLD: 45,
  HARDHIT_BONUS: 0.15,

  // Matchup adjustments
  MATCHUP_BASE: 3.0,
  PLATOON_SCALE: 4,
  PLATOON_CAP: 1.5,
  PLATOON_ADVANTAGE: 0.7,
  PLATOON_PENALTY: -0.5,
  PITCHER_ELITE_ERA: 3.0,
  PITCHER_GOOD_ERA: 3.5,
  PITCHER_BAD_ERA: 5.0,
  PITCHER_AWFUL_ERA: 5.5,
  PITCHER_ELITE_ADJ: -1.0,
  PITCHER_GOOD_ADJ: -0.5,
  PITCHER_BAD_ADJ: 0.5,
  PITCHER_AWFUL_ADJ: 0.9,
  K9_HIGH: 10.5,
  K9_MED: 9.5,
  K9_HIGH_ADJ: -1.2,
  K9_MED_ADJ: -0.5,

  // Vegas adjustments
  VEGAS_BOOST_HIGH: 6.0,
  VEGAS_BOOST_MED: 5.0,
  VEGAS_PEN_LOW: 4.0,
  VEGAS_PEN_VLOW: 3.5,
  VEGAS_ADJ_HIGH: 0.5,
  VEGAS_ADJ_MED: 0.25,
  VEGAS_ADJ_LOW: -0.25,
  VEGAS_ADJ_VLOW: -0.5,

  // BvP
  BVP_MIN_AB: 5,
  BVP_FULL_AB: 10,
  BVP_SCALE: 3,
  BVP_WEAK_SCALE_MULT: 0.5,
  BVP_CAP_BASE: 0.3,
  BVP_CAP_PER_AB: 0.02,
  BVP_CAP_MAX: 0.8,

  // Streak multipliers
  STREAK_HOT: 1.12,
  STREAK_WARM: 1.05,
  STREAK_COOL: 0.95,
  STREAK_COLD: 0.88,

  // Streak detection
  STREAK_HOT_RATIO: 1.15,
  STREAK_HOT_MIN_AB: 20,
  STREAK_WARM_RATIO: 1.08,
  STREAK_WARM_MIN_AB: 15,
  STREAK_COLD_RATIO: 0.72,
  STREAK_COLD_MIN_AB: 15,
  STREAK_COOL_RATIO: 0.85,
  STREAK_COOL_MIN_AB: 20,
  HOT_STREAK_GAMES: 5,

  INJURY_MULT: 0.8,
  HOME_BONUS: 0.15,

  // Pitcher recent form
  PITCHER_L3_GOOD: 3.0,
  PITCHER_L3_BAD: 5.5,
  PITCHER_L3_GOOD_ADJ: -0.3,
  PITCHER_L3_BAD_ADJ: 0.4,
  PITCHER_L3_WEIGHTS: [0.5, 0.3, 0.2],

  DAY_GAME_BONUS: 0.05,

  // Weather
  WIND_STRONG: 15,
  WIND_NOTABLE: 8,
  WIND_OUT_ADJ: 0.3,
  WIND_IN_ADJ: -0.3,
  WIND_OUT_DIR_MIN: 180,
  WIND_OUT_DIR_MAX: 315,
  WIND_IN_DIR_MIN: 0,
  WIND_IN_DIR_MAX: 135,
  PRECIP_HIGH: 60,
  PRECIP_MED: 30,
  PRECIP_ADJ: -0.25,
  COLD_TEMP: 45,
  COLD_ADJ: -0.2,
  RAIN_RISK_PRECIP: 60,
  RAIN_RISK_COMBO_PRECIP: 40,
  RAIN_RISK_COMBO_WIND: 20,
  WEATHER_MAX_HOURS_OUT: 8, // skip weather adj if game >8h away (forecast too unreliable)

  // Stack adjacency
  STACK_ADJ_CONSECUTIVE: 0.15,
  STACK_ADJ_ONE_APART: 0.05,

  // H/R/RBI breakdown weights
  BREAKDOWN: {
    1: { h: 0.42, r: 0.34, rbi: 0.24 },
    2: { h: 0.4, r: 0.3, rbi: 0.3 },
    3: { h: 0.37, r: 0.26, rbi: 0.37 },
    5: { h: 0.35, r: 0.22, rbi: 0.43 },
    9: { h: 0.4, r: 0.22, rbi: 0.38 },
  },
};

// ── Stadium coordinates + dome status ─────────────────
const STADIUMS = {
  "Fenway Park": { lat: 42.3467, lon: -71.0972, domed: false },
  "Yankee Stadium": { lat: 40.8296, lon: -73.9262, domed: false },
  "Citi Field": { lat: 40.7571, lon: -73.8458, domed: false },
  "Camden Yards": { lat: 39.2839, lon: -76.6216, domed: false },
  "Tropicana Field": { lat: 27.7683, lon: -82.6534, domed: true },
  "PNC Park": { lat: 40.4469, lon: -80.0057, domed: false },
  "Great American Ball Park": { lat: 39.0979, lon: -84.5082, domed: false },
  "Progressive Field": { lat: 41.4962, lon: -81.6852, domed: false },
  "Comerica Park": { lat: 42.339, lon: -83.0486, domed: false },
  "Guaranteed Rate Field": { lat: 41.83, lon: -87.6339, domed: false },
  "Wrigley Field": { lat: 41.9484, lon: -87.6553, domed: false },
  "Kauffman Stadium": { lat: 39.0517, lon: -94.4803, domed: false },
  "Target Field": { lat: 44.9817, lon: -93.2779, domed: false },
  "American Family Field": { lat: 43.028, lon: -87.9712, domed: false },
  "Busch Stadium": { lat: 38.6226, lon: -90.1928, domed: false },
  "Globe Life Field": { lat: 32.7473, lon: -97.0845, domed: true },
  "Minute Maid Park": { lat: 29.7572, lon: -95.3555, domed: false },
  "Daikin Park": { lat: 29.7572, lon: -95.3555, domed: false },
  "Angel Stadium": { lat: 33.8003, lon: -117.8827, domed: false },
  "Dodger Stadium": { lat: 34.0739, lon: -118.24, domed: false },
  "Oracle Park": { lat: 37.7786, lon: -122.3893, domed: false },
  "T-Mobile Park": { lat: 47.5914, lon: -122.3325, domed: false },
  "Petco Park": { lat: 32.7073, lon: -117.1569, domed: false },
  "Coors Field": { lat: 39.7559, lon: -104.9942, domed: false },
  "loanDepot park": { lat: 25.7781, lon: -80.2197, domed: true },
  "Chase Field": { lat: 33.4453, lon: -112.0667, domed: true },
  "Nationals Park": { lat: 38.8729, lon: -77.0074, domed: false },
  "Citizens Bank Park": { lat: 39.9061, lon: -75.1665, domed: false },
  "Truist Park": { lat: 33.8908, lon: -84.4678, domed: false },
  "Rogers Centre": { lat: 43.6414, lon: -79.3894, domed: true },
  "Sutter Health Park": { lat: 38.5803, lon: -121.5002, domed: false },
};

const PARK_FACTORS = {
  "Coors Field": 1.38,
  "Great American Ball Park": 1.1,
  "Globe Life Field": 1.08,
  "Citizens Bank Park": 1.08,
  "Yankee Stadium": 1.08,
  "Minute Maid Park": 1.03,
  "Guaranteed Rate Field": 1.02,
  "Sutter Health Park": 0.93,
  "Petco Park": 0.93,
  "Dodger Stadium": 0.97,
  "Oracle Park": 0.92,
  "T-Mobile Park": 0.95,
  "American Family Field": 0.98,
  "PNC Park": 0.95,
  "Truist Park": 1.0,
  "Busch Stadium": 0.98,
  "Wrigley Field": 1.04,
  "Camden Yards": 1.02,
  "Fenway Park": 1.05,
  "Rogers Centre": 1.03,
  "Tropicana Field": 0.97,
  "Progressive Field": 0.97,
  "Comerica Park": 0.94,
  "Kauffman Stadium": 0.97,
  "Target Field": 0.99,
  "Angel Stadium": 0.97,
  "Daikin Park": 1.03,
  "loanDepot park": 0.95,
  "Citi Field": 0.97,
  "Nationals Park": 1.01,
  "Chase Field": 1.02,
};

const TEAM_MAP = {
  LAA: "Los Angeles Angels",
  NYY: "New York Yankees",
  BOS: "Boston Red Sox",
  TOR: "Toronto Blue Jays",
  TB: "Tampa Bay Rays",
  BAL: "Baltimore Orioles",
  CLE: "Cleveland Guardians",
  DET: "Detroit Tigers",
  CWS: "Chicago White Sox",
  KC: "Kansas City Royals",
  MIN: "Minnesota Twins",
  HOU: "Houston Astros",
  TEX: "Texas Rangers",
  SEA: "Seattle Mariners",
  ATH: "Athletics",
  OAK: "Athletics",
  NYM: "New York Mets",
  ATL: "Atlanta Braves",
  PHI: "Philadelphia Phillies",
  WSH: "Washington Nationals",
  MIA: "Miami Marlins",
  MIL: "Milwaukee Brewers",
  CHC: "Chicago Cubs",
  STL: "St. Louis Cardinals",
  CIN: "Cincinnati Reds",
  PIT: "Pittsburgh Pirates",
  LAD: "Los Angeles Dodgers",
  SF: "San Francisco Giants",
  SD: "San Diego Padres",
  ARI: "Arizona Diamondbacks",
  COL: "Colorado Rockies",
};

const limit = createLimiter(8);
const playerCache = {};
const pitcherCache = {};
const bvpCache = {};
let savantBatters = {},
  savantPitchers = {};
let injuredPlayers = new Set();

// ── Baseball Savant CSV ────────────────────────────────
function parseCSV(text) {
  const lines = text.trim().split("\n");
  const headers = lines[0].split(",").map((h) => h.trim().replace(/"/g, ""));
  return lines.slice(1).map((line) => {
    const vals = line.split(",").map((v) => v.trim().replace(/"/g, ""));
    const obj = {};
    headers.forEach((h, i) => (obj[h] = vals[i] || ""));
    return obj;
  });
}

async function fetchSavantData() {
  console.log("Fetching Baseball Savant data...");
  try {
    const batterURL = `https://baseballsavant.mlb.com/leaderboard/custom?year=${CURRENT_YEAR}&type=batter&filter=&min=10&selections=player_id,player_name,xba,xslg,xwoba,xobp,exit_velocity_avg,barrel_batted_rate,hard_hit_percent&csv=true`;
    const res = await safeFetch(batterURL);
    if (res) {
      const text = await res.text();
      const rows = parseCSV(text);
      rows.forEach((r) => {
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
      console.log(
        `  Savant batters: ${Object.keys(savantBatters).length} players`,
      );
    }
  } catch (e) {
    console.log("  Savant batter error:", e.message);
  }

  try {
    const pitcherURL = `https://baseballsavant.mlb.com/leaderboard/custom?year=${CURRENT_YEAR}&type=pitcher&filter=&min=5&selections=player_id,player_name,xera,p_k_percent,p_bb_percent,exit_velocity_avg,barrel_batted_rate,hard_hit_percent&csv=true`;
    const res = await safeFetch(pitcherURL);
    if (res) {
      const text = await res.text();
      const rows = parseCSV(text);
      rows.forEach((r) => {
        if (r.player_id) {
          savantPitchers[r.player_id] = {
            xera: parseFloat(r.xera) || null,
            kPct: parseFloat(r.p_k_percent) || null,
            bbPct: parseFloat(r.p_bb_percent) || null,
          };
        }
      });
      console.log(
        `  Savant pitchers: ${Object.keys(savantPitchers).length} players`,
      );
    }
  } catch (e) {
    console.log("  Savant pitcher error:", e.message);
  }
}

// ── Weather (with hours-out filter) ───────────────────
async function fetchWeather(venue, gameTimeStr, hoursUntilGame) {
  const coords = STADIUMS[venue];
  if (!coords) return { note: "", risk: false, adjustment: 0 };
  if (coords.domed) return { note: "Dome", risk: false, adjustment: 0 };

  // Skip weather adj for games far in the future — forecast unreliable
  if (hoursUntilGame > CONFIG.WEATHER_MAX_HOURS_OUT) {
    return { note: "Forecast pending", risk: false, adjustment: 0 };
  }

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}&hourly=temperature_2m,wind_speed_10m,wind_direction_10m,precipitation_probability&wind_speed_unit=mph&temperature_unit=fahrenheit&forecast_days=1&timezone=America%2FNew_York`;
    const res = await safeFetch(url);
    if (!res) return { note: "", risk: false, adjustment: 0 };
    const data = await res.json();

    const [ts, ap] = (gameTimeStr || "7:00 PM").split(" ");
    let [h, m] = ts.split(":").map(Number);
    if (ap === "PM" && h !== 12) h += 12;
    if (ap === "AM" && h === 12) h = 0;
    const idx = Math.min(h, 23);

    const temp = data.hourly?.temperature_2m?.[idx] ?? 72;
    const windSpd = data.hourly?.wind_speed_10m?.[idx] ?? 5;
    const windDir = data.hourly?.wind_direction_10m?.[idx] ?? 180;
    const precip = data.hourly?.precipitation_probability?.[idx] ?? 0;

    const blowingOut =
      windDir >= CONFIG.WIND_OUT_DIR_MIN && windDir <= CONFIG.WIND_OUT_DIR_MAX;
    const blowingIn =
      windDir >= CONFIG.WIND_IN_DIR_MIN && windDir <= CONFIG.WIND_IN_DIR_MAX;

    let adj = 0;
    let notes = [];

    if (windSpd > CONFIG.WIND_STRONG && blowingOut) {
      adj += CONFIG.WIND_OUT_ADJ;
      notes.push(`↑${Math.round(windSpd)}mph out`);
    } else if (windSpd > CONFIG.WIND_STRONG && blowingIn) {
      adj += CONFIG.WIND_IN_ADJ;
      notes.push(`↓${Math.round(windSpd)}mph in`);
    } else if (windSpd > CONFIG.WIND_NOTABLE)
      notes.push(`${Math.round(windSpd)}mph`);

    if (precip > CONFIG.PRECIP_HIGH) {
      adj += CONFIG.PRECIP_ADJ;
      notes.push(`${precip}% rain`);
    } else if (precip > CONFIG.PRECIP_MED) notes.push(`${precip}% rain`);

    if (temp < CONFIG.COLD_TEMP) {
      adj += CONFIG.COLD_ADJ;
      notes.push(`${Math.round(temp)}°F cold`);
    } else notes.push(`${Math.round(temp)}°F`);

    return {
      note: notes.join(", "),
      risk:
        precip > CONFIG.RAIN_RISK_PRECIP ||
        (precip > CONFIG.RAIN_RISK_COMBO_PRECIP &&
          windSpd > CONFIG.RAIN_RISK_COMBO_WIND),
      adjustment: Math.round(adj * 100) / 100,
      temp,
      windSpd,
      windDir,
      precip,
    };
  } catch (e) {
    console.log(`  fetchWeather error (${venue}): ${e.message}`);
    return { note: "", risk: false, adjustment: 0 };
  }
}

// ── Player full stats ──────────────────────────────────
async function getFullPlayerStats(playerId) {
  if (!playerId) return null;
  if (playerCache[playerId]) return playerCache[playerId];
  try {
    const [seasonRes, logRes] = await Promise.all([
      mlbFetch(
        `/people/${playerId}?hydrate=stats(group=hitting,type=season,season=${CURRENT_YEAR})`,
      ).catch(() => null),
      mlbFetch(
        `/people/${playerId}/stats?stats=gameLog&season=${CURRENT_YEAR}&group=hitting&limit=15`,
      ).catch(() => null),
    ]);

    let splitsRes = null;
    const splitsEndpoints = [
      `/people/${playerId}/stats?stats=statSplits&season=${CURRENT_YEAR}&group=hitting&sitCodes=vl,vr`,
      `/people/${playerId}/stats?stats=vsLeft,vsRight&season=${CURRENT_YEAR}&group=hitting`,
    ];
    for (const ep of splitsEndpoints) {
      try {
        const res = await fetch(`${MLB}${ep}`);
        if (res.ok) {
          splitsRes = await res.json();
          break;
        }
      } catch {
        /* try next */
      }
    }

    const seasonStats = seasonRes?.people?.[0]?.stats?.find(
      (s) => s.type?.displayName === "season",
    )?.splits?.[0]?.stat;
    const ops = seasonStats
      ? safeFloat(seasonStats.obp, 0) + safeFloat(seasonStats.slg, 0)
      : CONFIG.LEAGUE_AVG_OPS;
    const avg = safeFloat(seasonStats?.avg, CONFIG.DEFAULT_AVG);
    const obp = safeFloat(seasonStats?.obp, CONFIG.DEFAULT_OBP);
    const slg = safeFloat(seasonStats?.slg, CONFIG.DEFAULT_SLG);
    const pa = parseInt(seasonStats?.plateAppearances || 0) || 0;

    const sv = savantBatters[String(playerId)];
    const xwoba = sv?.xwoba || null;
    const wrcPlus = xwoba
      ? Math.round((xwoba / CONFIG.LEAGUE_XWOBA) * 100)
      : Math.round((ops / CONFIG.LEAGUE_AVG_OPS) * 100);

    let vsLeftOPS = null,
      vsRightOPS = null;
    if (splitsRes?.stats) {
      for (const stat of splitsRes.stats) {
        const typeName = stat.type?.displayName || "";
        if (typeName === "vsLeft" || typeName === "vsRight") {
          const s = stat.splits?.[0]?.stat;
          if (!s) continue;
          const o = safeFloat(s.obp, 0) + safeFloat(s.slg, 0);
          if (typeName === "vsLeft") vsLeftOPS = o;
          if (typeName === "vsRight") vsRightOPS = o;
        }
        if (typeName === "statSplits" || typeName === "statSplit") {
          for (const split of stat.splits || []) {
            const code = split.split?.code || split.split?.description || "";
            const s = split.stat;
            if (!s) continue;
            const o = safeFloat(s.obp, 0) + safeFloat(s.slg, 0);
            if (code === "vl" || code.toLowerCase().includes("left"))
              vsLeftOPS = o;
            if (code === "vr" || code.toLowerCase().includes("right"))
              vsRightOPS = o;
          }
        }
      }
    }

    const gameSplits = logRes?.stats?.[0]?.splits || [];
    let last10Hits = 0,
      last10AB = 0;
    let consecutiveHits = 0;
    for (const g of gameSplits.slice(0, 10)) {
      const s = g.stat;
      const h = parseInt(s.hits || 0);
      const ab = parseInt(s.atBats || 0);
      if (ab === 0) continue;
      last10Hits += h;
      last10AB += ab;
    }
    for (const g of gameSplits) {
      if (parseInt(g.stat?.hits || 0) > 0) consecutiveHits++;
      else break;
    }
    const streak = consecutiveHits;

    const last10Avg =
      last10AB > 0 ? Math.round((last10Hits / last10AB) * 1000) / 1000 : avg;

    let streakType = "neutral";
    if (
      last10Avg > avg * CONFIG.STREAK_HOT_RATIO &&
      last10AB >= CONFIG.STREAK_HOT_MIN_AB
    )
      streakType = "hot";
    else if (
      last10Avg > avg * CONFIG.STREAK_WARM_RATIO &&
      last10AB >= CONFIG.STREAK_WARM_MIN_AB
    )
      streakType = "warm";
    else if (
      last10Avg < avg * CONFIG.STREAK_COLD_RATIO &&
      last10AB >= CONFIG.STREAK_COLD_MIN_AB
    )
      streakType = "cold";
    else if (
      last10Avg < avg * CONFIG.STREAK_COOL_RATIO &&
      last10AB >= CONFIG.STREAK_COOL_MIN_AB
    )
      streakType = "cool";

    const result = {
      ops,
      avg,
      obp,
      slg,
      pa,
      wrcPlus,
      xwoba,
      barrelPct: sv?.barrelPct || null,
      hardHitPct: sv?.hardHitPct || null,
      exitVelo: sv?.exitVelo || null,
      vsLeftOPS,
      vsRightOPS,
      hitStreak: streak,
      last10Avg,
      last10AB,
      streakType,
      hotStreak: streak >= CONFIG.HOT_STREAK_GAMES || streakType === "hot",
    };
    playerCache[playerId] = result;
    return result;
  } catch (e) {
    console.log(`  getFullPlayerStats error (${playerId}): ${e.message}`);
    return null;
  }
}

// ── Pitcher stats ──────────────────────────────────────
async function getPitcherStats(pitcherId) {
  if (!pitcherId) return null;
  if (pitcherCache[pitcherId]) return pitcherCache[pitcherId];
  try {
    const [seasonData, logData] = await Promise.all([
      mlbFetch(
        `/people/${pitcherId}?hydrate=stats(group=pitching,type=season,season=${CURRENT_YEAR})`,
      ),
      mlbFetch(
        `/people/${pitcherId}/stats?stats=gameLog&season=${CURRENT_YEAR}&group=pitching&limit=5`,
      ).catch(() => null),
    ]);
    const stats = seasonData.people?.[0]?.stats?.find(
      (s) => s.type?.displayName === "season",
    )?.splits?.[0]?.stat;
    if (!stats) return null;
    const ip = safeFloat(stats.inningsPitched, 0);
    const era = safeFloat(stats.era, CONFIG.DEFAULT_ERA);
    const k9 =
      ip > 0
        ? Math.round((parseInt(stats.strikeOuts || 0) / ip) * 9 * 10) / 10
        : CONFIG.DEFAULT_K9;
    const sv = savantPitchers[String(pitcherId)];
    const xera = sv?.xera || era;

    const logs = logData?.stats?.[0]?.splits || [];
    const last3 = [];
    for (const g of logs.slice(0, 3)) {
      const s = g.stat;
      const gIP = safeFloat(s?.inningsPitched, 0);
      const gER = parseInt(s?.earnedRuns || 0);
      const gERA = gIP > 0 ? Math.round((gER / gIP) * 9 * 100) / 100 : null;
      last3.push({
        ip: gIP,
        era: gERA,
        k: parseInt(s?.strikeOuts || 0),
        h: parseInt(s?.hits || 0),
        bb: parseInt(s?.baseOnBalls || 0),
        date: g.date || null,
      });
    }
    let last3ERA = null;
    if (last3.length >= 2) {
      const weights = CONFIG.PITCHER_L3_WEIGHTS;
      let wSum = 0,
        wTotal = 0;
      last3.forEach((g, i) => {
        if (g.era != null && weights[i]) {
          wSum += g.era * weights[i];
          wTotal += weights[i];
        }
      });
      last3ERA = wTotal > 0 ? Math.round((wSum / wTotal) * 100) / 100 : null;
    }

    const result = {
      era: Math.round(era * 100) / 100,
      k9,
      xera: Math.round(xera * 100) / 100,
      last3,
      last3ERA,
    };
    pitcherCache[pitcherId] = result;
    return result;
  } catch (e) {
    console.log(`  getPitcherStats error (${pitcherId}): ${e.message}`);
    return null;
  }
}

// ── Injuries ───────────────────────────────────────────
async function fetchInjuries() {
  const endpoints = [
    `/injuries?sportId=1`,
    `/injuries?season=${CURRENT_YEAR}&sportId=1`,
    `/injuries?season=${CURRENT_YEAR}`,
  ];
  for (const ep of endpoints) {
    try {
      const res = await fetch(`${MLB}${ep}`);
      if (!res.ok) continue;
      const data = await res.json();
      const injuries = data.injuries || [];
      if (!injuries.length) continue;
      injuries.forEach((inj) => {
        const id = inj.player?.id;
        const status = (inj.status || "").toLowerCase();
        if (
          id &&
          (status.includes("day-to-day") ||
            status.includes("10-day") ||
            status.includes("15-day") ||
            status.includes("injured"))
        ) {
          injuredPlayers.add(String(id));
        }
      });
      console.log(`  Injuries: ${injuredPlayers.size} players on IL/DTD`);
      return;
    } catch {
      /* try next */
    }
  }
  console.log("  Injury fetch: all endpoints unavailable — skipping");
}

// ── BvP (with deduplicated cache) ─────────────────────
async function getBvPStats(batterId, pitcherId) {
  if (!batterId || !pitcherId) return null;
  const key = `${batterId}_${pitcherId}`;
  if (bvpCache[key] !== undefined) return bvpCache[key];
  try {
    const data = await mlbFetch(
      `/people/${batterId}/stats?stats=vsPlayer&opposingPlayerId=${pitcherId}&group=hitting`,
    );
    const splits = data.stats?.[0]?.splits || [];
    let totalAB = 0,
      totalH = 0,
      totalHR = 0,
      totalBB = 0,
      totalPA = 0,
      totalDoubles = 0,
      totalTriples = 0;
    for (const s of splits) {
      totalAB += parseInt(s.stat?.atBats || 0);
      totalH += parseInt(s.stat?.hits || 0);
      totalHR += parseInt(s.stat?.homeRuns || 0);
      totalBB += parseInt(s.stat?.baseOnBalls || 0);
      totalPA += parseInt(s.stat?.plateAppearances || 0);
      totalDoubles += parseInt(s.stat?.doubles || 0);
      totalTriples += parseInt(s.stat?.triples || 0);
    }
    if (totalAB < 5) {
      bvpCache[key] = null;
      return null;
    }
    const avg = totalH / totalAB;
    const obp = totalPA > 0 ? (totalH + totalBB) / totalPA : avg;
    const singles = totalH - totalDoubles - totalTriples - totalHR;
    const totalBases =
      singles + totalDoubles * 2 + totalTriples * 3 + totalHR * 4;
    const slg = totalAB > 0 ? totalBases / totalAB : 0;
    const result = {
      ab: totalAB,
      avg: Math.round(avg * 1000) / 1000,
      ops: Math.round((obp + slg) * 1000) / 1000,
      hr: totalHR,
    };
    bvpCache[key] = result;
    return result;
  } catch (e) {
    console.log(
      `  BvP fetch error (${batterId} vs ${pitcherId}): ${e.message}`,
    );
    bvpCache[key] = null;
    return null;
  }
}

// ── HRR model (unchanged from v6) ─────────────────────
function computeHRR(
  batter,
  oppPitcher,
  parkFactor,
  weatherAdj,
  teamImpliedRuns,
  isHome,
  isDayGame,
) {
  const id = String(batter.id || "");
  const sv = savantBatters[id] || {};
  const ops = batter.ops || CONFIG.LEAGUE_AVG_OPS;
  const wrc = batter.wrcPlus || CONFIG.DEFAULT_WRC;
  const order = batter.order || 5;
  const bats = batter.bats || "R";

  const opsScore = Math.min(5, Math.max(1, (ops - 0.5) * 10));
  const wrcScore = Math.min(5, Math.max(1, (wrc - 60) * 0.05));
  let talentScore = (opsScore + wrcScore) / 2;
  if ((sv.barrelPct || 0) > CONFIG.BARREL_THRESHOLD)
    talentScore += CONFIG.BARREL_BONUS;
  if ((sv.hardHitPct || 0) > CONFIG.HARDHIT_THRESHOLD)
    talentScore += CONFIG.HARDHIT_BONUS;
  talentScore = Math.min(5, talentScore);

  let matchup = CONFIG.MATCHUP_BASE;
  let platoonOPS = null;
  if (bats === "S") {
    platoonOPS = oppPitcher.hand === "R" ? batter.vsRightOPS : batter.vsLeftOPS;
  } else {
    platoonOPS =
      bats === "L" && oppPitcher.hand === "R"
        ? batter.vsRightOPS
        : bats === "R" && oppPitcher.hand === "L"
          ? batter.vsLeftOPS
          : bats === "L" && oppPitcher.hand === "L"
            ? batter.vsLeftOPS
            : batter.vsRightOPS;
  }
  if (platoonOPS) {
    const platoonAdv =
      (platoonOPS - CONFIG.LEAGUE_AVG_OPS) * CONFIG.PLATOON_SCALE;
    matchup += Math.max(
      -CONFIG.PLATOON_CAP,
      Math.min(CONFIG.PLATOON_CAP, platoonAdv),
    );
  } else {
    const sameSide =
      bats !== "S" &&
      ((bats === "L" && oppPitcher.hand === "L") ||
        (bats === "R" && oppPitcher.hand === "R"));
    if (!sameSide) matchup += CONFIG.PLATOON_ADVANTAGE;
    else matchup += CONFIG.PLATOON_PENALTY;
  }
  const pitcherQuality =
    oppPitcher.xera || oppPitcher.era || CONFIG.DEFAULT_ERA;
  if (pitcherQuality < CONFIG.PITCHER_ELITE_ERA)
    matchup += CONFIG.PITCHER_ELITE_ADJ;
  else if (pitcherQuality < CONFIG.PITCHER_GOOD_ERA)
    matchup += CONFIG.PITCHER_GOOD_ADJ;
  else if (pitcherQuality > CONFIG.PITCHER_AWFUL_ERA)
    matchup += CONFIG.PITCHER_AWFUL_ADJ;
  else if (pitcherQuality > CONFIG.PITCHER_BAD_ERA)
    matchup += CONFIG.PITCHER_BAD_ADJ;
  if ((oppPitcher.k9 || 0) > CONFIG.K9_HIGH) matchup += CONFIG.K9_HIGH_ADJ;
  else if ((oppPitcher.k9 || 0) > CONFIG.K9_MED) matchup += CONFIG.K9_MED_ADJ;
  if (oppPitcher.last3ERA != null) {
    if (oppPitcher.last3ERA < CONFIG.PITCHER_L3_GOOD)
      matchup += CONFIG.PITCHER_L3_GOOD_ADJ;
    else if (oppPitcher.last3ERA > CONFIG.PITCHER_L3_BAD)
      matchup += CONFIG.PITCHER_L3_BAD_ADJ;
  }
  matchup = Math.max(0.5, Math.min(5, matchup));

  const orderMultiplier = CONFIG.ORDER_MULT[order] || CONFIG.ORDER_MULT_DEFAULT;
  let impliedAdj = 0;
  if (teamImpliedRuns) {
    if (teamImpliedRuns > CONFIG.VEGAS_BOOST_HIGH)
      impliedAdj = CONFIG.VEGAS_ADJ_HIGH;
    else if (teamImpliedRuns > CONFIG.VEGAS_BOOST_MED)
      impliedAdj = CONFIG.VEGAS_ADJ_MED;
    else if (teamImpliedRuns < CONFIG.VEGAS_PEN_VLOW)
      impliedAdj = CONFIG.VEGAS_ADJ_VLOW;
    else if (teamImpliedRuns < CONFIG.VEGAS_PEN_LOW)
      impliedAdj = CONFIG.VEGAS_ADJ_LOW;
  }

  const pf = parkFactor || 1.0;
  const envScore = Math.min(
    5,
    Math.max(1, (pf - 0.85) * 20 + (weatherAdj || 0)),
  );

  let score =
    talentScore * CONFIG.WEIGHT_TALENT +
    orderMultiplier * CONFIG.WEIGHT_ORDER +
    matchup * CONFIG.WEIGHT_MATCHUP +
    envScore * CONFIG.WEIGHT_PARK +
    impliedAdj;

  if (isHome) score += CONFIG.HOME_BONUS;
  if (isDayGame) score += CONFIG.DAY_GAME_BONUS;

  if (batter.bvp && batter.bvp.ab >= CONFIG.BVP_MIN_AB) {
    const ab = batter.bvp.ab;
    const scale =
      ab >= CONFIG.BVP_FULL_AB
        ? CONFIG.BVP_SCALE
        : CONFIG.BVP_SCALE * CONFIG.BVP_WEAK_SCALE_MULT;
    const cap = Math.min(
      CONFIG.BVP_CAP_MAX,
      CONFIG.BVP_CAP_BASE + ab * CONFIG.BVP_CAP_PER_AB,
    );
    const bvpAdv =
      (batter.bvp.avg - (batter.avg || CONFIG.DEFAULT_AVG)) * scale;
    score += Math.max(-cap, Math.min(cap, bvpAdv));
  }

  if (batter.streakType === "hot") score *= CONFIG.STREAK_HOT;
  else if (batter.streakType === "warm") score *= CONFIG.STREAK_WARM;
  else if (batter.streakType === "cool") score *= CONFIG.STREAK_COOL;
  else if (batter.streakType === "cold") score *= CONFIG.STREAK_COLD;

  if (injuredPlayers.has(id)) score *= CONFIG.INJURY_MULT;

  score = Math.round(score * 100) / 100;
  if (!isFinite(score)) {
    console.log(
      `  WARNING: NaN/Infinite HRR for ${batter.name || batter.id} — defaulting to ${CONFIG.TIER_B}`,
    );
    score = CONFIG.TIER_B;
  }
  return score;
}

// ── H/R/RBI Breakdown ─────────────────────────────────
function breakdownHRR(hrr, order) {
  const w =
    order <= 1
      ? CONFIG.BREAKDOWN[1]
      : order <= 2
        ? CONFIG.BREAKDOWN[2]
        : order <= 3
          ? CONFIG.BREAKDOWN[3]
          : order <= 5
            ? CONFIG.BREAKDOWN[5]
            : CONFIG.BREAKDOWN[9];
  return {
    hProj: Math.round(hrr * w.h * 100) / 100,
    rProj: Math.round(hrr * w.r * 100) / 100,
    rbiProj: Math.round(hrr * w.rbi * 100) / 100,
  };
}

// ── Today's games ──────────────────────────────────────
async function getTodayGames() {
  console.log(`Fetching schedule for ${TODAY_ET}...`);
  const data = await mlbFetch(
    `/schedule?sportId=1&date=${TODAY_ET}&hydrate=team,venue,probablePitcher`,
  );
  const games = [];
  let finalCount = 0;
  for (const date of data.dates || []) {
    for (const game of date.games || []) {
      game._isFinal = game.status?.abstractGameState === "Final";
      if (game._isFinal) finalCount++;
      games.push(game);
    }
  }
  console.log(`Found ${games.length} games (${finalCount} final)`);
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
  } catch (e) {
    console.log(
      `  getBoxscoreLineup error (gamePk=${gamePk}, team=${teamId}): ${e.message}`,
    );
    return [];
  }
}

// ── Build game data ────────────────────────────────────
async function buildGameData(mlbGames, oddsLines) {
  const games = [];

  // Pre-fetch weather + pitchers in parallel
  const weatherPromises = mlbGames.map((g) => {
    const venue = g.venue?.name || "Unknown";
    const gameDate = new Date(g.gameDate);
    const hoursOut = Math.max(
      0,
      (gameDate.getTime() - Date.now()) / 3600000,
    );
    const gameTime = gameDate.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/New_York",
    });
    return g._isFinal
      ? Promise.resolve({ note: "", risk: false, adjustment: 0 })
      : fetchWeather(venue, gameTime, hoursOut);
  });
  const pitcherIds = new Set();
  mlbGames.forEach((g) => {
    if (g.teams.away.probablePitcher?.id)
      pitcherIds.add(g.teams.away.probablePitcher.id);
    if (g.teams.home.probablePitcher?.id)
      pitcherIds.add(g.teams.home.probablePitcher.id);
  });
  const pitcherPromises = [...pitcherIds].map((id) =>
    getPitcherStats(id).then((stats) => [id, stats]),
  );

  const [weatherResults, pitcherResults] = await Promise.all([
    Promise.all(weatherPromises),
    Promise.all(pitcherPromises),
  ]);
  const pitcherStatsMap = Object.fromEntries(pitcherResults);

  for (const [i, g] of mlbGames.entries()) {
    try {
      const gamePk = g.gamePk;
      const awayTeam = g.teams.away.team;
      const homeTeam = g.teams.home.team;
      const awayPRaw = g.teams.away.probablePitcher;
      const homePRaw = g.teams.home.probablePitcher;
      const venue = g.venue?.name || "Unknown";
      const parkFactor = PARK_FACTORS[venue] || 1.0;
      const gameTime = new Date(g.gameDate).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        timeZone: "America/New_York",
      });
      const weather = weatherResults[i];
      const dayNight = g.dayNight || (parseInt(gameTime) < 5 ? "day" : "night");

      const awayPS = awayPRaw ? pitcherStatsMap[awayPRaw.id] : null;
      const homePS = homePRaw ? pitcherStatsMap[homePRaw.id] : null;
      const awayPitcher = {
        id: String(awayPRaw?.id || ""),
        name: awayPRaw?.fullName || "TBD",
        hand: awayPRaw?.pitchHand?.code || "R",
        era: awayPS?.era || CONFIG.DEFAULT_ERA,
        k9: awayPS?.k9 || CONFIG.DEFAULT_K9,
        xera: awayPS?.xera || CONFIG.DEFAULT_ERA,
        last3: awayPS?.last3 || [],
        last3ERA: awayPS?.last3ERA || null,
      };
      const homePitcher = {
        id: String(homePRaw?.id || ""),
        name: homePRaw?.fullName || "TBD",
        hand: homePRaw?.pitchHand?.code || "R",
        era: homePS?.era || CONFIG.DEFAULT_ERA,
        k9: homePS?.k9 || CONFIG.DEFAULT_K9,
        xera: homePS?.xera || CONFIG.DEFAULT_ERA,
        last3: homePS?.last3 || [],
        last3ERA: homePS?.last3ERA || null,
      };

      console.log(
        `  Building: ${awayTeam.abbreviation} @ ${homeTeam.abbreviation} — SP: ${awayPitcher.name} vs ${homePitcher.name}`,
      );
      let awayLineup = await getBoxscoreLineup(gamePk, awayTeam.id);
      let homeLineup = await getBoxscoreLineup(gamePk, homeTeam.id);

      const awayLineupConfirmed = awayLineup.length > 0;
      const homeLineupConfirmed = homeLineup.length > 0;

      if (!awayLineup.length)
        awayLineup = [
          { id: "", name: "Lineup TBD", pos: "?", order: 1, bats: "R" },
        ];
      if (!homeLineup.length)
        homeLineup = [
          { id: "", name: "Lineup TBD", pos: "?", order: 1, bats: "R" },
        ];

      const enrichLineup = async (lineup, oppPitcherId) => {
        return Promise.all(
          lineup.map((batter) =>
            limit(async () => {
              if (!batter.id || batter.name === "Lineup TBD") {
                return {
                  ...batter,
                  ops: CONFIG.LEAGUE_AVG_OPS,
                  avg: CONFIG.DEFAULT_AVG,
                  wrcPlus: CONFIG.DEFAULT_WRC,
                  pa: 0,
                  vsLeftOPS: null,
                  vsRightOPS: null,
                  hitStreak: 0,
                  last10Avg: CONFIG.DEFAULT_AVG,
                  last10AB: 0,
                  streakType: "neutral",
                  hotStreak: false,
                  barrelPct: null,
                  hardHitPct: null,
                  exitVelo: null,
                  injured: false,
                  bvp: null,
                };
              }
              const [stats, bvp] = await Promise.all([
                getFullPlayerStats(batter.id),
                oppPitcherId
                  ? getBvPStats(batter.id, oppPitcherId).catch(() => null)
                  : Promise.resolve(null),
              ]);
              return {
                ...batter,
                ops: stats?.ops || CONFIG.LEAGUE_AVG_OPS,
                avg: stats?.avg || CONFIG.DEFAULT_AVG,
                obp: stats?.obp || CONFIG.DEFAULT_OBP,
                slg: stats?.slg || CONFIG.DEFAULT_SLG,
                pa: stats?.pa || 0,
                wrcPlus: stats?.wrcPlus || CONFIG.DEFAULT_WRC,
                xwoba: stats?.xwoba || null,
                barrelPct: stats?.barrelPct || null,
                hardHitPct: stats?.hardHitPct || null,
                exitVelo: stats?.exitVelo || null,
                vsLeftOPS: stats?.vsLeftOPS || null,
                vsRightOPS: stats?.vsRightOPS || null,
                hitStreak: stats?.hitStreak || 0,
                last10Avg: stats?.last10Avg || stats?.avg || CONFIG.DEFAULT_AVG,
                last10AB: stats?.last10AB || 0,
                streakType: stats?.streakType || "neutral",
                hotStreak: stats?.hotStreak || false,
                injured: injuredPlayers.has(batter.id),
                bvp: bvp,
              };
            }),
          ),
        );
      };

      [awayLineup, homeLineup] = await Promise.all([
        enrichLineup(awayLineup, homePRaw?.id),
        enrichLineup(homeLineup, awayPRaw?.id),
      ]);

      const oddsLine = findOddsLine(
        {
          away: { abbr: awayTeam.abbreviation },
          home: { abbr: homeTeam.abbreviation },
        },
        oddsLines,
      );

      games.push({
        id: i + 1,
        gamePk,
        time: gameTime,
        isFinal: !!g._isFinal,
        dayNight,
        stadium: `${venue} · ${g.venue?.city || homeTeam.locationName || ""}`,
        parkFactor,
        weatherNote: weather.note,
        weatherRisk: weather.risk,
        weatherAdj: weather.adjustment,
        oddsLine,
        awayLineupConfirmed,
        homeLineupConfirmed,
        away: {
          abbr: awayTeam.abbreviation,
          name: awayTeam.name,
          pitcher: awayPitcher,
          lineup: awayLineup,
        },
        home: {
          abbr: homeTeam.abbreviation,
          name: homeTeam.name,
          pitcher: homePitcher,
          lineup: homeLineup,
        },
      });
    } catch (err) {
      console.log(`  Skipped ${g.gamePk}: ${err.message}`);
    }
  }
  return games;
}

// ── Projections (with split confidence) ───────────────
function enrichWithProjections(data) {
  const allPlayers = [];
  data.games.forEach((game) => {
    const awayImplied =
      game.oddsLine?.awayImplied ||
      (game.oddsLine ? game.oddsLine.total / 2 : null);
    const homeImplied =
      game.oddsLine?.homeImplied ||
      (game.oddsLine ? game.oddsLine.total / 2 : null);

    let envScore = 5;
    const pf = game.parkFactor || 1.0;
    envScore += (pf - 1.0) * 15;
    envScore += (game.weatherAdj || 0) * 3;
    if (game.oddsLine?.total) {
      envScore += (game.oddsLine.total - 8.5) * 0.8;
    }
    game.envScore = Math.round(Math.max(1, Math.min(10, envScore)) * 10) / 10;

    game.awayLineupAvailable = game.awayLineupConfirmed;
    game.homeLineupAvailable = game.homeLineupConfirmed;

    ["away", "home"].forEach((side) => {
      const team = game[side];
      const opp = game[side === "away" ? "home" : "away"];
      const implied = side === "away" ? awayImplied : homeImplied;
      const hasVegas = game.oddsLine != null;
      const lineupConfirmed =
        side === "away" ? game.awayLineupConfirmed : game.homeLineupConfirmed;

      team.lineup.forEach((batter) => {
        const isTBD = !batter.id || batter.name === "Lineup TBD";
        const isHome = side === "home";
        const isDayGame = (game.dayNight || "").toLowerCase() === "day";

        const hrr = computeHRR(
          batter,
          opp.pitcher,
          game.parkFactor,
          game.weatherAdj,
          implied,
          isHome,
          isDayGame,
        );
        const bd = breakdownHRR(hrr, batter.order);

        // Split confidence
        const dataConfidence =
          isTBD || game.isFinal
            ? 0
            : computeDataConfidence(batter, opp.pitcher, hasVegas);
        const playProbability =
          isTBD || game.isFinal
            ? 0
            : computePlayProbability(batter, lineupConfirmed);
        const pickScore = computePickScore(
          hrr,
          dataConfidence,
          playProbability,
        );

        batter.hrr = hrr;
        batter.hProj = bd.hProj;
        batter.rProj = bd.rProj;
        batter.rbiProj = bd.rbiProj;
        batter.tier =
          hrr >= CONFIG.TIER_A ? "A" : hrr >= CONFIG.TIER_B ? "B" : "C";

        // Both new fields + legacy 'confidence' for dashboard backward compat
        batter.dataConfidence = dataConfidence;
        batter.playProbability = playProbability;
        batter.confidence = dataConfidence; // legacy alias

        batter.pickScore = pickScore;
        batter.team = team.abbr;
        batter.gameId = game.id;
        batter.gamePk = game.gamePk;
        batter.gameTime = game.time;
        batter.impliedRuns = implied;
        batter.isHome = side === "home";
        batter.isTBD = isTBD;

        if (!isTBD) allPlayers.push(batter);
      });
    });
  });

  allPlayers.sort((a, b) => b.pickScore - a.pickScore);
  data.topPlays = allPlayers.slice(0, 15);
  data.allPlayers = allPlayers;

  // Stacks (with deduplication for game stacks)
  const teamGroups = {};
  allPlayers.forEach((p) => {
    const key = `${p.team}-${p.gameId}`;
    if (!teamGroups[key]) teamGroups[key] = [];
    teamGroups[key].push(p);
  });
  const stacks2 = [],
    stacks3 = [];
  Object.entries(teamGroups).forEach(([key, players]) => {
    const sorted = [...players].sort((a, b) => b.hrr - a.hrr);
    const [abbr] = key.split("-");
    const game = data.games.find(
      (g) => g.away.abbr === abbr || g.home.abbr === abbr,
    );
    const opp = game
      ? game.away.abbr === abbr
        ? game.home.abbr
        : game.away.abbr
      : "?";
    const impl = game?.oddsLine
      ? (game.away.abbr === abbr
          ? game.oddsLine.awayImplied
          : game.oddsLine.homeImplied) || game.oddsLine.total / 2
      : null;

    const adjBonus = (stack) => {
      const orders = stack.map((p) => p.order).sort((a, b) => a - b);
      let bonus = 0;
      for (let i = 1; i < orders.length; i++) {
        if (orders[i] - orders[i - 1] === 1)
          bonus += CONFIG.STACK_ADJ_CONSECUTIVE;
        else if (orders[i] - orders[i - 1] === 2)
          bonus += CONFIG.STACK_ADJ_ONE_APART;
      }
      return bonus;
    };

    if (sorted.length >= 2) {
      const t = sorted.slice(0, 2);
      const adj = adjBonus(t);
      stacks2.push({
        team: abbr,
        opp,
        time: t[0].gameTime,
        players: t,
        total: Math.round((t.reduce((s, p) => s + p.hrr, 0) + adj) * 100) / 100,
        impliedRuns: impl,
        adjacencyBonus: adj,
      });
    }
    if (sorted.length >= 3) {
      const t = sorted.slice(0, 3);
      const adj = adjBonus(t);
      stacks3.push({
        team: abbr,
        opp,
        time: t[0].gameTime,
        players: t,
        total: Math.round((t.reduce((s, p) => s + p.hrr, 0) + adj) * 100) / 100,
        impliedRuns: impl,
        adjacencyBonus: adj,
      });
    }
  });
  data.stacks2 = stacks2.sort((a, b) => b.total - a.total).slice(0, 10);
  data.stacks3 = stacks3.sort((a, b) => b.total - a.total).slice(0, 10);

  // Game stacks (deduplicated — top 3 per team, no overlap with stacks2/3)
  const gameStacks = [];
  data.games.forEach((game) => {
    if (!game.oddsLine || game.oddsLine.total < 9) return;
    const awayPlayers = allPlayers
      .filter((p) => p.team === game.away.abbr && p.gameId === game.id)
      .slice(0, 3);
    const homePlayers = allPlayers
      .filter((p) => p.team === game.home.abbr && p.gameId === game.id)
      .slice(0, 3);
    if (awayPlayers.length < 2 || homePlayers.length < 2) return;
    const all = [...awayPlayers, ...homePlayers];
    // Dedupe (defensive — shouldn't happen but guards against future bugs)
    const seen = new Set();
    const unique = all.filter((p) => {
      const k = `${p.name}_${p.team}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    gameStacks.push({
      away: game.away.abbr,
      home: game.home.abbr,
      total: game.oddsLine.total,
      envScore: game.envScore,
      time: game.time || "",
      players: unique.map((p) => ({
        name: p.name,
        team: p.team,
        hrr: p.hrr,
        order: p.order,
        confidence: p.dataConfidence,
      })),
      stackTotal: Math.round(unique.reduce((s, p) => s + p.hrr, 0) * 100) / 100,
    });
  });
  data.gameStacks = gameStacks
    .sort((a, b) => b.stackTotal - a.stackTotal)
    .slice(0, 5);

  // Slim allPlayers for Gist size
  data.allPlayers = allPlayers.map((p) => {
    const slim = { ...p };
    delete slim.vsLeftOPS;
    delete slim.vsRightOPS;
    delete slim.exitVelo;
    delete slim.obp;
    delete slim.slg;
    return slim;
  });

  return data;
}

// ── Vegas odds ─────────────────────────────────────────
function oddsToProb(americanOdds) {
  if (americanOdds > 0) return 100 / (americanOdds + 100);
  return Math.abs(americanOdds) / (Math.abs(americanOdds) + 100);
}

async function fetchOddsLines() {
  const key = process.env.ODDS_API_KEY;
  if (!key) {
    console.log("No ODDS_API_KEY — skipping Vegas lines");
    return {};
  }
  try {
    const url = `https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${key}&regions=us&markets=totals,h2h&oddsFormat=american&dateFormat=iso`;
    const res = await safeFetch(url);
    if (!res) return {};
    const data = await res.json();
    const lines = {};
    for (const game of data) {
      const bk =
        game.bookmakers?.find(
          (b) => b.key === "draftkings" || b.key === "fanduel",
        ) || game.bookmakers?.[0];
      if (!bk) continue;
      const over = bk.markets
        ?.find((m) => m.key === "totals")
        ?.outcomes?.find((o) => o.name === "Over");
      const h2h = bk.markets?.find((m) => m.key === "h2h")?.outcomes || [];
      const total = over?.point || null;

      let awayImplied = total ? total / 2 : null;
      let homeImplied = total ? total / 2 : null;
      if (total && h2h.length >= 2) {
        const awayLine = h2h.find((o) => o.name === game.away_team);
        const homeLine = h2h.find((o) => o.name === game.home_team);
        if (awayLine?.price != null && homeLine?.price != null) {
          const awayProb = oddsToProb(awayLine.price);
          const homeProb = oddsToProb(homeLine.price);
          const totalProb = awayProb + homeProb;
          if (totalProb > 0) {
            awayImplied =
              Math.round(total * (awayProb / totalProb) * 100) / 100;
            homeImplied =
              Math.round(total * (homeProb / totalProb) * 100) / 100;
          }
        }
      }

      if (total) {
        lines[`${game.away_team}_${game.home_team}`] = {
          total,
          bookmaker: bk.title,
          awayImplied,
          homeImplied,
          awayTeam: game.away_team,
          homeTeam: game.home_team,
        };
      }
    }
    console.log(`Fetched odds for ${Object.keys(lines).length} games`);
    return lines;
  } catch (e) {
    console.log("Odds error:", e.message);
    return {};
  }
}

function findOddsLine(game, oddsLines) {
  const away = TEAM_MAP[game.away?.abbr] || "";
  const home = TEAM_MAP[game.home?.abbr] || "";
  if (!away || !home) return null;
  for (const [key, line] of Object.entries(oddsLines)) {
    if (key.includes(away) && key.includes(home)) return line;
  }
  for (const [key, line] of Object.entries(oddsLines)) {
    if (key.includes(away) || key.includes(home)) return line;
  }
  return null;
}

// ── Gist read/write ────────────────────────────────────
async function readGistFile(octokit, gistId, filename) {
  try {
    const res = await octokit.gists.get({ gist_id: gistId });
    const raw = res.data.files?.[filename]?.content;
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    console.log(`  readGistFile error (${filename}): ${e.message}`);
    return null;
  }
}

async function writeGistFile(octokit, gistId, filename, data) {
  await octokit.gists.update({
    gist_id: gistId,
    files: { [filename]: { content: JSON.stringify(data) } },
  });
}

async function readExistingLiveData(octokit, gistId) {
  const data = await readGistFile(octokit, gistId, "hrr-data.json");
  return data?.date === TODAY_ET ? data : null;
}

// ── Snapshot writer (for accuracy job to read tomorrow) ──
async function writeDailySnapshot(octokit, historyGistId, enriched) {
  const snapshot = {
    date: TODAY_ET,
    snapshotAt: new Date().toISOString(),
    dailyTop10: enriched.dailyTop10 || [],
    consideredToday: enriched.consideredToday || [],
    // Slim allPlayers — only what compute-accuracy needs
    allPlayers: (enriched.allPlayers || []).map((p) => ({
      name: p.name,
      team: p.team,
      pos: p.pos,
      order: p.order,
      hrr: p.hrr,
      tier: p.tier,
      dataConfidence: p.dataConfidence,
      playProbability: p.playProbability,
      confidence: p.dataConfidence, // legacy alias
      pickScore: p.pickScore,
      gamePk: p.gamePk,
    })),
  };
  await writeGistFile(
    octokit,
    historyGistId,
    `snapshot-${TODAY_ET}.json`,
    snapshot,
  );
  console.log(
    `  Wrote snapshot-${TODAY_ET}.json (${snapshot.allPlayers.length} players, ${snapshot.dailyTop10.length} top picks)`,
  );
}

// ── Main ───────────────────────────────────────────────
async function main() {
  const missing = ["GIST_ID", "GIST_TOKEN"].filter((v) => !process.env[v]);
  if (missing.length) {
    console.error(`Missing env vars: ${missing.join(", ")}`);
    process.exit(1);
  }

  const octokit = new Octokit({ auth: process.env.GIST_TOKEN });

  const liveGistId =
    process.env.CI !== "true" && process.env.GIST_ID_DEV
      ? process.env.GIST_ID_DEV
      : process.env.GIST_ID;

  console.log(
    `>>> Writing to ${liveGistId === process.env.GIST_ID_DEV ? "DEV" : "LIVE"} gist: ${liveGistId}`,
  );

  const historyGistId = process.env.GIST_ID_HISTORY || liveGistId;
  console.log(`\n=== MLB HRR Generator v7 — ${TODAY_DISPLAY} ===\n`);

  await Promise.all([fetchSavantData(), fetchInjuries()]);

  const mlbGames = await getTodayGames();
  if (!mlbGames.length) {
    console.log("No games today.");
    process.exit(0);
  }

  const oddsLines = await fetchOddsLines();

  console.log(`\nBuilding data for ${mlbGames.length} games...`);
  const games = await buildGameData(mlbGames, oddsLines);

  games.forEach((g) => {
    if (g.oddsLine) {
      const ai = g.oddsLine.awayImplied?.toFixed(1) || "?";
      const hi = g.oddsLine.homeImplied?.toFixed(1) || "?";
      console.log(
        `  Vegas: ${g.away.abbr}@${g.home.abbr} O/U ${g.oddsLine.total} → ${g.away.abbr} ${ai} / ${g.home.abbr} ${hi} (${g.oddsLine.bookmaker})`,
      );
    }
  });

  const data = { date: TODAY_ET, generatedAt: new Date().toISOString(), games };
  const enriched = enrichWithProjections(data);

  // ── Cumulative allPlayers — preserve earlier-run projections ──
  const existing = await readExistingLiveData(octokit, liveGistId);
  if (existing?.allPlayers?.length) {
    const freshKeys = new Set(
      enriched.allPlayers.map((p) => p.name + "_" + p.team),
    );
    const preserved = existing.allPlayers.filter((ep) => {
      return (
        ep.name &&
        ep.name !== "Lineup TBD" &&
        !ep.isTBD &&
        !freshKeys.has(ep.name + "_" + ep.team)
      );
    });
    if (preserved.length > 0) {
      enriched.allPlayers = [...enriched.allPlayers, ...preserved];
      enriched.allPlayers.sort(
        (a, b) => (b.pickScore || b.hrr || 0) - (a.pickScore || a.hrr || 0),
      );
      console.log(
        `  Preserved ${preserved.length} projections from earlier runs`,
      );
    }
  }

  // ── Top 10 with split confidence floor + Lever 2 quality gate ──

  // Helper: resolve opposing pitcher for a player (used by passesQualityGate)
  const oppPitcherOf = (p) => {
    const gm = enriched.games.find((g) => g.id === p.gameId);
    if (!gm) return null;
    return p.team === gm.home.abbr ? gm.away.pitcher : gm.home.pitcher;
  };

  // Track filter rejections for visibility
  const rejectionCounts = {};
  const qualified = enriched.allPlayers.filter((p) => {
    if ((p.dataConfidence || 0) < CONF_CONFIG.CONF_DATA_FLOOR) {
      rejectionCounts.dataFloor = (rejectionCounts.dataFloor || 0) + 1;
      return false;
    }
    if ((p.playProbability || 0) < CONF_CONFIG.CONF_PLAY_FLOOR) {
      rejectionCounts.playFloor = (rejectionCounts.playFloor || 0) + 1;
      return false;
    }
    const gate = passesQualityGate(p, oppPitcherOf);
    if (!gate.pass) {
      rejectionCounts[gate.reason] = (rejectionCounts[gate.reason] || 0) + 1;
      return false;
    }
    return true;
  });

  const freshTop10 = qualified.slice(0, 10);
  const freshMap = Object.fromEntries(
    freshTop10.map((p) => [p.name + "_" + p.team, p]),
  );

  console.log(`  Active filters: ${activeFilters()}`);
  console.log(
    `  Qualified picks: ${qualified.length}/${enriched.allPlayers.length}`,
  );
  if (Object.keys(rejectionCounts).length) {
    console.log(
      `  Rejected: ${Object.entries(rejectionCounts)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")}`,
    );
  }

  const existingReal = (existing?.dailyTop10 || []).filter(
    (p) => p.name && p.name !== "Lineup TBD" && !p.isTBD,
  );

  if (existingReal.length > 0) {
    const merged = existingReal.map((ep) => {
      const started =
        ep.gamePk &&
        mlbGames.some(
          (g) => g.gamePk === ep.gamePk && new Date(g.gameDate).getTime() < Date.now(),
        );
      return started ? ep : freshMap[ep.name + "_" + ep.team] || ep;
    });
    const mergedKeys = new Set(merged.map((p) => p.name + "_" + p.team));
    const fillers = qualified.filter(
      (p) => !mergedKeys.has(p.name + "_" + p.team),
    );
    while (merged.length < 10 && fillers.length > 0) {
      merged.push(fillers.shift());
    }
    // Drop any merged entry that no longer qualifies (unless locked)
    enriched.dailyTop10 = merged.filter((ep) => {
      const started =
        ep.gamePk &&
        mlbGames.some(
          (g) => g.gamePk === ep.gamePk && new Date(g.gameDate).getTime() < Date.now(),
        );
      return (
        started ||
        ((ep.dataConfidence || ep.confidence || 0) >=
          CONF_CONFIG.CONF_DATA_FLOOR &&
          (ep.playProbability || 0) >= CONF_CONFIG.CONF_PLAY_FLOOR)
      );
    });
    const locked = enriched.dailyTop10.filter((ep) => {
      return (
        ep.gamePk &&
        mlbGames.some(
          (g) => g.gamePk === ep.gamePk && new Date(g.gameDate).getTime() < Date.now(),
        )
      );
    }).length;
    console.log(
      `Top plays: ${enriched.dailyTop10.length} picks (${locked} locked, ${enriched.dailyTop10.length - locked} flexible)`,
    );
  } else {
    enriched.dailyTop10 = freshTop10;
    console.log(`Initial top plays: ${freshTop10.length} picks`);
  }

  // Track previously considered
  const currentKeys = new Set(
    enriched.dailyTop10.map((p) => p.name + "_" + p.team),
  );
  const prevTop10 = existingReal;
  const prevConsidered = (existing?.consideredToday || []).filter(
    (p) => p.name !== "Lineup TBD" && !p.isTBD,
  );
  const alreadyConsidered = new Set(
    prevConsidered.map((p) => p.name + "_" + p.team),
  );
  const newlyDropped = prevTop10.filter(
    (p) =>
      !currentKeys.has(p.name + "_" + p.team) &&
      !alreadyConsidered.has(p.name + "_" + p.team),
  );
  enriched.consideredToday = [
    ...prevConsidered,
    ...newlyDropped.map((p) => ({ ...p, droppedAt: new Date().toISOString() })),
  ];
  if (newlyDropped.length)
    console.log(
      `Previously considered: +${newlyDropped.length} (${newlyDropped.map((p) => p.name).join(", ")})`,
    );

  enriched.date = TODAY_ET;

  // ── Preserve existing accuracyHistory for legacy dashboard reads ──
  // (compute-accuracy.js writes to a separate file; we keep this for backward compat)
  if (existing?.accuracyHistory)
    enriched.accuracyHistory = existing.accuracyHistory;

  // ── Write live Gist ──
  console.log("Uploading to live Gist...");
  await writeGistFile(octokit, liveGistId, "hrr-data.json", enriched);
  console.log(`Live gist updated: https://gist.github.com/${liveGistId}`);

  // ── Write daily snapshot to history Gist ──
  try {
    await writeDailySnapshot(octokit, historyGistId, enriched);
  } catch (e) {
    console.log(`  Snapshot write failed (non-fatal): ${e.message}`);
  }

  const top = enriched.dailyTop10[0];
  console.log(
    `\n✓ Done! ${enriched.games.length} games · ${enriched.allPlayers.length} players`,
  );
  if (top)
    console.log(
      `Top play: ${top.name} (${top.team}) HRR ${top.hrr} · data ${top.dataConfidence ?? top.confidence} · play ${top.playProbability ?? "?"}`,
    );
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  console.error(err.stack);
  process.exit(1);
});
