#!/usr/bin/env node
import Anthropic from "@anthropic-ai/sdk";
import { Octokit } from "@octokit/rest";

const TODAY = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "America/New_York" });

const SYSTEM_PROMPT = `You are an MLB data analyst. Respond with ONLY a raw JSON object. No words before or after. No markdown. No backticks. Start with { and end with }. Must be parseable by JSON.parse().`;

const USER_PROMPT = `Today is ${TODAY}. Search for tonight's MLB games and return this exact JSON structure: {"date":"YYYY-MM-DD","generatedAt":"ISO timestamp","games":[{"id":1,"time":"7:05 PM","stadium":"Name · City","parkFactor":1.05,"weatherNote":"72F, 8mph out","weatherRisk":false,"away":{"abbr":"NYY","name":"New York Yankees","pitcher":{"name":"Gerrit Cole","hand":"R","era":3.50,"k9":10.2,"xfip":3.40},"lineup":[{"name":"Aaron Judge","pos":"RF","order":1,"bats":"R","ops":0.950,"wrcPlus":165,"hotStreak":false}]},"home":{"abbr":"BOS","name":"Boston Red Sox","pitcher":{"name":"Chris Sale","hand":"L","era":3.20,"k9":9.8,"xfip":3.10},"lineup":[{"name":"Rafael Devers","pos":"3B","order":3,"bats":"L","ops":0.880,"wrcPlus":140,"hotStreak":true}]}}]} Include all evening games not yet started. Include top 8 batters per team. Use real 2026 stats.`;

async function fetchWithRetry(client, attempt = 1) {
  console.log(`[${attempt}/3] Calling Claude API with web search...`);
  const response = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 4000,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: USER_PROMPT }],
  });

  const textBlocks = response.content.filter((b) => b.type === "text");
  if (!textBlocks.length) {
    if (attempt < 3) {
      console.log("No text in response, retrying...");
      await new Promise((r) => setTimeout(r, 5000));
      return fetchWithRetry(client, attempt + 1);
    }
    throw new Error("No text content returned after 3 attempts");
  }

  const raw = textBlocks.map((b) => b.text).join("");
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    if (attempt < 3) {
      console.log(`JSON parse failed (${e.message}), retrying in 5s...`);
      await new Promise((r) => setTimeout(r, 5000));
      return fetchWithRetry(client, attempt + 1);
    }
    throw new Error(`Failed to parse JSON after 3 attempts: ${e.message}\n\nRaw:\n${raw.slice(0, 500)}`);
  }
}

function computeHRR(batter, oppPitcher, parkFactor) {
  const ops = batter.ops || 0.7;
  const wrc = batter.wrcPlus || 100;
  const talentScore = (Math.min(5, Math.max(1, (ops - 0.5) * 10)) + Math.min(5, Math.max(1, (wrc - 60) * 0.05))) / 2;
  const orderMultiplier = batter.order <= 2 ? 4.5 : batter.order <= 5 ? 4.0 : 2.8;
  let matchup = 3.0;
  const platoon = (batter.bats === "L" && oppPitcher.hand === "R") || (batter.bats === "R" && oppPitcher.hand === "L");
  if (platoon) matchup += 0.7; else matchup -= 0.5;
  if (oppPitcher.k9 > 10.0) matchup -= 1.2;
  if (oppPitcher.era > 4.5) matchup += 0.5;
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

async function uploadToGist(octokit, gistId, data) {
  console.log("Uploading to Gist...");
  await octokit.gists.update({
    gist_id: gistId,
    files: { "hrr-data.json": { content: JSON.stringify(data, null, 2) } },
  });
  console.log(`Gist updated: https://gist.github.com/${gistId}`);
}

async function main() {
  const missingVars = ["ANTHROPIC_API_KEY", "GIST_ID", "GITHUB_TOKEN"].filter((v) => !process.env[v]);
  if (missingVars.length) { console.error(`Missing env vars: ${missingVars.join(", ")}`); process.exit(1); }

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

main().catch((err) => { console.error("Fatal error:", err.message); process.exit(1); });
