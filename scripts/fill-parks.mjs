// Adds Baseball Savant's "how many of the 30 parks would this have left" data to a season file,
// plus the pitcher's MLB ID. One request per batter per season; joined on play ID.
//
//   node scripts/fill-parks.mjs 2026            # only batters with homers still missing park data
//   FULL=1 node scripts/fill-parks.mjs 2026     # every batter (re-checks everything)
//   RECENT_DAYS=3 node scripts/fill-parks.mjs 2026   # batters who homered in the last N days (daily job)
//
// Fields written per homer:
//   parks / cat        raw overlay — the ball's flight against each park's fences (what Savant's play page shows)
//   parksAdj / catAdj  adjusted for each park's air (altitude, etc.) — Savant's default leaderboard view
//   pitcherId

import { readFile, writeFile } from "node:fs/promises";

const year = process.argv[2] ?? new Date().getFullYear();
const FILE = `data/seasons/${year}.json`;
const UA = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36" };
const MAX = Number(process.env.MAX_PLAYERS ?? 800);
const PARKS = ["ari","atl","bal","bos","chc","cin","cle","col","cws","det","hou","kc","laa","lad","mia","mil","min","nym","nyy","oak","phi","pit","sd","sea","sf","stl","tb","tex","tor","wsh"];

const data = JSON.parse(await readFile(FILE, "utf8"));
const byId = new Map(data.homeRuns.map(h => [h.id, h]));

let batters = [...new Set(data.homeRuns.map(h => h.batterId))];
if (process.env.RECENT_DAYS) {
  const since = new Date(Date.now() - Number(process.env.RECENT_DAYS) * 864e5).toISOString().slice(0, 10);
  batters = [...new Set(data.homeRuns.filter(h => h.date >= since || h.parks == null).map(h => h.batterId))];
} else if (!process.env.FULL) {
  batters = [...new Set(data.homeRuns.filter(h => h.parks == null || h.parksAdj == null).map(h => h.batterId))];
}
if (process.env.ONLY) batters = [Number(process.env.ONLY)];   // one batter, for checking a specific homer
batters = batters.slice(0, MAX);
if (!batters.length) {
  const since = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);
  const recent = Object.fromEntries(data.homeRuns.filter(h => h.date >= since && h.parks != null).map(h => [h.id, h.parks]));
  await writeFile("data/recent-parks.json", JSON.stringify({ updated: new Date().toISOString(), parks: recent }));
  console.log(`${year}: park data complete`); process.exit(0);
}

let joined = 0, failed = 0, i = 0;
await Promise.all(Array.from({ length: 5 }, async () => {
  while (i < batters.length) {
    const id = batters[i++];
    try {
      const base = `https://baseballsavant.mlb.com/leaderboard/home-runs?type=details&year=${year}&player_id=${id}&csv=true`;
      const [raw, adj] = await Promise.all([fetch(base + "&cat=xhr", { headers: UA }), fetch(base, { headers: UA })]);
      if (!raw.ok && !adj.ok) { failed++; continue; }
      const rawRows = raw.ok ? await raw.json() : [], adjRows = adj.ok ? await adj.json() : [];
      for (const x of rawRows) {
        const h = byId.get(x.play_id);
        if (!h || x.result !== "home_run") continue;
        let parks = Number(x.ct);
        // 2020: the raw model's Toronto entry (the Blue Jays' Buffalo season) is broken and marks almost every
        // homer as "not out in TOR". Savant's own play pages ignore it; so do we.
        if (String(year) === "2020" && !Number.isNaN(parks)) {
          const others = PARKS.filter(p => p !== "tor").reduce((n, p) => n + (Number(x[p]) ? 1 : 0), 0);
          parks = others + 1;
        }
        if (!Number.isNaN(parks)) { h.parks = parks; h.cat = parks === 30 ? "No Doubter" : (x.hr_cat || null); }
        if (x.pitcher_id && !h.pitcherId) h.pitcherId = Number(x.pitcher_id);
        joined++;
      }
      for (const x of adjRows) {
        const h = byId.get(x.play_id);
        if (!h || x.result !== "home_run") continue;
        const parks = Number(x.ct);
        if (!Number.isNaN(parks)) { h.parksAdj = parks; h.catAdj = x.hr_cat || null; }
        if (x.pitcher_id && !h.pitcherId) h.pitcherId = Number(x.pitcher_id);
      }
    } catch { failed++; }
  }
}));
await writeFile(FILE, JSON.stringify(data));
// small lookup the live Today board can merge: play id → park count, last 14 days
const since = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);
const recent = Object.fromEntries(data.homeRuns.filter(h => h.date >= since && h.parks != null).map(h => [h.id, h.parks]));
await writeFile("data/recent-parks.json", JSON.stringify({ updated: new Date().toISOString(), parks: recent }));
const done = data.homeRuns.filter(h => h.parks != null).length, nd = data.homeRuns.filter(h => h.parks === 30).length, ndAdj = data.homeRuns.filter(h => h.parksAdj === 30).length;
console.log(`${year}: checked ${batters.length} batters, joined ${joined}${failed ? `, ${failed} failures` : ""} → ${done}/${data.homeRuns.length} have park data, ${nd} no-doubters (30/30 raw), ${ndAdj} adjusted`);
