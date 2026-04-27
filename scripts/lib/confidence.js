/**
 * Split confidence scoring
 * ─────────────────────────
 * The original computeConfidence answered "how much data do I have?"
 * It did NOT answer "will this player actually get ABs today?"
 *
 * This split fixes the "9.4 confidence → 0 actual" problem.
 *
 * data_confidence (1.0 - 10.0) — same as before, projection reliability
 * play_probability (0.0 - 1.0) — likelihood of getting plate appearances
 *
 * pickScore = HRR × (data_weight + data_confidence × data_mult) × play_probability
 */

export const CONF_CONFIG = {
  // ── data_confidence weights (same as original computeConfidence) ──
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

  // ── Top 10 selection thresholds ──
  CONF_DATA_FLOOR:          9.0,    // minimum data_confidence
  CONF_PLAY_FLOOR:          0.70,   // minimum play_probability — stops bench risk

  // ── pickScore formula weights ──
  CONF_PICK_HRR_WEIGHT:     0.70,
  CONF_PICK_CONF_WEIGHT:    0.03,

  // ── play_probability factors (must sum to ≤ 1.0 for full play prob) ──
  PLAY_LINEUP_CONFIRMED:    0.40,   // batter is in announced starting lineup
  PLAY_ORDER_REGULAR:       0.20,   // batting order 1-7 (regular starters)
  PLAY_ORDER_BOTTOM:        0.10,   // batting order 8-9 (often subs/platoons)
  PLAY_PA_RECENT:           0.20,   // had PAs in recent games (consistent starter)
  PLAY_HEALTHY:             0.15,   // not on injury list
  PLAY_NOT_BACKUP:          0.05,   // not a known backup/platoon player
};

/**
 * Compute data_confidence (1.0 - 10.0)
 * Identical to original logic — measures data completeness for the projection
 */
export function computeDataConfidence(batter, oppPitcher, hasVegas) {
  const C = CONF_CONFIG;
  let conf = 0;

  // Season depth
  const pa = batter.pa || 0;
  conf += Math.min(pa / C.CONF_PA_SCALE, 1.0) * C.CONF_PA_MAX;

  // Statcast profile
  if (batter.xwoba != null)      conf += C.CONF_SAVANT_XWOBA;
  if (batter.barrelPct != null)  conf += C.CONF_SAVANT_BARREL;
  if (batter.hardHitPct != null) conf += C.CONF_SAVANT_HARDHIT;
  if (batter.exitVelo != null)   conf += C.CONF_SAVANT_EV;
  if (batter.vsLeftOPS != null || batter.vsRightOPS != null) conf += C.CONF_SPLITS_EXIST;

  // Recent form
  conf += Math.min((batter.last10AB || 0) / C.CONF_L10_SCALE, 1.0) * C.CONF_L10_MAX;
  if (batter.streakType === "hot")       conf += C.CONF_STREAK_HOT;
  else if (batter.streakType === "warm") conf += C.CONF_STREAK_WARM;
  if ((batter.hitStreak || 0) >= C.CONF_HITSTREAK_MIN) conf += C.CONF_HITSTREAK_BONUS;

  // Matchup intel
  if (batter.bvp && batter.bvp.ab > 0) {
    conf += Math.min(batter.bvp.ab / C.CONF_BVP_SCALE, 1.0) * C.CONF_BVP_MAX;
  }
  if (oppPitcher && oppPitcher.xera && oppPitcher.name !== "TBD") conf += C.CONF_PITCHER_XERA;
  if (oppPitcher && oppPitcher.name !== "TBD") conf += C.CONF_PITCHER_KNOWN;

  // Game context
  const order = batter.order || 9;
  if (order <= 2)      conf += C.CONF_ORDER_TOP;
  else if (order <= 5) conf += C.CONF_ORDER_MID;
  else if (order <= 7) conf += C.CONF_ORDER_LOW;
  else                 conf += C.CONF_ORDER_BOT;
  if (hasVegas)        conf += C.CONF_VEGAS;
  if (!batter.injured) conf += C.CONF_NOT_INJURED;
  conf += C.CONF_LINEUP_CONFIRMED;

  // Data convergence
  if (pa >= 80 && batter.xwoba != null) conf += C.CONF_CONVERGE_PA_SAVANT;
  if (pa >= 50 && (batter.last10AB || 0) >= 15) conf += C.CONF_CONVERGE_PA_L10;
  if (batter.bvp && batter.bvp.ab >= 8 && batter.xwoba != null) conf += C.CONF_CONVERGE_BVP_SAVANT;
  if (pa >= 150 && batter.barrelPct != null && batter.hardHitPct != null) conf += C.CONF_CONVERGE_FULL_SAVANT;

  // Sample size penalties
  if (pa < 20)      conf += C.CONF_PENALTY_TINY;
  else if (pa < 40) conf += C.CONF_PENALTY_SMALL;

  return Math.round(Math.min(10, Math.max(1, conf)) * 10) / 10;
}

/**
 * Compute play_probability (0.0 - 1.0)
 *
 * Answers: "Will this player actually get plate appearances today?"
 *
 * Inputs:
 *   - lineupConfirmed: boolean — is the batter in an officially announced lineup?
 *   - order: 1-9 batting order
 *   - last10AB: rolling AB total (consistency proxy)
 *   - injured: on injury list?
 *   - knownBackup: is this player flagged as a backup/platoon?
 */
export function computePlayProbability(batter, lineupConfirmed) {
  const C = CONF_CONFIG;
  let prob = 0;

  // Strongest signal: in confirmed lineup
  if (lineupConfirmed) prob += C.PLAY_LINEUP_CONFIRMED;

  // Batting order signal
  const order = batter.order || 9;
  if (order >= 1 && order <= 7) prob += C.PLAY_ORDER_REGULAR;
  else if (order >= 8 && order <= 9) prob += C.PLAY_ORDER_BOTTOM;

  // Recent ABs = consistent starter
  // L10 AB ≥ 30 means roughly 3+ ABs/game last 10 games (regular starter)
  const l10 = batter.last10AB || 0;
  if (l10 >= 30) prob += C.PLAY_PA_RECENT;
  else if (l10 >= 15) prob += C.PLAY_PA_RECENT * 0.5;

  // Health status
  if (!batter.injured) prob += C.PLAY_HEALTHY;

  // Bench/backup penalty (heuristic: if batting 9th AND L10 AB < 15)
  const isLikelyBackup = order === 9 && l10 < 15;
  if (!isLikelyBackup) prob += C.PLAY_NOT_BACKUP;

  return Math.round(Math.min(1.0, Math.max(0, prob)) * 100) / 100;
}

/**
 * Compute pickScore using both confidence dimensions
 *
 * pickScore = HRR × confidenceMultiplier × playProbability
 * confidenceMultiplier ranges roughly 0.73 - 1.0 (HRR_WEIGHT + 10×CONF_WEIGHT)
 */
export function computePickScore(hrr, dataConfidence, playProbability) {
  const C = CONF_CONFIG;
  const confMult = C.CONF_PICK_HRR_WEIGHT + (dataConfidence || 0) * C.CONF_PICK_CONF_WEIGHT;
  const score = hrr * confMult * (playProbability || 0);
  return Math.round(score * 100) / 100;
}
