/**
 * Shared utilities used by both generate-hrr.js and compute-accuracy.js
 * ─────────────────────────────────────────────────────────────────────
 * Keeping this isolated means changes to fetch/retry logic propagate
 * to both jobs without copy-paste drift.
 */

export const MLB = "https://statsapi.mlb.com/api/v1";

export const TODAY_ET = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
export const CURRENT_YEAR = TODAY_ET.split("-")[0];

// ── Date helpers ─────────────────────────────────────
export function yesterdayET() {
  const d = new Date();
  // Convert to ET first, then subtract a day
  const etDate = new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" }));
  etDate.setDate(etDate.getDate() - 1);
  return etDate.toISOString().split("T")[0];
}

// ── Safe numeric parse ───────────────────────────────
export function safeFloat(val, fallback = 0) {
  const n = parseFloat(val);
  return isFinite(n) ? n : fallback;
}

// ── Retry wrapper ─────────────────────────────────────
export async function withRetry(fn, label = "", retries = 2, delayMs = 1500) {
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

// ── MLB API fetch with retry ──────────────────────────
export async function mlbFetch(path) {
  return withRetry(async () => {
    const res = await fetch(`${MLB}${path}`);
    if (!res.ok) throw new Error(`MLB API ${res.status}: ${path}`);
    return res.json();
  }, path, 2, 1500);
}

// ── Safe fetch with timeout (no retry — for optional data) ─────
export async function safeFetch(url, opts = {}) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: controller.signal, ...opts });
    clearTimeout(timeout);
    if (!res.ok) return null;
    return res;
  } catch (e) {
    console.log(`  safeFetch error: ${e.message} (${url.slice(0, 120)})`);
    return null;
  }
}

// ── Concurrency limiter ───────────────────────────────
export function createLimiter(concurrency = 8) {
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

// ── Fetch all final boxscores for a date ─────────────
// Returns: { "PlayerName_TEAM": { hits, runs, rbi, atBats, actual, played } }
export async function fetchBoxscoresForDate(dateStr) {
  console.log(`Fetching boxscores for ${dateStr}...`);
  const sched = await mlbFetch(`/schedule?sportId=1&date=${dateStr}&hydrate=team,linescore`);
  const games = sched.dates?.[0]?.games || [];
  const finalGames = games.filter(g => g.status?.abstractGameState === "Final");

  console.log(`  ${games.length} games scheduled, ${finalGames.length} final`);

  const results = {};
  let processed = 0;
  for (const g of finalGames) {
    try {
      const bs = await mlbFetch(`/game/${g.gamePk}/boxscore`);
      for (const side of ["away", "home"]) {
        const td = bs.teams?.[side];
        if (!td) continue;
        const abbr = td.team?.abbreviation;
        for (const p of Object.values(td.players || {})) {
          const s = p.stats?.batting;
          if (!s) continue;
          const atBats = parseInt(s.atBats || 0);
          const hits = parseInt(s.hits || 0);
          const runs = parseInt(s.runs || 0);
          const rbi = parseInt(s.rbi || 0);
          const plateAppearances = parseInt(s.plateAppearances || 0);
          const fullName = p.person?.fullName || "";
          const key = `${fullName}_${abbr}`;
          // PA captures "had any role in lineup" — including walks/HBP that aren't ABs
          const played = plateAppearances >= 1 || atBats >= 1;
          results[key] = {
            hits, runs, rbi, atBats, plateAppearances,
            actual: hits + runs + rbi,
            played,
            playerId: String(p.person?.id || ""),
          };
        }
      }
      processed++;
    } catch (e) {
      console.log(`  Boxscore err (gamePk=${g.gamePk}): ${e.message}`);
    }
  }

  console.log(`  Processed ${processed}/${finalGames.length} boxscores → ${Object.keys(results).length} player entries`);
  return { results, gamesScheduled: games.length, gamesFinal: finalGames.length, gamesProcessed: processed };
}

// ── Name normalization for fuzzy matching ─────────────
export function normName(n) {
  return (n || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}
