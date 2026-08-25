// Tweets the longest home run of the day from @nodoubters.
//
//   node scripts/tweet-leader.mjs live    # during games: announce leader at HR #5, then every lead change
//   node scripts/tweet-leader.mjs recap   # next morning: yesterday's final longest
//   DRY_RUN=1 node scripts/tweet-leader.mjs live   # print instead of posting
//
// Needs X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET in the environment.
// State lives in data/tweet-state.json so a run can tell what it already announced.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHmac, randomBytes } from "node:crypto";

const API = "https://statsapi.mlb.com/api";
const SITE = "https://nodoubters.com";
const STATE = "data/tweet-state.json";
const ANNOUNCE_AT = 5;          // first tweet once the day has this many homers
const MIN_CHANGE_FT = 0;        // raise (e.g. 425) to skip small lead changes
const LINKS = process.env.LINKS ?? "all";   // "all" = link every tweet · "recap" = link only the morning recap (cheaper)
const GAME_TYPES = new Set(["R", "F", "D", "L", "W"]);

const mode = process.argv[2] ?? "live";
const DRY = !!process.env.DRY_RUN;

// ---------- MLB ----------
const pacificDate = (d = new Date()) => d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
async function getJSON(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); }

async function homeRunsFor(date) {
  const [teamsRes, sched] = await Promise.all([getJSON(`${API}/v1/teams?sportId=1`), getJSON(`${API}/v1/schedule?sportId=1&date=${date}`)]);
  const teams = Object.fromEntries(teamsRes.teams.map(t => [t.id, t.abbreviation]));
  const seen = new Set();
  const games = (sched.dates?.[0]?.games ?? []).filter(g => GAME_TYPES.has(g.gameType) && g.status.abstractGameState !== "Preview" && !seen.has(g.gamePk) && seen.add(g.gamePk));
  const out = [];
  await Promise.all(games.map(async g => {
    const pbp = await getJSON(`${API}/v1/game/${g.gamePk}/playByPlay`).catch(() => null);
    for (const p of pbp?.allPlays ?? []) {
      if (p.result?.eventType !== "home_run") continue;
      const bip = [...p.playEvents].reverse().find(e => e.hitData) ?? p.playEvents.at(-1);
      const hd = bip?.hitData ?? {};
      const isTop = p.about.halfInning === "top";
      out.push({
        id: bip?.playId, batter: p.matchup.batter.fullName, pitcher: p.matchup.pitcher.fullName,
        team: teams[isTop ? g.teams.away.team.id : g.teams.home.team.id], against: teams[isTop ? g.teams.home.team.id : g.teams.away.team.id],
        distance: hd.totalDistance ?? null, ev: hd.launchSpeed ?? null, time: p.about.endTime ?? p.about.startTime ?? "",
        inning: p.about.inning, half: isTop ? "top" : "bottom", rbi: p.result.rbi,
        gs: p.result.rbi === 4,
        wo: !isTop && p.about.inning >= 9 && g.status.abstractGameState === "Final" && p === (pbp.allPlays ?? []).at(-1),
      });
    }
  }));
  out.sort((a, b) => a.time.localeCompare(b.time));
  const perBatter = {};
  for (const h of out) h.nth = (perBatter[h.batter] = (perBatter[h.batter] ?? 0) + 1);
  return out;
}

// ---------- X (OAuth 1.0a user context, no dependencies) ----------
const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
async function postTweet(text) {
  if (DRY) { console.log(`[dry run] would tweet:\n${text}\n`); return { dry: true }; }
  const { X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET } = process.env;
  if (!X_API_KEY || !X_API_SECRET || !X_ACCESS_TOKEN || !X_ACCESS_SECRET) throw new Error("Missing X_* secrets");
  const url = "https://api.x.com/2/tweets";
  const oauth = {
    oauth_consumer_key: X_API_KEY, oauth_nonce: randomBytes(16).toString("hex"), oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(), oauth_token: X_ACCESS_TOKEN, oauth_version: "1.0",
  };
  const params = Object.keys(oauth).sort().map(k => `${enc(k)}=${enc(oauth[k])}`).join("&");
  const base = `POST&${enc(url)}&${enc(params)}`;
  const key = `${enc(X_API_SECRET)}&${enc(X_ACCESS_SECRET)}`;
  oauth.oauth_signature = createHmac("sha1", key).update(base).digest("base64");
  const header = "OAuth " + Object.keys(oauth).sort().map(k => `${enc(k)}="${enc(oauth[k])}"`).join(", ");
  const r = await fetch(url, { method: "POST", headers: { Authorization: header, "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`X API ${r.status}: ${JSON.stringify(body)}`);
  console.log(`tweeted ${body.data?.id}: ${text.split("\n")[0]}`);
  return body;
}

// ---------- text ----------
const fmtDate = d => new Date(d + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
const link = (date, h) => `${SITE}/#d=${date}&hr=${h.id}`;
// Mirrors the site's badges: distance tier · grand slam / walk-off · multi-homer count
function tags(h) {
  const t = [];
  if (h.distance >= 500) t.push("⭐ 500-foot club");
  else if (h.distance >= 475) t.push("🪐 Into orbit (475+)");
  else if (h.distance >= 450) t.push("🌕 Moonshot (450+)");
  else if (h.distance >= 425) t.push("🔥 425+");
  if (h.wo && h.gs) t.push("Walk-off grand slam!");
  else if (h.wo) t.push("Walk-off!");
  else if (h.gs) t.push("Grand slam");
  const nth = { 2: "⭐ 2nd", 3: "🚀 3rd", 4: "💎 4th", 5: "🏆 5th" }[h.nth];
  if (nth) t.push(`${nth} HR of the day`);
  return t.length ? `\n${t.join(" · ")}` : "";
}
function describe(h) {
  const ev = h.ev ? `, ${h.ev} mph` : "";
  return `${h.batter} (${h.team}) — ${h.distance} ft${ev} off ${h.pitcher}, ${h.half === "top" ? "T" : "B"}${h.inning} vs ${h.against}${tags(h)}`;
}
function tweetText(kind, date, h, count) {
  const withLink = LINKS === "all" || kind === "recap";
  const tail = withLink ? `\n\nWatch: ${link(date, h)}` : `\n\nWatch every homer of the day at nodoubters.com`;
  if (kind === "early")  return `⚾ Early leader for longest HR of the day (${count} so far):\n\n${describe(h)}${tail}`;
  if (kind === "change") return `🚀 New longest HR of the day:\n\n${describe(h)}${tail}`;
  return `🏆 Longest home run of ${fmtDate(date)}:\n\n${describe(h)}\n\n${count} HR on the day. Full board: ${SITE}/#d=${date}`;
}

// ---------- main ----------
async function main() {
  let state = {};
  try { state = JSON.parse(await readFile(STATE, "utf8")); } catch {}

  if (mode === "recap") {
    const y = new Date(); y.setDate(y.getDate() - 1);
    const date = process.env.DATE ?? pacificDate(y);
    if (state.recapDate === date) return console.log(`recap for ${date} already sent`);
    const hrs = (await homeRunsFor(date)).filter(h => h.distance != null);
    if (!hrs.length) return console.log(`no homers on ${date}, no recap`);
    const best = hrs.reduce((a, b) => (b.distance > a.distance ? b : a));
    await postTweet(tweetText("recap", date, best, hrs.length));
    state.recapDate = date;
  } else {
    const date = process.env.DATE ?? pacificDate();
    if (state.date !== date) state = { ...state, date, announced: false, leaderId: null, leaderFt: null };
    const hrs = (await homeRunsFor(date)).filter(h => h.distance != null);
    console.log(`${date}: ${hrs.length} HR with distance`);
    if (hrs.length < ANNOUNCE_AT) return console.log(`waiting for HR #${ANNOUNCE_AT}`);
    const best = hrs.reduce((a, b) => (b.distance > a.distance ? b : a));
    if (!state.announced) {
      await postTweet(tweetText("early", date, best, hrs.length));
      state.announced = true; state.leaderId = best.id; state.leaderFt = best.distance;
    } else if (best.id !== state.leaderId && best.distance > (state.leaderFt ?? 0) && best.distance >= MIN_CHANGE_FT) {
      await postTweet(tweetText("change", date, best, hrs.length));
      state.leaderId = best.id; state.leaderFt = best.distance;
    } else console.log(`leader unchanged: ${best.batter} ${best.distance} ft`);
  }
  if (!DRY) { await mkdir("data", { recursive: true }); await writeFile(STATE, JSON.stringify(state, null, 2) + "\n"); }
}

main().catch(e => { console.error(e); process.exit(1); });
