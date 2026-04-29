/**
 * Split confidence scoring + Lever 2 quality filters (v8)
 * ────────────────────────────────────────────────────────
 * v7 introduced split confidence:
 *   - data_confidence (1.0 - 10.0)  — projection reliability
 *   - play_probability (0.0 - 1.0)  — likelihood of getting PAs
 *
 * v8 adds Lever 2 — opt-in quality filters that tighten the top 10
 * to chase a higher HRR ≥ 2 hit rate. Activate one at a time so we
 * can see what each filter is worth.
 *
 * Filter knobs (set CONF_USE_* false to disable any filter):
 *   CONF_HRR_FLOOR        — minimum HRR projection
 *   CONF_OPP_ERA_FLOOR    — only attack pitchers with season ERA ≥ X
 *   CONF_OPP_L3_FLOOR     —  ...OR last-3-starts ERA ≥ X
 *   CONF_PLAY_FLOOR       — bumped from 0.70 → 0.85 (existing knob)
 *   CONF_EXCLUDE_COLD     — exclude streakType === "cold"
 *
 * Recommended rollout (one filter every 3-5 days):
 *   Day 1: CONF_USE_HRR_FLOOR     = true   (everything else off / permissive)
 *   Day ~5: CONF_USE_OPP_ERA      = true
 *   Day ~10: CONF_PLAY_FLOOR      = 0.85
 *   Day ~15: CONF_USE_EXCLUDE_COLD = true
 *
 * Pick scoring:
 *   pickScore = HRR × (HRR_WEIGHT + dataConf × CONF_WEIGHT) × playProbability
 */

export const CONF_CONFIG = {
  // ── data_confidence weights (unchanged from v7) ──
  CONF_PA_SCALE:          100,
  CONF_PA_MAX:            2.0,
  CONF_SAVANT_XWOBA:      0.5,
  CONF_SAVANT_BARREL:     0.35,
  CONF_SAVANT_HARDHIT:    0.3,
  CONF_SAVANT_EV:         0.2,
  CONF_SPLITS_EXIST:      0.15,
  CONF_L10_SCALE:         20,
  CONF_L10_MAX:           0.5,
  CONF_STREAK_HOT:        0.45,
  CONF_STREAK_WARM:       0.25,
  CONF_HITSTREAK_MIN:     3,
  CONF_HITSTREAK_BONUS:   0.2,
  CONF_BVP_SCALE:         12,
  CONF_BVP_MAX:           1.0,
  CONF_PITCHER_XERA:      0.6,
  CONF_PITCHER_KNOWN:     0.4,
  CONF_ORDER_TOP:         0.7,
  CONF_ORDER_MID:         0.5,
  CONF_ORDER_LOW:         0.3,
  CONF_ORDER_BOT:         0.1,
  CONF_VEGAS:             0.5,
  CONF_NOT_INJURED:       0.5,
  CONF_LINEUP_CONFIRMED:  0.3,
  CONF_CONVERGE_PA_SAVANT:    0.5,
  CONF_CONVERGE_PA_L10:       0.4,
  CONF_CONVERGE_BVP_SAVANT:   0.35,
  CONF_CONVERGE_FULL_SAVANT:  0.25,
  CONF_PENALTY_TINY:          -1.0,
  CONF_PENALTY_SMALL:         -0.3,

  // ── Top 10 selection thresholds (existing) ──
  CONF_DATA_FLOOR:        9.0,    // minimum data_confidence
  CONF_PLAY_FLOOR:        0.70,   // bump to 0.85 in stage 3 of rollout

  // ── pickScore formula weights ──
  CONF_PICK_HRR_WEIGHT:   0.70,
  CONF_PICK_CONF_WEIGHT:  0.03,

  // ── play_probability factors ──
  PLAY_LINEUP_CONFIRMED:  0.40,
  PLAY_ORDER_REGULAR:     0.20,
  PLAY_ORDER_BOTTOM:      0.10,
  PLAY_PA_RECENT:         0.20,
  PLAY_HEALTHY:           0.15,
  PLAY_NOT_BACKUP:        0.05,

  // ══════════════════════════════════════════════════════════════
  // ── LEVER 2 FILTERS (v8) — opt-in quality gates ──────────────
  // ══════════════════════════════════════════════════════════════

  // Filter 1 — Projection floor (BIGGEST IMPACT, deploy first)
  // Eliminates low-ceiling picks that only made top 10 due to high confidence.
  CONF_USE_HRR_FLOOR:     true,
  CONF_HRR_FLOOR:         2.5,

  // Filter 2 — Opposing pitcher vulnerability
  // Pick a hitter only if SP has season ERA ≥ X OR last-3-starts ERA ≥ Y.
  // Cuts picks against aces who are throwing well.
  CONF_USE_OPP_ERA:       false,   // flip to true at stage 2
  CONF_OPP_ERA_FLOOR:     4.00,
  CONF_OPP_L3_FLOOR:      4.50,

  // Filter 3 — Cold-streak exclusion
  // Bench players in confirmed cold streaks. Smallest impact, deploy last.
  CONF_USE_EXCLUDE_COLD:  false,   // flip to true at stage 4
};

/**
 * Compute data_confidence (1.0 - 10.0)
 * Identical to v7 — measures data completeness for the projection
 */
export function computeDataConfidence(batter, oppPitcher, hasVegas) {
  const C = CONF_CONFIG;
  let conf = 0;

  const pa = batter.pa || 0;
  conf += Math.min(pa / C.CONF_PA_SCALE, 1.0) * C.CONF_PA_MAX;

  if (batter.xwoba != null)      conf += C.CONF_SAVANT_XWOBA;
  if (batter.barrelPct != null)  conf += C.CONF_SAVANT_BARREL;
  if (batter.hardHitPct != null) conf += C.CONF_SAVANT_HARDHIT;
  if (batter.exitVelo != null)   conf += C.CONF_SAVANT_EV;
  if (batter.vsLeftOPS != null || batter.vsRightOPS != null) conf += C.CONF_SPLITS_EXIST;

  conf += Math.min((batter.last10AB || 0) / C.CONF_L10_SCALE, 1.0) * C.CONF_L10_MAX;
  if (batter.streakType === "hot")       conf += C.CONF_STREAK_HOT;
  else if (batter.streakType === "warm") conf += C.CONF_STREAK_WARM;
  if ((batter.hitStreak || 0) >= C.CONF_HITSTREAK_MIN) conf += C.CONF_HITSTREAK_BONUS;

  if (batter.bvp && batter.bvp.ab > 0) {
    conf += Math.min(batter.bvp.ab / C.CONF_BVP_SCALE, 1.0) * C.CONF_BVP_MAX;
  }
  if (oppPitcher && oppPitcher.xera && oppPitcher.name !== "TBD") conf += C.CONF_PITCHER_XERA;
  if (oppPitcher && oppPitcher.name !== "TBD") conf += C.CONF_PITCHER_KNOWN;

  const order = batter.order || 9;
  if (order <= 2)      conf += C.CONF_ORDER_TOP;
  else if (order <= 5) conf += C.CONF_ORDER_MID;
  else if (order <= 7) conf += C.CONF_ORDER_LOW;
  else                 conf += C.CONF_ORDER_BOT;
  if (hasVegas)        conf += C.CONF_VEGAS;
  if (!batter.injured) conf += C.CONF_NOT_INJURED;
  conf += C.CONF_LINEUP_CONFIRMED;

  if (pa >= 80 && batter.xwoba != null) conf += C.CONF_CONVERGE_PA_SAVANT;
  if (pa >= 50 && (batter.last10AB || 0) >= 15) conf += C.CONF_CONVERGE_PA_L10;
  if (batter.bvp && batter.bvp.ab >= 8 && batter.xwoba != null) conf += C.CONF_CONVERGE_BVP_SAVANT;
  if (pa >= 150 && batter.barrelPct != null && batter.hardHitPct != null) conf += C.CONF_CONVERGE_FULL_SAVANT;

  if (pa < 20)      conf += C.CONF_PENALTY_TINY;
  else if (pa < 40) conf += C.CONF_PENALTY_SMALL;

  return Math.round(Math.min(10, Math.max(1, conf)) * 10) / 10;
}

/**
 * Compute play_probability (0.0 - 1.0) — unchanged from v7
 */
export function computePlayProbability(batter, lineupConfirmed) {
  const C = CONF_CONFIG;
  let prob = 0;

  if (lineupConfirmed) prob += C.PLAY_LINEUP_CONFIRMED;

  const order = batter.order || 9;
  if (order >= 1 && order <= 7) prob += C.PLAY_ORDER_REGULAR;
  else if (order >= 8 && order <= 9) prob += C.PLAY_ORDER_BOTTOM;

  const l10 = batter.last10AB || 0;
  if (l10 >= 30) prob += C.PLAY_PA_RECENT;
  else if (l10 >= 15) prob += C.PLAY_PA_RECENT * 0.5;

  if (!batter.injured) prob += C.PLAY_HEALTHY;

  const isLikelyBackup = order === 9 && l10 < 15;
  if (!isLikelyBackup) prob += C.PLAY_NOT_BACKUP;

  return Math.round(Math.min(1.0, Math.max(0, prob)) * 100) / 100;
}

/**
 * Compute pickScore — unchanged from v7
 */
export function computePickScore(hrr, dataConfidence, playProbability) {
  const C = CONF_CONFIG;
  const confMult = C.CONF_PICK_HRR_WEIGHT + (dataConfidence || 0) * C.CONF_PICK_CONF_WEIGHT;
  const score = hrr * confMult * (playProbability || 0);
  return Math.round(score * 100) / 100;
}

/**
 * Lever 2 quality gate — applied AFTER the data/play floors.
 * Returns { pass: boolean, reason: string } so we can log why picks are filtered.
 *
 * Pass `getOppPitcher(player)` so the filter can read opposing SP info.
 *   const oppFn = (p) => {
 *     const gm = games.find(g => g.id === p.gameId);
 *     if (!gm) return null;
 *     return p.team === gm.home.abbr ? gm.away.pitcher : gm.home.pitcher;
 *   };
 */
export function passesQualityGate(player, getOppPitcher = () => null) {
  const C = CONF_CONFIG;

  // Filter 1: HRR floor
  if (C.CONF_USE_HRR_FLOOR && (player.hrr || 0) < C.CONF_HRR_FLOOR) {
    return { pass: false, reason: `hrr<${C.CONF_HRR_FLOOR}` };
  }

  // Filter 2: opposing pitcher vulnerability
  if (C.CONF_USE_OPP_ERA) {
    const sp = getOppPitcher(player);
    if (sp) {
      const seasonERA = sp.era != null ? sp.era : 99;
      const l3ERA     = sp.last3ERA != null ? sp.last3ERA : null;
      const seasonOK  = seasonERA >= C.CONF_OPP_ERA_FLOOR;
      const l3OK      = l3ERA != null && l3ERA >= C.CONF_OPP_L3_FLOOR;
      // Need EITHER condition true to qualify (vulnerable pitcher)
      if (!seasonOK && !l3OK) {
        return { pass: false, reason: `pitcher_strong(era=${seasonERA},l3=${l3ERA})` };
      }
    }
  }

  // Filter 3: cold-streak exclusion
  if (C.CONF_USE_EXCLUDE_COLD && player.streakType === "cold") {
    return { pass: false, reason: "cold_streak" };
  }

  return { pass: true, reason: null };
}

/**
 * Helper: list active filters for logging at run start
 */
export function activeFilters() {
  const C = CONF_CONFIG;
  const out = [];
  out.push(`data≥${C.CONF_DATA_FLOOR}`);
  out.push(`play≥${C.CONF_PLAY_FLOOR}`);
  if (C.CONF_USE_HRR_FLOOR)    out.push(`hrr≥${C.CONF_HRR_FLOOR}`);
  if (C.CONF_USE_OPP_ERA)      out.push(`oppERA≥${C.CONF_OPP_ERA_FLOOR}|L3≥${C.CONF_OPP_L3_FLOOR}`);
  if (C.CONF_USE_EXCLUDE_COLD) out.push("noCold");
  return out.join(", ");
}
