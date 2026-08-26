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
  // batters with any homer still missing park data — or missing Statcast numbers MLB's feed never had
  batters = [...new Set(data.homeRuns.filter(h => h.parks == null || h.parksAdj == null || h.distance == null).map(h => h.batterId))];
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
        // MLB's feed occasionally lacks the batted-ball numbers; Savant's record has them
        if (h.distance == null && Number(x.hr_distance)) { h.distance = Number(x.hr_distance); h.ev = Number(x.exit_velocity) || null; h.la = Number(x.launch_angle) || null; h.statsSrc = "savant"; }
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
// Savant's Statcast search for anything still missing batted-ball numbers (one request per season)
{
  const gaps = data.homeRuns.filter(h => h.distance == null || h.ev == null);
  if (gaps.length) {
    try {
      const url = `https://baseballsavant.mlb.com/statcast_search/csv?all=true&hfAB=home%5C.%5C.run%7C&game_date_gt=${year}-01-01&game_date_lt=${year}-12-31&player_type=batter&type=details&min_pitches=0`;
      const csv = await (await fetch(url, { headers: UA })).text();
      const lines = csv.split("\n"); const cols = lines[0].split(",").map(c => c.replace(/"/g, ""));
      const ix = Object.fromEntries(cols.map((c, i) => [c, i]));
      const map = {};
      for (const line of lines.slice(1)) {
        if (!line.trim()) continue;
        const f = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map(x => x.replace(/,$/, "").replace(/^"|"$/g, ""));
        if (f[ix.events] !== "home_run") continue;
        map[`${f[ix.game_pk]}|${f[ix.batter]}|${f[ix.inning]}|${f[ix.inning_topbot] === "Top" ? "top" : "bottom"}`] = { d: Number(f[ix.hit_distance_sc]) || null, ev: Number(f[ix.launch_speed]) || null, la: Number(f[ix.launch_angle]) || null };
      }
      let filled = 0;
      for (const h of gaps) {
        const r = map[`${h.gamePk}|${h.batterId}|${h.inning}|${h.half}`]; if (!r) continue;
        if (h.distance == null && r.d) h.distance = r.d;
        if (h.ev == null && r.ev) h.ev = r.ev;
        if (h.la == null && r.la != null) h.la = r.la;
        if (r.d || r.ev) { h.statsSrc = "savant"; filled++; }
      }
      console.log(`${year}: Statcast gaps ${gaps.length} → filled ${filled} from Savant search`);
    } catch (e) { console.log(`${year}: Savant search unavailable (${e.message})`); }
  }
}
await writeFile(FILE, JSON.stringify(data));
// small lookup the live Today board can merge: play id → park count, last 14 days
const since = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);
const recent = Object.fromEntries(data.homeRuns.filter(h => h.date >= since && h.parks != null).map(h => [h.id, h.parks]));
await writeFile("data/recent-parks.json", JSON.stringify({ updated: new Date().toISOString(), parks: recent }));
const done = data.homeRuns.filter(h => h.parks != null).length, nd = data.homeRuns.filter(h => h.parks === 30).length, ndAdj = data.homeRuns.filter(h => h.parksAdj === 30).length;
console.log(`${year}: checked ${batters.length} batters, joined ${joined}${failed ? `, ${failed} failures` : ""} → ${done}/${data.homeRuns.length} have park data, ${nd} no-doubters (30/30 raw), ${ndAdj} adjusted`);
