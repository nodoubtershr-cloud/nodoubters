// Builds/updates data/season.json — every MLB home run of the season with Statcast
// distance and the official highlight clip. Same MLB endpoints the site uses live.
//
//   node scripts/update-season.mjs                 # refresh the last 3 days
//   node scripts/update-season.mjs 2026-03-25 2026-08-23   # explicit date range
//
// Re-running a date range replaces those games' entries, so clips that MLB posted
// late get picked up on the next run.

import { readFile, writeFile, mkdir } from "node:fs/promises";

const API = "https://statsapi.mlb.com/api";
const OUT = "data/season.json";
const CONCURRENCY = 12;
const GAME_TYPES = new Set(["R", "F", "D", "L", "W"]); // regular season + postseason

const iso = d => d.toISOString().slice(0, 10);
const [argFrom, argTo] = process.argv.slice(2);
const to = argTo ?? iso(new Date());
const from = argFrom ?? iso(new Date(Date.now() - 3 * 864e5));

async function getJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return r.json();
      if (r.status === 404) return null;
    } catch (e) { if (i === tries - 1) throw e; }
    await new Promise(res => setTimeout(res, 800 * (i + 1)));
  }
  return null;
}

async function pool(items, worker) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await worker(items[idx], idx); }
  }));
  return out;
}

async function gameHomeRuns(game, teams) {
  const pk = game.gamePk;
  const [pbp, content] = await Promise.all([
    getJSON(`${API}/v1/game/${pk}/playByPlay`),
    getJSON(`${API}/v1/game/${pk}/content`),
  ]);
  if (!pbp) return [];
  const clips = new Map();
  for (const it of content?.highlights?.highlights?.items ?? []) if (it.guid) clips.set(it.guid, it);

  const away = teams[game.teams.away.team.id], home = teams[game.teams.home.team.id];
  const out = [];
  for (const p of pbp.allPlays ?? []) {
    if (p.result?.eventType !== "home_run") continue;
    const bip = [...p.playEvents].reverse().find(e => e.hitData) ?? p.playEvents.at(-1);
    const hd = bip?.hitData ?? {};
    const isTop = p.about.halfInning === "top";
    const bat = isTop ? away : home, pit = isTop ? home : away;
    const clip = clips.get(bip?.playId);
    const mp4 = clip?.playbacks?.find(x => x.name === "mp4Avc")?.url
             ?? clip?.playbacks?.find(x => /mp4/i.test(x.name))?.url ?? null;
    out.push({
      id: bip?.playId ?? `${pk}-${p.about.atBatIndex}`,
      date: game.officialDate ?? game.gameDate.slice(0, 10),
      gamePk: pk,
      batter: p.matchup.batter.fullName, batterId: p.matchup.batter.id,
      pitcher: p.matchup.pitcher.fullName,
      team: bat.name, teamAbbr: bat.abbr, against: pit.abbr,
      inning: p.about.inning, half: p.about.halfInning, rbi: p.result.rbi,
      distance: hd.totalDistance ?? null, ev: hd.launchSpeed ?? null, la: hd.launchAngle ?? null,
      time: p.about.endTime ?? p.about.startTime ?? null,
      title: clip?.title ?? null, mp4,
      poster: clip?.image?.cuts?.find(c => c.width >= 640)?.src ?? null,
    });
  }
  return out;
}

async function main() {
  // team id -> abbreviation/name
  const teamsRes = await getJSON(`${API}/v1/teams?sportId=1`);
  const teams = Object.fromEntries(teamsRes.teams.map(t => [t.id, { abbr: t.abbreviation, name: t.name }]));

  const sched = await getJSON(`${API}/v1/schedule?sportId=1&startDate=${from}&endDate=${to}`);
  // A suspended-and-resumed game is listed under both dates; keep one entry per gamePk.
  const seen = new Set();
  const games = (sched?.dates ?? []).flatMap(d => d.games)
    .filter(g => GAME_TYPES.has(g.gameType) && g.status.abstractGameState !== "Preview")
    .filter(g => !seen.has(g.gamePk) && seen.add(g.gamePk));
  console.log(`${from} → ${to}: ${games.length} games`);

  let existing = { homeRuns: [] };
  try { existing = JSON.parse(await readFile(OUT, "utf8")); } catch {}

  let done = 0;
  const fresh = (await pool(games, async g => {
    try { return await gameHomeRuns(g, teams); }
    catch (e) { console.warn(`game ${g.gamePk} failed: ${e.message}`); return []; }
    finally { if (++done % 100 === 0) console.log(`  ${done}/${games.length}`); }
  })).flat();

  const touched = new Set(games.map(g => g.gamePk));
  const kept = existing.homeRuns.filter(h => !touched.has(h.gamePk));
  const byId = new Map([...kept, ...fresh].map(h => [h.id, h]));
  const all = [...byId.values()].sort((a, b) => (a.time ?? a.date).localeCompare(b.time ?? b.date));

  await mkdir("data", { recursive: true });
  const season = Number((games[0]?.season) ?? existing.season ?? new Date().getFullYear());
  await writeFile(OUT, JSON.stringify({ season, updated: new Date().toISOString(), homeRuns: all }));
  console.log(`wrote ${all.length} home runs (${fresh.length} from this run) → ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
