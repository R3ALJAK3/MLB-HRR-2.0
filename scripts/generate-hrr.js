#!/usr/bin/env node
/**
 * MLB HRR Daily Generator
 * Calls Claude API with web_search to fetch today's slate,
 * builds HRR projections, and uploads JSON to a GitHub Gist.
 *
 * Required env vars:
 *   ANTHROPIC_API_KEY  — your Anthropic API key
 *   GIST_ID            — GitHub Gist ID to update (create one manually first)
 *   GITHUB_TOKEN       — GitHub token with gist write scope
 */

import Anthropic from "@anthropic-ai/sdk";
import { Octokit } from "@octokit/rest";

const TODAY = new Date().toLocaleDateString("en-US", {
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: "America/New_York",
});

const SYSTEM_PROMPT = `You are a senior MLB sabermetrics analyst. You must respond with ONLY a raw JSON object. No words before it, no words after it, no markdown, no backticks, no code fences, no explanation. Your entire response must be parseable by JSON.parse(). Start your response with { and end with }.`;

const USER_PROMPT = `Today is ${TODAY}.

Search for and compile the following data, then return it as a single JSON object.

=== SCHEMA ===
{
  "date": "YYYY-MM-DD",
  "generatedAt": "ISO timestamp",
  "games": [
    {
      "id": number,
      "time": "H:MM PM",
      "stadium": "Name · City",
      "parkFactor": number,       // run park factor, e.g. 1.08
      "weatherNote": string,       // brief wind/temp note
      "weatherRisk": boolean,
      "away": {
        "abbr": "XXX",
        "name": "Full Name",
        "pitcher": {
          "name": "First Last",
          "hand": "R" or "L",
          "era": number,
          "k9": number,
          "xfip": number
        },
        "lineup": [
          {
            "name": "First Last",
            "pos": "SS",
            "order": 1,
            "bats": "R" or "L" or "S",
            "ops": number,
            "wrcPlus": number,
            "hotStreak": boolean
          }
        ]
      },
      "home": { /* same structure as away */ }
    }
  ]
}

=== DATA TO RESEARCH ===
1. Today's full MLB evening slate: all games, times, stadiums
2. Confirmed starting pitchers for each game with 2026 ERA, K/9, xFIP
3. Expected batting lineups (top 8 batters per team) with position and batting order
4. 2026 OPS and wRC+ for each batter (use best available 2026 in-season stats)
5. Park factors for each stadium (2026 run factor)
6. Notable weather conditions (temperature, wind direction/speed)
7. Any batter on a 5+ game hit streak (hotStreak: true)

Include ONLY games that have not yet started as of now (evening games).
Return ONLY the JSON object, nothing else.`;

async function fetchWithRetry(client, attempt = 1) {
  console.log(`[${attempt}/3] Calling Claude API with web search...`);

  const response = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 4000,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: USER_PROMPT }],
  });

  // Extract text from response (may include tool_use blocks)
  const textBlocks = response.content.filter((b) => b.type === "text");
  if (!textBlocks.length) {
    if (attempt < 3) {
      console.log("No text in response, retrying...");
      await new Promise((r) => setTimeout(r, 3000));
      return fetchWithRetry(client, attempt + 1);
    }
    throw new Error("No text content returned after 3 attempts");
  }

  const raw = textBlocks.map((b) => b.text).join("");

  // Strip any accidental markdown fences
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    return parsed;
  } catch (e) {
    if (attempt < 3) {
      console.log(`JSON parse failed (${e.message}), retrying...`);
      await new Promise((r) => setTimeout(r, 3000));
      return fetchWithRetry(client, attempt + 1);
    }
    throw new Error(`Failed to parse JSON after 3 attempts: ${e.message}\n\nRaw:\n${raw.slice(0, 500)}`);
  }
}

function computeHRR(batter, oppPitcher, parkFactor) {
  const ops = batter.ops || 0.7;
  const wrc = batter.wrcPlus || 100;

  const talentScore =
    (Math.min(5, Math.max(1, (ops - 0.5) * 10)) +
      Math.min(5, Math.max(1, (wrc - 60) * 0.05))) /
    2;

  const orderMultiplier =
    batter.order <= 2 ? 4.5 : batter.order <= 5 ? 4.0 : 2.8;

  let matchup = 3.0;
  const platoonAdvantage =
    (batter.bats === "L" && oppPitcher.hand === "R") ||
    (batter.bats === "R" && oppPitcher.hand === "L");
  if (platoonAdvantage) matchup += 0.7;
  else matchup -= 0.5;
  if (oppPitcher.k9 > 10.0) matchup -= 1.2;
  if (oppPitcher.era > 4.5) matchup += 0.5;

  const envScore = Math.min(5, Math.max(1, (parkFactor - 0.85) * 20));

  let score =
    talentScore * 0.3 +
    orderMultiplier * 0.25 +
    matchup * 0.25 +
    envScore * 0.2;

  if (batter.hotStreak) score *= 1.1;

  return Math.round(score * 100) / 100;
}

function enrichWithProjections(data) {
  const allPlayers = [];

  data.games.forEach((game) => {
    ["away", "home"].forEach((side) => {
      const team = game[side];
      const oppSide = side === "away" ? "home" : "away";
      const oppPitcher = game[oppSide].pitcher;

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

  // Build stacks
  const teamGroups = {};
  allPlayers.forEach((p) => {
    const key = `${p.team}-${p.gameId}`;
    if (!teamGroups[key]) teamGroups[key] = [];
    teamGroups[key].push(p);
  });

  const stacks2 = [];
  const stacks3 = [];
  Object.entries(teamGroups).forEach(([key, players]) => {
    const sorted = [...players].sort((a, b) => b.hrr - a.hrr);
    const [abbr] = key.split("-");
    const game = data.games.find((g) => g.away.abbr === abbr || g.home.abbr === abbr);
    const opp = game
      ? game.away.abbr === abbr
        ? game.home.abbr
        : game.away.abbr
      : "?";

    if (sorted.length >= 2) {
      const top2 = sorted.slice(0, 2);
      stacks2.push({ team: abbr, opp, time: top2[0].gameTime, players: top2, total: top2.reduce((s, p) => s + p.hrr, 0) });
    }
    if (sorted.length >= 3) {
      const top3 = sorted.slice(0, 3);
      stacks3.push({ team: abbr, opp, time: top3[0].gameTime, players: top3, total: top3.reduce((s, p) => s + p.hrr, 0) });
    }
  });

  data.stacks2 = stacks2.sort((a, b) => b.total - a.total).slice(0, 10);
  data.stacks3 = stacks3.sort((a, b) => b.total - a.total).slice(0, 10);

  return data;
}

async function uploadToGist(octokit, gistId, data) {
  console.log("Uploading to Gist...");
  await octokit.gists.update({
    gist_id: gistId,
    files: {
      "hrr-data.json": {
        content: JSON.stringify(data, null, 2),
      },
    },
  });
  console.log(`Gist updated: https://gist.github.com/${gistId}`);
}

async function main() {
  const missingVars = ["ANTHROPIC_API_KEY", "GIST_ID", "GITHUB_TOKEN"].filter(
    (v) => !process.env[v]
  );
  if (missingVars.length) {
    console.error(`Missing env vars: ${missingVars.join(", ")}`);
    process.exit(1);
  }

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

  console.log(`\n=== MLB HRR Generator — ${TODAY} ===\n`);

  const rawData = await fetchWithRetry(anthropic);
  console.log(`Got data: ${rawData.games?.length ?? 0} games`);

  const enriched = enrichWithProjections(rawData);
  enriched.generatedAt = new Date().toISOString();

  await uploadToGist(octokit, process.env.GIST_ID, enriched);

  console.log(`\nDone. Top play: ${enriched.topPlays[0]?.name} (${enriched.topPlays[0]?.hrr})`);
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
