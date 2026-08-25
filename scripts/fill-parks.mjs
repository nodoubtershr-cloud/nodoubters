// Adds Baseball Savant's "how many of the 30 parks would this have left" data to a season file,
// plus the pitcher's MLB ID. One request per batter per season; joined on play ID.
//
//   node scripts/fill-parks.mjs 2026            # only batters with homers still missing park data
//   FULL=1 node scripts/fill-parks.mjs 2026     # every batter (re-checks everything)
//   RECENT_DAYS=3 node scripts/fill-parks.mjs 2026   # batters who homered in the last N days (daily job)
//
// Fields written per homer: parks (0–30), cat ("No Doubter" | "Mostly Gone" | "Doubter"), pitcherId

import { readFile, writeFile } from "node:fs/promises";

const year = process.argv[2] ?? new Date().getFullYear();
const FILE = `data/seasons/${year}.json`;
const UA = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36" };
const MAX = Number(process.env.MAX_PLAYERS ?? 800);

const data = JSON.parse(await readFile(FILE, "utf8"));
const byId = new Map(data.homeRuns.map(h => [h.id, h]));

let batters = [...new Set(data.homeRuns.map(h => h.batterId))];
if (process.env.RECENT_DAYS) {
  const since = new Date(Date.now() - Number(process.env.RECENT_DAYS) * 864e5).toISOString().slice(0, 10);
  batters = [...new Set(data.homeRuns.filter(h => h.date >= since || h.parks == null).map(h => h.batterId))];
} else if (!process.env.FULL) {
  batters = [...new Set(data.homeRuns.filter(h => h.parks == null).map(h => h.batterId))];
}
batters = batters.slice(0, MAX);
if (!batters.length) { console.log(`${year}: park data complete`); process.exit(0); }

let joined = 0, failed = 0, i = 0;
await Promise.all(Array.from({ length: 5 }, async () => {
  while (i < batters.length) {
    const id = batters[i++];
    try {
      const r = await fetch(`https://baseballsavant.mlb.com/leaderboard/home-runs?type=details&year=${year}&player_id=${id}&csv=true`, { headers: UA });
      if (!r.ok) { failed++; continue; }
      const rows = await r.json();
      for (const x of rows) {
        const h = byId.get(x.play_id);
        if (!h || x.result !== "home_run") continue;
        const parks = Number(x.ct);
        if (!Number.isNaN(parks)) { h.parks = parks; h.cat = x.hr_cat || null; }
        if (x.pitcher_id && !h.pitcherId) h.pitcherId = Number(x.pitcher_id);
        joined++;
      }
    } catch { failed++; }
  }
}));
await writeFile(FILE, JSON.stringify(data));
const done = data.homeRuns.filter(h => h.parks != null).length, nd = data.homeRuns.filter(h => h.parks === 30).length;
console.log(`${year}: checked ${batters.length} batters, joined ${joined}${failed ? `, ${failed} failures` : ""} → ${done}/${data.homeRuns.length} have park data, ${nd} no-doubters (30/30)`);
