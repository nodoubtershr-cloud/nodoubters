// Builds the "All seasons" data from data/seasons/*.json:
//   data/all/top.json            the 500 longest home runs since 2015 (plus summary counts)
//   data/all/players.json        index of every hitter: id, name, HR total, longest, seasons
//   data/all/players/<id>.json   every home run by that hitter, newest first
// Runs after update-season.mjs in the daily GitHub Action.
//
//   node scripts/build-all.mjs

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";

const DIR = "data/seasons";
const years = JSON.parse(await readFile(`${DIR}/index.json`, "utf8")).years.sort((a, b) => a - b);
const byDist = (a, b) => (b.distance ?? -1) - (a.distance ?? -1);

const all = [];
for (const y of years) {
  const d = JSON.parse(await readFile(`${DIR}/${y}.json`, "utf8"));
  for (const h of d.homeRuns) { h.season = y; all.push(h); }
}

await mkdir("data/all/players", { recursive: true });

// leaderboard
const ranked = all.filter(h => h.distance != null).sort(byDist);
await writeFile("data/all/top.json", JSON.stringify({
  from: years[0], to: years.at(-1), total: all.length, updated: new Date().toISOString(),
  through: all.reduce((m, h) => (h.date > m ? h.date : m), ""),
  homeRuns: ranked.slice(0, 500),
  postseason: ranked.filter(h => h.gt && h.gt !== "R").slice(0, 500),   // longest playoff homers
}));

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
await writeFile("data/all/players.json", JSON.stringify({ from: years[0], to: years.at(-1), players: index }));
console.log(`all-seasons: ${all.length} HR across ${years[0]}–${years.at(-1)}, ${index.length} players, top ${Math.min(500, ranked.length)} written`);
