// No Doubters tweet bot — Cloudflare Worker edition.
// Runs on a cron trigger every minute during game hours and once in the morning for the recap.
// Same rules as the GitHub version: announce the day's longest-HR leader once 5 homers are in,
// tweet every lead change after that, and post a recap of yesterday's longest each morning.
//
// Bindings this Worker expects (Settings → Variables / Bindings):
//   KV namespace  STATE
//   Secrets       X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET
//   Optional vars DRY_RUN ("1" = log instead of posting), LINKS ("all" or "recap"), ANNOUNCE_AT, MIN_CHANGE_FT

const API = "https://statsapi.mlb.com/api";
const SITE = "https://nodoubters.com";
const GAME_TYPES = new Set(["R", "F", "D", "L", "W"]);
const FIELDS = "fields=allPlays,result,eventType,rbi,about,inning,halfInning,endTime,startTime,matchup,batter,pitcher,fullName,id,playEvents,hitData,totalDistance,launchSpeed,playId";

export default {
  // Cron entry point. Which cron fired tells us live vs recap.
  async scheduled(event, env, ctx) {
    const mode = event.cron === env.RECAP_CRON || /^30 15 /.test(event.cron) ? "recap" : "live";
    ctx.waitUntil(run(mode, env).catch(e => console.error(e)));
  },
  // Visiting the Worker URL shows status; /run?mode=live|recap&key=… triggers a run by hand.
  async fetch(request, env) {
    const text = (body, status = 200) => new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
    try {
      const problems = checkSetup(env);
      const url = new URL(request.url);
      if (url.pathname === "/run") {
        if (problems.length) return text(`Can't run yet:\n- ${problems.join("\n- ")}`, 500);
        if (env.RUN_KEY && url.searchParams.get("key") !== env.RUN_KEY) return text("forbidden — add ?key=YOUR_RUN_KEY", 403);
        const out = await run(url.searchParams.get("mode") ?? "live", env, true);
        return text(out.join("\n"));
      }
      const state = problems.length ? null : await env.STATE.get("state", "json");
      return text(`No Doubters tweet bot\n\nSetup: ${problems.length ? "PROBLEMS\n- " + problems.join("\n- ") : "ok"}\nDry run: ${env.DRY_RUN === "1" ? "on" : "off"}\n\nState: ${JSON.stringify(state ?? {}, null, 2)}`);
    } catch (e) {
      return text(`Error: ${e.message}\n\n${e.stack ?? ""}`, 500);
    }
  },
};

function checkSetup(env) {
  const p = [];
  if (!env.STATE || typeof env.STATE.get !== "function") p.push("KV binding missing — Settings → Bindings → add KV namespace with variable name STATE, then Deploy");
  for (const k of ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET"]) if (!env[k]) p.push(`secret ${k} is not set — Settings → Variables and Secrets`);
  return p;
}

async function run(mode, env, verbose = false) {
  const problems = checkSetup(env);
  if (problems.length) throw new Error(problems.join("; "));
  const log = []; const say = m => { log.push(m); console.log(m); };
  const DRY = env.DRY_RUN === "1";
  const ANNOUNCE_AT = Number(env.ANNOUNCE_AT ?? 5);
  const MIN_CHANGE_FT = Number(env.MIN_CHANGE_FT ?? 0);
  const LINKS = env.LINKS ?? "all";
  let state = (await env.STATE.get("state", "json")) ?? {};
  const before = JSON.stringify(state);

  if (mode === "recap") {
    const y = new Date(Date.now() - 864e5); const date = pacificDate(y);
    if (state.recapDate === date) { say(`recap for ${date} already sent`); return log; }
    const hrs = (await homeRunsFor(date)).filter(h => h.distance != null);
    if (!hrs.length) { say(`no homers on ${date}`); return log; }
    const best = hrs.reduce((a, b) => (b.distance > a.distance ? b : a));
    await postTweet(tweetText("recap", date, best, hrs.length, LINKS), env, DRY, say);
    state.recapDate = date;
  } else {
    const date = pacificDate();
    if (state.date !== date) state = { ...state, date, announced: false, leaderId: null, leaderFt: null };
    const hrs = (await homeRunsFor(date)).filter(h => h.distance != null);
    say(`${date}: ${hrs.length} HR with distance`);
    if (hrs.length >= ANNOUNCE_AT) {
      const best = hrs.reduce((a, b) => (b.distance > a.distance ? b : a));
      if (!state.announced) {
        await postTweet(tweetText("early", date, best, hrs.length, LINKS), env, DRY, say);
        state.announced = true; state.leaderId = best.id; state.leaderFt = best.distance;
      } else if (best.id !== state.leaderId && best.distance > (state.leaderFt ?? 0) && best.distance >= MIN_CHANGE_FT) {
        await postTweet(tweetText("change", date, best, hrs.length, LINKS), env, DRY, say);
        state.leaderId = best.id; state.leaderFt = best.distance;
      } else say(`leader unchanged: ${best.batter} ${best.distance} ft`);
    } else say(`waiting for HR #${ANNOUNCE_AT}`);
  }
  if (!DRY && JSON.stringify(state) !== before) await env.STATE.put("state", JSON.stringify(state));
  return log;
}

// ---------- MLB ----------
const pacificDate = (d = new Date()) => d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
async function getJSON(url) { const r = await fetch(url, { cf: { cacheTtl: 0 } }); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); }

async function homeRunsFor(date) {
  const [teamsRes, sched] = await Promise.all([
    getJSON(`${API}/v1/teams?sportId=1&fields=teams,id,abbreviation`),
    getJSON(`${API}/v1/schedule?sportId=1&date=${date}&fields=dates,games,gamePk,gameType,status,abstractGameState,teams,away,home,team,id`),
  ]);
  const teams = Object.fromEntries(teamsRes.teams.map(t => [t.id, t.abbreviation]));
  const seen = new Set();
  const games = (sched.dates?.[0]?.games ?? []).filter(g => GAME_TYPES.has(g.gameType) && g.status.abstractGameState !== "Preview" && !seen.has(g.gamePk) && seen.add(g.gamePk));
  const out = [];
  await Promise.all(games.map(async g => {
    const pbp = await getJSON(`${API}/v1/game/${g.gamePk}/playByPlay?${FIELDS}`).catch(() => null);
    const plays = pbp?.allPlays ?? [];
    for (const p of plays) {
      if (p.result?.eventType !== "home_run") continue;
      const bip = [...(p.playEvents ?? [])].reverse().find(e => e.hitData) ?? p.playEvents?.at(-1);
      const hd = bip?.hitData ?? {};
      const isTop = p.about.halfInning === "top";
      out.push({
        id: bip?.playId, batter: p.matchup.batter.fullName, pitcher: p.matchup.pitcher.fullName,
        team: teams[isTop ? g.teams.away.team.id : g.teams.home.team.id], against: teams[isTop ? g.teams.home.team.id : g.teams.away.team.id],
        distance: hd.totalDistance ?? null, ev: hd.launchSpeed ?? null, time: p.about.endTime ?? p.about.startTime ?? "",
        inning: p.about.inning, half: isTop ? "top" : "bottom", rbi: p.result.rbi, gt: g.gameType,
        gs: p.result.rbi === 4,
        wo: !isTop && p.about.inning >= 9 && g.status.abstractGameState === "Final" && p === plays.at(-1),
      });
    }
  }));
  out.sort((a, b) => a.time.localeCompare(b.time));
  const perBatter = {};
  for (const h of out) h.nth = (perBatter[h.batter] = (perBatter[h.batter] ?? 0) + 1);
  return out;
}

// ---------- text (mirrors the site's badges) ----------
const fmtDate = d => new Date(d + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
const link = (date, h) => `${SITE}/#d=${date}&hr=${h.id}`;
function tags(h) {
  const t = [];
  if (h.distance >= 500) t.push("⭐ 500-foot club");
  else if (h.distance >= 475) t.push("🪐 Into orbit (475+)");
  else if (h.distance >= 450) t.push("🌕 Moonshot (450+)");
  else if (h.distance >= 425) t.push("🔥 425+");
  if (h.gt === "W") t.push("🏆 World Series");
  else if (h.gt && h.gt !== "R") t.push("🍂 Postseason");
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
function tweetText(kind, date, h, count, LINKS) {
  const withLink = LINKS === "all" || kind === "recap";
  const tail = withLink ? `\n\nWatch: ${link(date, h)}` : `\n\nWatch every homer of the day at nodoubters.com`;
  if (kind === "early")  return `⚾ Early leader for longest HR of the day (${count} so far):\n\n${describe(h)}${tail}`;
  if (kind === "change") return `🚀 New longest HR of the day:\n\n${describe(h)}${tail}`;
  return `🏆 Longest home run of ${fmtDate(date)}:\n\n${describe(h)}\n\n${count} HR on the day. Full board: ${SITE}/#d=${date}`;
}

// ---------- X (OAuth 1.0a via WebCrypto, no dependencies) ----------
const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
async function postTweet(text, env, DRY, say) {
  if (DRY) { say(`[dry run] would tweet:\n${text}`); return; }
  const { X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET } = env;
  if (!X_API_KEY || !X_API_SECRET || !X_ACCESS_TOKEN || !X_ACCESS_SECRET) throw new Error("Missing X_* secrets");
  const url = "https://api.x.com/2/tweets";
  const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join("");
  const oauth = { oauth_consumer_key: X_API_KEY, oauth_nonce: nonce, oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(), oauth_token: X_ACCESS_TOKEN, oauth_version: "1.0" };
  const params = Object.keys(oauth).sort().map(k => `${enc(k)}=${enc(oauth[k])}`).join("&");
  const base = `POST&${enc(url)}&${enc(params)}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(`${enc(X_API_SECRET)}&${enc(X_ACCESS_SECRET)}`), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(base));
  oauth.oauth_signature = btoa(String.fromCharCode(...new Uint8Array(sig)));
  const header = "OAuth " + Object.keys(oauth).sort().map(k => `${enc(k)}="${enc(oauth[k])}"`).join(", ");
  const r = await fetch(url, { method: "POST", headers: { Authorization: header, "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`X API ${r.status}: ${JSON.stringify(body)}`);
  say(`tweeted ${body.data?.id}: ${text.split("\n")[0]}`);
}
