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
const SEASONS_DIR = "data/seasons";   // one file per year: data/seasons/2026.json, plus index.json
const CONCURRENCY = 12;
const GAME_TYPES = new Set(["R", "F", "D", "L", "W"]); // regular season + postseason

const iso = d => d.toISOString().slice(0, 10);
let [argFrom, argTo] = process.argv.slice(2);
if (argFrom && /^\d{4}$/.test(argFrom)) { argTo = `${argFrom}-11-15`; argFrom = `${argFrom}-03-15`; }   // whole season
const to = argTo ?? iso(new Date());
const from = argFrom ?? iso(new Date(Date.now() - 3 * 864e5));
const YEAR = from.slice(0, 4);
const OUT = `${SEASONS_DIR}/${YEAR}.json`;

async function getJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return r.json();
      if (r.status === 404) return null;
      if (i === tries - 1) return null;
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
  // MLB's highlight archive only goes back to 2019; skip the clip lookup for earlier seasons.
  const [pbp, content] = await Promise.all([
    getJSON(`${API}/v1/game/${pk}/playByPlay`),
    Number(YEAR) >= 2019 && !process.env.SKIP_CONTENT ? getJSON(`${API}/v1/game/${pk}/content`) : null,
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
      gs: p.result.rbi === 4,
      wo: !isTop && p.about.inning >= 9 && game.status.abstractGameState === "Final" && p === (pbp.allPlays ?? []).at(-1),
      distance: hd.totalDistance ?? null, ev: hd.launchSpeed ?? null, la: hd.launchAngle ?? null,
      time: p.about.endTime ?? p.about.startTime ?? null,
      title: clip?.title ?? null, mp4,
      poster: clip?.image?.cuts?.find(c => c.width >= 640)?.src ?? null,
    });
  }
  return out;
}

// MLB posts clips minutes to hours after a game and its highlight feed sometimes answers incompletely.
// Every run, revisit homers that still lack a clip (newest first) and fill in what MLB has now.
// Second-chance match for clips MLB published without the play-ID tag: the batter's name plus his
// season HR number, which MLB puts in the title as "(17)". Only used when there is exactly one candidate.
const norm = s => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
function seasonNumbers(list) {
  const byBatter = {};
  for (const h of [...list].sort((a, b) => (a.time ?? a.date).localeCompare(b.time ?? b.date))) h.seasonNo = (byBatter[h.batterId] = (byBatter[h.batterId] ?? 0) + 1);
}
function titleMatch(h, items, gameHRsByBatter) {
  const last = norm(h.batter.split(" ").filter(w => !/^(jr\.?|sr\.?|ii|iii)$/i.test(w)).at(-1));
  const ord = n => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][Math.min(n % 10, 4)] ?? "th");
  const isHR = t => /homer|home run|\bHR\b|goes deep|blast|dinger|tater|moonshot/i.test(t);
  const isMulti = t => /two-|three-|four-|multi|\bHRs\b|\b(two|three|four) homers/i.test(t);
  const isAnalysis = t => /talks|discusses|on his|measuring|the stats|the distance behind|data viz|deep dive|bat tracking|visualizing|animated|breaking down|through the numbers/i.test(t);
  const mine = items.filter(it => isHR(it.title) && norm(it.title).includes(last) && !isMulti(it.title) && !isAnalysis(it.title));
  const one = list => (list.length === 1 ? list[0] : null);
  const n = h.seasonNo;
  return one(mine.filter(it => it.title.includes(`(${n})`)))                               // "solo home run (16)"
      ?? one(mine.filter(it => new RegExp(`\\b${ord(n)}\\b`, "i").test(it.title)))          // "16th homer of the year"
      ?? one(mine.filter(it => h.distance && it.title.includes(`${Math.round(h.distance)}-foot`))) // "hammers 442-foot homer"
      ?? (n === 1 ? one(mine.filter(it => /first career/i.test(it.title))) : null)          // "first career home run"
      ?? (gameHRsByBatter === 1 ? one(mine.filter(it => !/field view/i.test(it.title))) ?? one(mine) : null); // his only HR of the game, one clip
}

// Baseball Savant has a video page per play with a direct mp4, including years MLB's highlight
// archive doesn't cover. Used only for homers MLB has no clip for. Bounded per run to stay polite.
const UA = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36" };
async function fillFromSavant(list) {
  const max = Number(process.env.SAVANT_MAX ?? 300);
  const missing = list.filter(h => !h.mp4 && h.id && !h.savantChecked).sort((a, b) => b.date.localeCompare(a.date)).slice(0, max);
  if (!missing.length) return;
  let filled = 0, failed = 0;
  const SAV = 6; let i = 0;
  await Promise.all(Array.from({ length: SAV }, async () => {
    while (i < missing.length) {
      const h = missing[i++];
      try {
        const r = await fetch(`https://baseballsavant.mlb.com/sporty-videos?playId=${h.id}`, { headers: UA });
        if (!r.ok) { failed++; continue; }
        const m = (await r.text()).match(/https:\/\/[^"']+\.mp4[^"']*/);
        if (m) { h.mp4 = m[0]; h.src = "savant"; filled++; }
        else if (Date.now() - new Date(h.date) > 7 * 864e5) h.savantChecked = true;   // old play with no video — don't keep asking
      } catch { failed++; }
    }
  }));
  console.log(`savant fill: tried ${missing.length} → filled ${filled}${failed ? `, ${failed} request failures` : ""}`);
}

async function fillMissingClips(list) {
  if (Number(YEAR) < 2019) return fillFromSavant(list);   // no MLB highlight archive before 2019
  seasonNumbers(list);
  const missing = list.filter(h => !h.mp4 && h.id);
  const games = [...new Set(missing.sort((a, b) => b.date.localeCompare(a.date)).map(h => h.gamePk))].slice(0, Number(process.env.MAX_FILL_GAMES ?? 400));
  if (!games.length) return fillFromSavant(list);
  let filled = 0;
  await pool(games, async pk => {
    const content = await getJSON(`${API}/v1/game/${pk}/content`, 4);
    const items = content?.highlights?.highlights?.items ?? [];
    const clips = new Map(items.filter(it => it.guid).map(it => [it.guid, it]));
    const perBatterInGame = {};
    for (const x of list) if (x.gamePk === pk) perBatterInGame[x.batterId] = (perBatterInGame[x.batterId] ?? 0) + 1;
    for (const h of missing) {
      if (h.gamePk !== pk) continue;
      const clip = clips.get(h.id) ?? titleMatch(h, items, perBatterInGame[h.batterId]);
      if (!clip) continue;
      h.mp4 = clip.playbacks?.find(x => x.name === "mp4Avc")?.url ?? clip.playbacks?.find(x => /mp4/i.test(x.name))?.url ?? null;
      h.poster = clip.image?.cuts?.find(c => c.width >= 640)?.src ?? null;
      h.title = clip.title ?? h.title;
      if (h.mp4) filled++;
    }
  });
  console.log(`clip fill: ${missing.length} missing across ${games.length} games → filled ${filled}`);
  await fillFromSavant(list);
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

  const season = Number(process.env.SEASON ?? games[0]?.season ?? from.slice(0, 4));
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
  // MLB's highlight feed for a game can go briefly empty while they rebuild it. Never let a re-fetch
  // erase a clip we already had.
  const prior = new Map(existing.homeRuns.map(h => [h.id, h]));
  for (const h of fresh) {
    const old = prior.get(h.id);
    if (old?.mp4 && !h.mp4) { h.mp4 = old.mp4; h.poster = old.poster; h.title = old.title; }
  }
  const byId = new Map([...kept, ...fresh].map(h => [h.id, h]));
  await fillMissingClips([...byId.values()]);
  const all = [...byId.values()].sort((a, b) => (a.time ?? a.date).localeCompare(b.time ?? b.date));

  await mkdir("data", { recursive: true });
  await writeFile(OUT, JSON.stringify({ season, updated: new Date().toISOString(), homeRuns: all }));
  // keep the list of available seasons current (newest first)
  let years = [];
  try { years = JSON.parse(await readFile(`${SEASONS_DIR}/index.json`, "utf8")).years ?? []; } catch {}
  if (!years.includes(season)) years.push(season);
  years.sort((a, b) => b - a);
  await mkdir(SEASONS_DIR, { recursive: true });
  await writeFile(`${SEASONS_DIR}/index.json`, JSON.stringify({ years, updated: new Date().toISOString() }));
  console.log(`wrote ${all.length} home runs (${fresh.length} from this run) → ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
