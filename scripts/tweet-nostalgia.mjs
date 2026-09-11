// "On this day" tweet bot for @NoDoubtersMLB.
//
// Picks a random past season, finds the longest home run hit on today's calendar date in that
// season, uploads the highlight clip to X as native video, then replies to itself with a link
// back to the site. Two posts: the video carries no URL ($0.015), the reply carries the link
// ($0.20). Splitting them also dodges X's throttling of link-bearing posts.
//
//   node scripts/tweet-nostalgia.mjs              # today, Pacific
//   DATE=2019-07-04 node scripts/tweet-nostalgia.mjs
//   DRY_RUN=1 node scripts/tweet-nostalgia.mjs    # pick and print, download nothing, post nothing
//   FORCE_YEAR=2018 node scripts/tweet-nostalgia.mjs
//
// Needs X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET in the environment.
// Reads data/seasons/<year>.json straight from the repo checkout — no MLB API call needed.
// State lives in data/tweet-nostalgia-state.json so the same year never repeats on the same date.

import { readFile, writeFile, mkdir, stat, unlink } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHmac, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const SITE = "https://nodoubters.com";
const STATE = "data/tweet-nostalgia-state.json";
const SEASON_DIR = "data/seasons";
const TMP = "/tmp/nostalgia.mp4";

const MIN_YEAR = Number(process.env.MIN_YEAR || 2016);   // 2015 has no clips at all — don't bother
const OFFSEASON = process.env.OFFSEASON || "vault";      // "vault" · "skip" · "nearest"
const VAULT_MIN_FT = Number(process.env.VAULT_MIN_FT || 450);
const NEAREST_MAX_DAYS = Number(process.env.NEAREST_MAX_DAYS || 10);
const DRY = !!process.env.DRY_RUN;

const pacificDate = (d = new Date()) => d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- season data ----------
const cache = new Map();
async function season(year) {
  if (!cache.has(year)) {
    try { cache.set(year, JSON.parse(await readFile(`${SEASON_DIR}/${year}.json`, "utf8")).homeRuns ?? []); }
    catch { cache.set(year, []); }
  }
  return cache.get(year);
}
async function years() {
  const idx = JSON.parse(await readFile(`${SEASON_DIR}/index.json`, "utf8"));
  const thisYear = new Date().getFullYear();
  return idx.years.filter(y => y >= MIN_YEAR && y < thisYear).sort((a, b) => a - b);
}
const playable = h => h.mp4 && h.distance != null;
const longest = list => list.reduce((a, b) => (b.distance > a.distance ? b : a));

// Longest playable homer hit on <md> ("MM-DD") in <year>, or null.
async function bestOn(year, md) {
  const hits = (await season(year)).filter(h => h.date.slice(5) === md && playable(h));
  return hits.length ? longest(hits) : null;
}

// ---------- choosing ----------
// Pick a random year we haven't used for this calendar date yet. Once every year has had a turn,
// the slate for that date wipes and it starts over.
async function pick(md, state) {
  const all = await years();
  const candidates = [];
  for (const y of all) if (await bestOn(y, md)) candidates.push(y);
  if (!candidates.length) return null;

  if (process.env.FORCE_YEAR) {
    const y = Number(process.env.FORCE_YEAR);
    const h = await bestOn(y, md);
    return h ? { year: y, hr: h, kind: "onthisday" } : null;
  }

  let used = state.used?.[md] ?? [];
  let fresh = candidates.filter(y => !used.includes(y));
  if (!fresh.length) { used = []; fresh = candidates; }
  const year = fresh[Math.floor(Math.random() * fresh.length)];
  return { year, hr: await bestOn(year, md), kind: "onthisday", used: [...used, year] };
}

// Offseason: nothing was hit on this calendar date in any season. Nov 6 – Mar 18 is the dead zone.
async function pickOffseason(md, state) {
  if (OFFSEASON === "skip") return null;

  if (OFFSEASON === "nearest") {
    const [m, d] = md.split("-").map(Number);
    for (let off = 1; off <= NEAREST_MAX_DAYS; off++) {
      for (const dir of [-1, 1]) {
        const t = new Date(Date.UTC(2020, m - 1, d + dir * off));
        const alt = t.toISOString().slice(5, 10);
        const got = await pick(alt, state);
        if (got) return { ...got, md: alt };
      }
    }
    return null;
  }

  // "vault": a random big one from anywhere in the archive, framed honestly as such.
  const pool = [];
  for (const y of await years()) {
    for (const h of await season(y)) if (playable(h) && h.distance >= VAULT_MIN_FT) pool.push(h);
  }
  if (!pool.length) return null;
  const recent = state.recent ?? [];
  const fresh = pool.filter(h => !recent.includes(h.id));
  const hr = (fresh.length ? fresh : pool)[Math.floor(Math.random() * (fresh.length || pool.length))];
  return { year: Number(hr.date.slice(0, 4)), hr, kind: "vault" };
}

// ---------- text ----------
// Team handles and MLB's official hashtags, same lists the live bot uses.
const TEAM_HANDLES = { AZ: "Dbacks", ARI: "Dbacks", ATL: "Braves", BAL: "Orioles", BOS: "RedSox", CHC: "Cubs", CWS: "whitesox", CIN: "Reds", CLE: "CleGuardians",
  COL: "Rockies", DET: "tigers", HOU: "astros", KC: "Royals", LAA: "Angels", LAD: "Dodgers", MIA: "Marlins", MIL: "Brewers", MIN: "Twins",
  NYM: "Mets", NYY: "Yankees", ATH: "Athletics", OAK: "Athletics", PHI: "Phillies", PIT: "Pirates", SD: "Padres", SF: "SFGiants", SEA: "Mariners",
  STL: "Cardinals", TB: "RaysBaseball", TEX: "Rangers", TOR: "BlueJays", WSH: "Nationals" };
const TEAM_TAGS = { AZ: "Dbacks", ARI: "Dbacks", ATH: "Athletics", OAK: "Athletics", ATL: "BravesCountry", BAL: "Birdland", BOS: "DirtyWater", CHC: "Cubs", CWS: "WhiteSox",
  CIN: "ATOBTTR", CLE: "GuardsBall", COL: "Rockies", DET: "DNMW", HOU: "ChaseTheFight", KC: "FountainsUp", LAA: "RepTheHalo", LAD: "Dodgers",
  MIA: "FightinFish", MIL: "ThisIsMyCrew", MIN: "NoPlaceLikeHERE", NYM: "LGM", NYY: "RepBX", PHI: "RingTheBell", PIT: "LetsGoBucs", SD: "ForTheFaithful",
  SEA: "TridentsUp", SF: "SFGiants", STL: "STLCards", TB: "RaysUp", TEX: "AllForTX", TOR: "BlueJays50", WSH: "Natitude" };

const fmtDate = d => new Date(d + "T12:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
const fmtMD = d => new Date(d + "T12:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric" });

function tags(h) {
  const t = [];
  if (h.career === 1) t.push("🎉 1st career HR");
  else if (h.career && h.career % 100 === 0) t.push(`🏅 ${h.career}th career HR`);
  if (h.distance >= 500) t.push("⭐ 500-foot club");
  else if (h.distance >= 475) t.push("🪐 Into orbit (475+)");
  else if (h.distance >= 450) t.push("🌕 Moonshot (450+)");
  else if (h.distance >= 425) t.push("🔥 425+");
  if (h.cat === "No Doubter") t.push("◆ No doubter (30/30 parks)");
  if (h.gt === "W") t.push("🏆 World Series");
  else if (h.gt && h.gt !== "R") t.push("🍂 Postseason");
  if (h.wo && h.gs) t.push("Walk-off grand slam!");
  else if (h.wo) t.push("Walk-off!");
  else if (h.gs) t.push("Grand slam");
  return t.length ? `\n${t.join(" · ")}` : "";
}
function mentions(h) {
  const m = [];
  if (TEAM_HANDLES[h.teamAbbr]) m.push("@" + TEAM_HANDLES[h.teamAbbr]);
  if (TEAM_TAGS[h.teamAbbr]) m.push("#" + TEAM_TAGS[h.teamAbbr]);
  return m.length ? `\n${m.join(" ")}` : "";
}
// ---------- lead sentence ----------
// The post text varies day to day: a different frame, and wording that matches what actually
// happened. Beyond reading better, it keeps X from treating a daily near-identical post as
// repetitive. State remembers the last several frames so they don't cluster.
const pickFrom = (pool, avoid) => {
  const fresh = pool.filter(f => !avoid.includes(f.id));
  const from = fresh.length ? fresh : pool;
  return from[Math.floor(Math.random() * from.length)];
};

// How to describe the swing itself, by how far it went.
function shotWords(h) {
  if (h.distance >= 500) return ["a 500-foot monster", "one into another area code", "a shot that barely came down"];
  if (h.distance >= 475) return ["an absolute moonshot", "a ball that left the planet", "a no-doubt moonshot"];
  if (h.distance >= 450) return ["a monster shot", "a genuine no-doubter", "one into the upper deck"];
  if (h.distance >= 425) return ["a towering shot", "a no-doubter", "one way out"];
  return ["the day's longest", "the biggest swing of the day", "one nobody topped"];
}
const anyOf = a => a[Math.floor(Math.random() * a.length)];

function leadSentence(h, year, kind, avoid) {
  const who = h.batter, md = fmtMD(h.date), ft = h.distance, shot = anyOf(shotWords(h));
  const pool = [];

  if (kind === "vault") {
    pool.push(
      { id: "v1", t: () => `${fmtDate(h.date)}. ${who} hit ${shot}.` },
      { id: "v2", t: () => `From the archive: ${who}, ${ft} feet, ${fmtDate(h.date)}.` },
      { id: "v3", t: () => `${who} hit ${shot} on ${fmtDate(h.date)}. Still holds up.` },
      { id: "v4", t: () => `Pulled from the vault — ${who}, ${ft} feet, ${fmtDate(h.date)}.` },
    );
    return pickFrom(pool, avoid);
  }

  // When something notable happened, lead with that instead of the distance.
  if (h.wo && h.gs) pool.push({ id: "e1", t: () => `On this day in ${year}, ${who} ended it with a walk-off grand slam — and the longest homer of ${md}.` });
  else if (h.wo)    pool.push({ id: "e2", t: () => `On this day in ${year}, ${who} walked it off with ${shot} — the longest home run of ${md}.` });
  else if (h.gs)    pool.push({ id: "e3", t: () => `On this day in ${year}, ${who} cleared the bases with ${shot}, the longest homer of ${md}.` });
  if (h.gt === "W") pool.push({ id: "e4", t: () => `World Series, ${year}. ${who} hit the longest home run of ${md}.` });
  else if (h.gt && h.gt !== "R") pool.push({ id: "e5", t: () => `October ${year}: ${who} hit ${shot}, the longest homer of ${md}.` });
  if (h.career === 1) pool.push({ id: "e6", t: () => `On this day in ${year}, ${who} hit the first home run of his career — and the longest of ${md}.` });
  else if (h.career && h.career % 100 === 0) pool.push({ id: "e7", t: () => `On this day in ${year}, ${who} hit career home run number ${h.career}, the longest of ${md}.` });

  pool.push(
    { id: "d1", t: () => `On this day in ${year}, ${who} hit ${shot} — the longest home run of ${md}.` },
    { id: "d2", t: () => `${md}, ${year}: ${who} hit ${shot}. Nobody went further that day.` },
    { id: "d3", t: () => `${year}. ${who}. ${ft} feet. The longest home run hit on ${md}.` },
    { id: "d4", t: () => `The longest home run of ${md}, ${year} belongs to ${who} — ${ft} feet.` },
    { id: "d5", t: () => `On ${md} in ${year}, nobody hit one further than ${who}. ${ft} feet.` },
    { id: "d6", t: () => `${who}, ${fmtDate(h.date)} — ${shot}, and the longest homer of the day.` },
  );
  return pickFrom(pool, avoid);
}

// The scannable stat line under the lead.
function statLine(h) {
  const bits = [`${h.distance} ft`];
  if (h.ev) bits.push(`${h.ev} mph`);
  bits.push(`off ${h.pitcher}`);
  bits.push(`${h.half === "top" ? "T" : "B"}${h.inning} vs ${h.against}`);
  return bits.join(" · ");
}

// The video post. No URL anywhere in here — that's what keeps it at the $0.015 rate.
function videoText(kind, hr, year, avoid = []) {
  const lead = leadSentence(hr, year, kind, avoid);
  return { id: lead.id, text: `${lead.t()}\n\n${statLine(hr)}${tags(hr)}${mentions(hr)}` };
}

// The link reply. Varied for the same reason the main post is — a bot repeating one line
// verbatim every day is the pattern X downranks. All of these carry the same deep link.
const REPLY_LINES = [
  { id: "r1", t: "Search for any homer since 2016, fully sortable and filterable." },
  { id: "r2", t: "Every home run since 2016 — search any player, pitcher, team or ballpark." },
  { id: "r3", t: "60,000 home runs since 2016, all searchable, all with the clip." },
  { id: "r4", t: "Sort by distance, filter for walk-offs and grand slams, back to 2016." },
  { id: "r5", t: "Search every homer since 2016. Sortable, filterable, all on video." },
];
function replyText(hr, avoid = []) {
  const fresh = REPLY_LINES.filter(r => !avoid.includes(r.id));
  const pool = fresh.length ? fresh : REPLY_LINES;
  const r = pool[Math.floor(Math.random() * pool.length)];
  return { id: r.id, text: `${r.t} ${SITE}/#d=${hr.date}&hr=${hr.id}` };
}

// ---------- X: OAuth 1.0a ----------
const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
function authHeader(method, url, queryParams = {}) {
  const { X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET } = process.env;
  if (!X_API_KEY || !X_API_SECRET || !X_ACCESS_TOKEN || !X_ACCESS_SECRET) throw new Error("Missing X_* secrets");
  const oauth = {
    oauth_consumer_key: X_API_KEY, oauth_nonce: randomBytes(16).toString("hex"), oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(), oauth_token: X_ACCESS_TOKEN, oauth_version: "1.0",
  };
  // Query params must be folded into the signature base; a multipart body must not be.
  const all = { ...oauth, ...queryParams };
  const params = Object.keys(all).sort().map(k => `${enc(k)}=${enc(all[k])}`).join("&");
  const base = `${method}&${enc(url)}&${enc(params)}`;
  const key = `${enc(X_API_SECRET)}&${enc(X_ACCESS_SECRET)}`;
  oauth.oauth_signature = createHmac("sha1", key).update(base).digest("base64");
  return "OAuth " + Object.keys(oauth).sort().map(k => `${enc(k)}="${enc(oauth[k])}"`).join(", ");
}
async function xFetch(method, base, query = {}, init = {}) {
  const url = base + (Object.keys(query).length ? "?" + new URLSearchParams(query) : "");
  const r = await fetch(url, { ...init, method, headers: { ...(init.headers ?? {}), Authorization: authHeader(method, base, query) } });
  const text = await r.text();
  let body = {}; try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!r.ok) throw new Error(`X ${method} ${base} → ${r.status}: ${text.slice(0, 400)}`);
  return body;
}

// Media upload host. The v2 endpoint (api.x.com/2/media/upload) rejects OAuth 1.0a with a 401 —
// that scheme has no scopes, and v2 media requires scoped OAuth 2.0. The legacy v1.1 host still
// accepts OAuth 1.0a and X has announced no sunset date for it. Set MEDIA_API=v2 to try v2 anyway.
const MEDIA = process.env.MEDIA_API === "v2"
  ? "https://api.x.com/2/media/upload"
  : "https://upload.x.com/1.1/media/upload.json";
const CHUNK = 4 * 1024 * 1024;   // X caps a segment around 4.5 MB

async function uploadVideo(path) {
  const { size } = await stat(path);
  const init = await xFetch("POST", MEDIA, { command: "INIT", media_type: "video/mp4", total_bytes: String(size), media_category: "tweet_video" });
  const mediaId = init.data?.id ?? init.media_id_string ?? init.id;
  if (!mediaId) throw new Error(`INIT gave no media id: ${JSON.stringify(init)}`);
  console.log(`  INIT ok — media ${mediaId}, ${(size / 1048576).toFixed(1)} MB in ${Math.ceil(size / CHUNK)} chunk(s)`);

  const buf = await readFile(path);
  for (let i = 0, seg = 0; i < buf.length; i += CHUNK, seg++) {
    const fd = new FormData();
    fd.append("media", new Blob([buf.subarray(i, i + CHUNK)]), "chunk");
    await xFetch("POST", MEDIA, { command: "APPEND", media_id: mediaId, segment_index: String(seg) }, { body: fd });
    console.log(`  APPEND ${seg + 1}/${Math.ceil(buf.length / CHUNK)}`);
  }

  const fin = await xFetch("POST", MEDIA, { command: "FINALIZE", media_id: mediaId });
  let info = fin.data?.processing_info ?? fin.processing_info;
  // X transcodes asynchronously; the media id isn't usable until it says succeeded.
  for (let tries = 0; info && info.state !== "succeeded" && tries < 40; tries++) {
    if (info.state === "failed") throw new Error(`transcode failed: ${JSON.stringify(info)}`);
    await sleep(Math.max(1, info.check_after_secs ?? 2) * 1000);
    const st = await xFetch("GET", MEDIA, { command: "STATUS", media_id: mediaId });
    info = st.data?.processing_info ?? st.processing_info;
    console.log(`  STATUS ${info?.state ?? "unknown"}${info?.progress_percent != null ? ` ${info.progress_percent}%` : ""}`);
    if (!info) break;
  }
  return mediaId;
}

// Confirms the four X_* values actually authenticate, and reports which layer failed.
// GET /2/users/me is a User:Read at $0.010 — only run on demand or after a failure.
async function credentialCheck() {
  const lines = [];
  const { X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET } = process.env;
  const shape = (n, v) => `  ${n}: ${v ? `${v.length} chars, starts "${v.slice(0, 4)}\u2026"` : "MISSING"}`;
  lines.push("Credential shape (values never printed in full):");
  lines.push(shape("X_API_KEY", X_API_KEY), shape("X_API_SECRET", X_API_SECRET));
  lines.push(shape("X_ACCESS_TOKEN", X_ACCESS_TOKEN), shape("X_ACCESS_SECRET", X_ACCESS_SECRET));
  if (X_ACCESS_TOKEN && !X_ACCESS_TOKEN.includes("-")) {
    lines.push("  ! X_ACCESS_TOKEN has no dash. A real access token looks like <userid>-<random>.");
    lines.push("    A value without one is usually a Client ID or Bearer token pasted by mistake.");
  }
  try {
    const me = await xFetch("GET", "https://api.x.com/2/users/me");
    lines.push(`\nGET /2/users/me: OK, authenticated as @${me.data?.username}`);
    lines.push("=> The keys are valid. The media host is refusing them for another reason:");
    lines.push("   check the app has Read and Write permission, and that the access token was");
    lines.push("   generated AFTER that permission was granted.");
  } catch (e) {
    lines.push(`\nGET /2/users/me: FAILED - ${e.message.slice(0, 200)}`);
    lines.push("=> The keys themselves are rejected, so this is not a media problem at all.");
    lines.push("   Regenerate all four at developer.x.com and update the GitHub secrets.");
  }
  return lines.join("\n");
}

async function postTweet(text, { mediaId, replyTo } = {}) {
  const payload = { text };
  if (mediaId) payload.media = { media_ids: [String(mediaId)] };
  if (replyTo) payload.reply = { in_reply_to_tweet_id: String(replyTo) };
  const body = await xFetch("POST", "https://api.x.com/2/tweets", {}, {
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  console.log(`  posted ${body.data?.id}`);
  return body.data?.id;
}

// ---------- clip ----------
async function download(url, dest) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`clip download ${r.status} ${url}`);
  await pipeline(Readable.fromWeb(r.body), createWriteStream(dest));
  const { size } = await stat(dest);
  console.log(`  downloaded ${(size / 1048576).toFixed(1)} MB`);
  return size;
}
// Fallback if X rejects a clip: re-encode to a profile it definitely accepts.
async function normalize(src) {
  const out = "/tmp/nostalgia-fix.mp4";
  try { await run("ffmpeg", ["-version"]); }
  catch { throw new Error("X rejected the clip and ffmpeg isn't installed on this runner, so it can't be re-encoded. Add an 'apt-get install -y ffmpeg' step to the workflow."); }
  await run("ffmpeg", ["-y", "-i", src, "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p",
    "-r", "30", "-vf", "scale=1280:-2", "-b:v", "3500k", "-c:a", "aac", "-b:a", "128k", "-ac", "2",
    "-movflags", "+faststart", out]);
  console.log("  re-encoded to a conservative profile");
  return out;
}

// ---------- main ----------
async function main() {
  if (process.env.CHECK === "1") { console.log(await credentialCheck()); return; }
  const date = process.env.DATE || pacificDate();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`bad date: ${JSON.stringify(date)}`);
  const md = date.slice(5);
  let state = {};
  try { state = JSON.parse(await readFile(STATE, "utf8")); } catch {}

  if (state.lastDate === date && !process.env.DATE?.trim() && !DRY && process.env.FORCE !== "1")
    return console.log(`already posted for ${date} — set FORCE=1 (or pick "force" in the workflow) to post anyway`);
  if (process.env.FORCE === "1") console.log("FORCE is on: the once-a-day guard is bypassed, this will post again");

  let chosen = await pick(md, state);
  if (!chosen) {
    console.log(`nothing hit on ${md} in any season — offseason mode: ${OFFSEASON}`);
    chosen = await pickOffseason(md, state);
  }
  if (!chosen) return console.log("no homer to post today");

  const { hr, year, kind } = chosen;
  const { text, id: leadId } = videoText(kind, hr, year, state.recentLeads ?? []);
  const reply = replyText(hr, state.recentReplies ?? []);
  console.log(`\n${kind === "vault" ? "vault" : "on this day"} → ${year} · ${hr.batter} ${hr.distance} ft\n\n${text}\n\n[reply] ${reply.text}\n`);
  if (DRY) return console.log("[dry run] nothing downloaded, nothing posted");

  await download(hr.mp4, TMP);
  let mediaId;
  try {
    mediaId = await uploadVideo(TMP);
  } catch (e) {
    if (/→ 40[13]:/.test(e.message)) {
      console.log("\n--- running a credential check to pin down the cause ---");
      const diag = await credentialCheck().catch(err => `credential check itself failed: ${err.message}`);
      console.log(diag + "\n");
      throw new Error(`X rejected the credentials on ${MEDIA}.\n` +
        `This is an auth problem, not a video problem — re-encoding would not help.\n` +
        `If MEDIA_API=v2 is set, unset it: v2 media upload does not accept OAuth 1.0a keys.\n` +
        `Otherwise regenerate the four X_* values at developer.x.com and update the GitHub secrets.\n` +
        `Original: ${e.message}`);
    }
    console.log(`  upload failed (${e.message.slice(0, 160)}) — retrying after re-encode`);
    mediaId = await uploadVideo(await normalize(TMP));
  }

  const tweetId = await postTweet(text, { mediaId });
  try {
    await postTweet(reply.text, { replyTo: tweetId });
  } catch (e) {
    console.error(`video posted but the link reply failed: ${e.message}`);
  }

  // Only record the pick once something actually went out.
  state.lastDate = date;
  if (chosen.used) state.used = { ...(state.used ?? {}), [chosen.md ?? md]: chosen.used };
  state.recent = [hr.id, ...(state.recent ?? [])].slice(0, 400);
  state.recentLeads = [leadId, ...(state.recentLeads ?? [])].slice(0, 6);
  state.recentReplies = [reply.id, ...(state.recentReplies ?? [])].slice(0, 3);
  await mkdir("data", { recursive: true });
  await writeFile(STATE, JSON.stringify(state, null, 2) + "\n");
  await unlink(TMP).catch(() => {});
}

main().catch(e => { console.error(e); process.exit(1); });
