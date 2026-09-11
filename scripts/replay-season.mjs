// Replays an entire season through the live bot's decision logic and checks the rules hold.
// Decisions only — no network, no video, no posting. Run before trusting the bot with real games.
//
//   node scripts/replay-season.mjs 2025
//   node scripts/replay-season.mjs 2025 --verbose

import { readFile } from "node:fs/promises";

const YEAR = process.argv[2] || "2025";
const VERBOSE = process.argv.includes("--verbose");
const BOMB_FT = Number(process.env.BOMB_FT || 460);
const MONTAGE_AT = Number(process.env.MONTAGE_AT || 2);

const all = JSON.parse(await readFile(`data/seasons/${YEAR}.json`, "utf8")).homeRuns
  .filter(h => h.id && h.distance != null);
const dates = [...new Set(all.map(h => h.date))].sort();

const postsByHomer = new Map();      // playId -> [post descriptions]
const montagesByGame = new Map();    // gamePk|batterId -> count of montages fired
let posts = 0, replies = 0, montages = 0, singles = 0, chains = 0;
const problems = [];

for (const date of dates) {
  const list = all.filter(h => h.date === date).sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));
  const seen = {};
  for (const h of list) { const k = `${h.gamePk}|${h.batterId}`; h.n = (seen[k] = (seen[k] ?? 0) + 1); }

  const posted = new Set();
  const games = {};

  for (const h of list) {
    if (posted.has(h.id)) continue;
    const key = `${h.gamePk}|${h.batterId}`;
    const game = games[key] ?? (games[key] = {});
    const trig = new Set();
    if (h.distance >= BOMB_FT) trig.add("bomb");
    if ((h.gt ?? "R") === "R" && (h.career === 1 || (h.career && h.career % 100 === 0))) trig.add("milestone");

    if (h.n >= MONTAGE_AT && !game.montage) {
      const group = list.filter(x => `${x.gamePk}|${x.batterId}` === key && x.n <= h.n && !posted.has(x.id));
      if (group.length >= 2) {
        game.montage = `T${++posts}`; game.last = game.montage; montages++; chains++;
        montagesByGame.set(key, (montagesByGame.get(key) ?? 0) + 1);
        for (const x of group) {
          posted.add(x.id);
          postsByHomer.set(x.id, [...(postsByHomer.get(x.id) ?? []), `montage ${game.montage}`]);
        }
        if (VERBOSE) console.log(`${date}  MONTAGE  ${h.batter} ×${group.length}`);
        continue;
      }
      trig.add("extra");
    } else if (h.n > MONTAGE_AT && game.montage) trig.add("extra");

    if (!trig.size) continue;
    const tid = `T${++posts}`;
    if (trig.has("extra")) { replies++; game.last = tid; } else { singles++; replies++; }
    posted.add(h.id);
    postsByHomer.set(h.id, [...(postsByHomer.get(h.id) ?? []), `${[...trig].join("+")} ${tid}`]);
    if (VERBOSE) console.log(`${date}  ${[...trig].join("+").padEnd(18)} ${h.batter} ${h.distance}ft`);
  }
}

// ── invariants ──
for (const [id, where] of postsByHomer) if (where.length > 1) problems.push(`homer ${id} posted ${where.length}×: ${where.join(", ")}`);
for (const [k, n] of montagesByGame) if (n > 1) problems.push(`game ${k} fired ${n} montages`);
const noClip = [...postsByHomer.keys()].filter(id => !all.find(h => h.id === id)?.mp4);

console.log(`\n${"═".repeat(58)}\n${YEAR} replay — BOMB_FT=${BOMB_FT}, montage at homer #${MONTAGE_AT}\n${"═".repeat(58)}`);
console.log(`  homers considered      ${all.length}`);
console.log(`  video posts            ${posts}   (${montages} montages, ${singles} single-trigger, ${posts - montages - singles} chain continuations)`);
console.log(`  + link/signpost replies ${replies}`);
console.log(`  TOTAL X writes         ${posts + replies}   ≈ ${((posts + replies) / dates.length).toFixed(1)}/day over ${dates.length} days`);
console.log(`  estimated cost         $${(posts * 0.015 + replies * 0.20).toFixed(2)}`);
console.log(`\n  distinct homers used   ${postsByHomer.size}`);
console.log(`  homers with no clip    ${noClip.length}${noClip.length ? "  ← these would fail at download" : ""}`);
console.log(`\n  ${problems.length ? `\x1b[31m✗ ${problems.length} RULE VIOLATIONS\x1b[0m` : "\x1b[32m✓ no homer posted twice, no game double-montaged\x1b[0m"}`);
for (const p of problems.slice(0, 20)) console.log(`    ${p}`);
