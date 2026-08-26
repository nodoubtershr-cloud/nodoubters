// Builds the "All seasons" data from data/seasons/*.json:
//   data/all/top.json            the 500 longest home runs since 2015 (plus summary counts)
//   data/all/players.json        index of every hitter: id, name, HR total, longest, seasons
//   data/all/players/<id>.json   every home run by that hitter, newest first
// Runs after update-season.mjs in the daily GitHub Action.
//
//   node scripts/build-all.mjs

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";

const DIR = "data/seasons";
const FIRST_SEASON = 2016;
const years = JSON.parse(await readFile(`${DIR}/index.json`, "utf8")).years.filter(y => y >= FIRST_SEASON).sort((a, b) => a - b);
const byDist = (a, b) => (b.distance ?? -1) - (a.distance ?? -1);

const all = [];
for (const y of years) {
  const d = JSON.parse(await readFile(`${DIR}/${y}.json`, "utf8"));
  for (const h of d.homeRuns) { h.season = y; all.push(h); }
}

await mkdir("data/all/players", { recursive: true });

// ---------- career numbering + milestones ----------
// Regular-season homers only. For each hitter, "base" = career HR before our data began (MLB career total
// minus what we have), computed once and cached so daily runs don't hit the API for 1,500 players.
const CAREER_FILE = "data/all/career-base.json";
let careerBase = {};
try { careerBase = JSON.parse(await readFile(CAREER_FILE, "utf8")); } catch {}
const regular = all.filter(h => (h.gt ?? "R") === "R");
const byBatter = {};
for (const h of regular) (byBatter[h.batterId] ||= []).push(h);
const need = Object.keys(byBatter).filter(id => careerBase[id] == null);
let i = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (i < need.length) {
    const id = need[i++];
    try {
      const r = await fetch(`https://statsapi.mlb.com/api/v1/people/${id}/stats?stats=career&group=hitting`);
      const total = Number((await r.json()).stats?.[0]?.splits?.[0]?.stat?.homeRuns ?? NaN);
      if (!Number.isNaN(total)) careerBase[id] = Math.max(0, total - byBatter[id].length);
    } catch {}
  }
}));
if (need.length) await writeFile(CAREER_FILE, JSON.stringify(careerBase));
const isMilestone = n => n === 1 || (n > 0 && n % 100 === 0);
let milestones = 0;
const careerIndex = {};
for (const [id, list] of Object.entries(byBatter)) {
  const base = careerBase[id] ?? 0;
  list.sort((a, b) => (a.time ?? a.date).localeCompare(b.time ?? b.date));
  list.forEach((h, k) => { h.career = base + k + 1; if (isMilestone(h.career)) { h.ms = h.career; milestones++; } else delete h.ms; });
  careerIndex[id] = { name: list.at(-1).batter, base, count: base + list.length, through: list.at(-1).date };
}
await writeFile("data/all/career.json", JSON.stringify({ updated: new Date().toISOString(), players: careerIndex }));
// write career numbers back into the season files so the Season tab has them too
for (const y of years) {
  const f = `${DIR}/${y}.json`; const d = JSON.parse(await readFile(f, "utf8"));
  const m = new Map(all.filter(h => h.season === y).map(h => [h.id, h]));
  for (const h of d.homeRuns) { const x = m.get(h.id); if (x?.career) { h.career = x.career; if (x.ms) h.ms = x.ms; else delete h.ms; } }
  await writeFile(f, JSON.stringify(d));
}
console.log(`career milestones: ${milestones} (${need.length} players looked up this run)`);

// leaderboard
const ranked = all.filter(h => h.distance != null).sort(byDist);
await writeFile("data/all/top.json", JSON.stringify({
  from: years[0], to: years.at(-1), total: all.length, updated: new Date().toISOString(),
  through: all.reduce((m, h) => (h.date > m ? h.date : m), ""),
  homeRuns: ranked.slice(0, 2000),
  postseason: ranked.filter(h => h.gt && h.gt !== "R").slice(0, 2000),   // longest playoff homers
}));

// all-time lists behind each Filter (so "All seasons + Walk-offs" means every walk-off, not just the longest 500)
{
  await mkdir("data/all/lists", { recursive: true });
  const multi = new Set(); { const c = {}; for (const h of all) { const k = `${h.gamePk}|${h.batterId}`; c[k] = (c[k] || 0) + 1; } for (const [k, n] of Object.entries(c)) if (n >= 2) multi.add(k); }
  const lists = {
    wo: h => h.wo, gs: h => h.gs, ms: h => h.ms, ws: h => h.gt === "W", post: h => h.gt && h.gt !== "R",
    450: h => h.distance >= 450, 475: h => h.distance >= 475, multi: h => multi.has(`${h.gamePk}|${h.batterId}`),
  };
  for (const [k, test] of Object.entries(lists)) {
    const rows = all.filter(test).sort(byDist);
    await writeFile(`data/all/lists/${k}.json`, JSON.stringify({ key: k, count: rows.length, homeRuns: rows }));
  }
}

// per-team (for or against) and per-ballpark histories, so team/park searches in All are complete
{
  await mkdir("data/all/teams", { recursive: true }); await mkdir("data/all/venues", { recursive: true });
  const teams = {}, venues = {}, venueNames = {};
  for (const h of all) {
    (teams[h.teamAbbr] ||= []).push(h); if (h.against && h.against !== h.teamAbbr) (teams[h.against] ||= []).push(h);
    if (h.venueId) { (venues[h.venueId] ||= []).push(h); venueNames[h.venueId] = h.venue; }
  }
  for (const [abbr, list] of Object.entries(teams)) { list.sort(byDist); await writeFile(`data/all/teams/${abbr}.json`, JSON.stringify({ team: abbr, count: list.length, homeRuns: list })); }
  for (const [id, list] of Object.entries(venues)) { list.sort(byDist); await writeFile(`data/all/venues/${id}.json`, JSON.stringify({ venueId: Number(id), venue: venueNames[id], count: list.length, homeRuns: list })); }
  await writeFile("data/all/venues.json", JSON.stringify({ venues: Object.entries(venueNames).map(([id, name]) => ({ id: Number(id), name, count: venues[id].length })).sort((a, b) => b.count - a.count) }));
  console.log(`team files: ${Object.keys(teams).length} · ballpark files: ${Object.keys(venues).length}`);
}

// players
const players = {};
for (const h of all) (players[h.batterId] ||= []).push(h);
const index = [];
for (const [id, list] of Object.entries(players)) {
  list.sort((a, b) => (b.time ?? b.date).localeCompare(a.time ?? a.date));
  const longest = [...list].sort(byDist)[0];
  const name = list[0].batter;                        // most recent spelling of the name
  index.push({ id: Number(id), name, n: list.length, longest: longest?.distance ?? null, seasons: [...new Set(list.map(h => h.season))].sort(), team: list[0].teamAbbr });
  await writeFile(`data/all/players/${id}.json`, JSON.stringify({ id: Number(id), name, homeRuns: list }));
}
index.sort((a, b) => b.n - a.n);

// pitchers ("victims" view) — only homers that carry a pitcher ID
const pitchers = {};
for (const h of all) if (h.pitcherId) (pitchers[h.pitcherId] ||= []).push(h);
const pindex = [];
await mkdir("data/all/pitchers", { recursive: true });
for (const [id, list] of Object.entries(pitchers)) {
  list.sort((a, b) => (b.time ?? b.date).localeCompare(a.time ?? a.date));
  const longest = [...list].sort(byDist)[0];
  pindex.push({ id: Number(id), name: list[0].pitcher, n: list.length, longest: longest?.distance ?? null, seasons: [...new Set(list.map(h => h.season))].sort(), team: list[0].against });
  await writeFile(`data/all/pitchers/${id}.json`, JSON.stringify({ id: Number(id), name: list[0].pitcher, homeRuns: list }));
}
pindex.sort((a, b) => b.n - a.n);
await writeFile("data/all/players.json", JSON.stringify({ from: years[0], to: years.at(-1), players: index, pitchers: pindex }));
console.log(`all-seasons: ${all.length} HR across ${years[0]}–${years.at(-1)}, ${index.length} players, ${pindex.length} pitchers, top ${Math.min(2000, ranked.length)} written`);
