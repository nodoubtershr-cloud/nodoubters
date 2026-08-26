// Builds real HTML pages from data/seasons/*.json so search engines can index the content:
//   days/YYYY-MM-DD/index.html   every game day
//   players/<slug>/index.html    every player with a homer
//   teams/<abbr>/index.html      every team
//   season/index.html            the leaderboard
//   sitemap.xml                  all of the above
// and refreshes the prerendered text block on the homepage (between the prerender markers).
//
//   node scripts/build-pages.mjs
// Runs after update-season.mjs in the daily GitHub Action.

import { readFile, writeFile, mkdir } from "node:fs/promises";

const SITE = "https://nodoubters.com";
const NAVY = "#0f1b2b", CHALK = "#f2efe6", DIM = "#b9b6ad", AMBER = "#f5b342", LINE = "rgba(242,239,230,.12)";

const FIRST_SEASON = 2016;
const YEARS = JSON.parse(await readFile("data/seasons/index.json", "utf8")).years.filter(y => y >= FIRST_SEASON);   // newest first
const data = JSON.parse(await readFile(`data/seasons/${YEARS[0]}.json`, "utf8"));
const HR = data.homeRuns.filter(h => h.date);
const SEASON = data.season;

// ---------- helpers ----------
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const slug = s => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const playerSlug = h => `${slug(h.batter)}-${h.batterId}`;
const longDate = d => new Date(d + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
const shortDate = d => new Date(d + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
const byDist = (a, b) => (b.distance ?? -1) - (a.distance ?? -1);
const watch = h => `/#d=${h.date}&hr=${h.id}`;
const ft = h => h.distance != null ? `${h.distance} ft` : "—";
const ord = n => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][Math.min(n % 10, 4)] ?? "th");
const msColor = n => n === 1 ? "#f2efe6" : n === 100 ? "#3c8a4a" : n === 200 ? "#22b8cf" : n === 300 ? "#3b82c4" : n === 400 ? "#8b5cf6" : n === 500 ? "#f5b342" : "#ff3d8e";
const msFg = n => [1, 200, 500].includes(n) ? "#0f1b2b" : "#f2efe6";
const evTags = h => (h.ms ? `<span class="ev ms" style="background:${msColor(h.ms)};color:${msFg(h.ms)}">${ord(h.ms).toUpperCase()} CAREER</span>` : "") + (h.gs ? '<span class="ev gs">GRAND SLAM</span>' : "") + (h.wo ? '<span class="ev wo">WALK-OFF</span>' : "") + (h.gt === "W" ? '<span class="ev ws">WS</span>' : h.gt && h.gt !== "R" ? '<span class="ev ps">PS</span>' : "");
const write = async (path, html) => { await mkdir(path.replace(/\/[^/]*$/, ""), { recursive: true }); await writeFile(path, html); };

function layout({ title, description, path, h1, intro, body, jsonld }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${SITE}${path}">
<meta property="og:type" content="website"><meta property="og:site_name" content="No Doubters">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${SITE}${path}"><meta property="og:image" content="${SITE}/og-image.png">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:site" content="@NoDoubtersMLB">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>` : ""}
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800&family=IBM+Plex+Sans:wght@400;500&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root{--night:${NAVY};--chalk:${CHALK};--dim:${DIM};--amber:${AMBER};--line:${LINE};--grass:#3c8a4a}
  *{box-sizing:border-box} body{margin:0;background:var(--night);color:var(--chalk);font-family:"IBM Plex Sans",system-ui,sans-serif;line-height:1.5}
  a{color:var(--chalk)} a:hover{color:var(--amber)}
  header{padding:18px 24px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:14px;flex-wrap:wrap}
  header .brand{display:flex;align-items:center;gap:10px;text-decoration:none;font-family:"Barlow Condensed",sans-serif;font-weight:800;font-size:30px;letter-spacing:.02em;text-transform:uppercase}
  header .brand span{color:var(--amber)} header nav{margin-left:auto;font-family:"IBM Plex Mono",monospace;font-size:13px;display:flex;gap:16px}
  main{padding:24px;max-width:960px} h1{font-family:"Barlow Condensed",sans-serif;font-size:40px;font-weight:800;line-height:1.05;margin:0 0 10px;letter-spacing:.01em}
  .intro{color:var(--dim);margin:0 0 22px;max-width:70ch} .intro b{color:var(--chalk);font-weight:500}
  h2{font-family:"Barlow Condensed",sans-serif;font-size:22px;text-transform:uppercase;letter-spacing:.05em;margin:28px 0 10px}
  table{border-collapse:collapse;width:100%;font-size:14px} th{font-family:"IBM Plex Mono",monospace;font-size:11px;font-weight:500;color:var(--dim);text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);text-transform:uppercase;letter-spacing:.06em}
  td{padding:9px 8px;border-bottom:1px solid var(--line);vertical-align:middle} td.n{font-family:"IBM Plex Mono",monospace;color:var(--dim);width:38px} td.d{font-family:"IBM Plex Mono",monospace;font-weight:500;white-space:nowrap}
  td.w a{font-family:"IBM Plex Mono",monospace;font-size:12px;color:var(--amber);text-decoration:none;border:1px solid var(--amber);border-radius:999px;padding:3px 10px;white-space:nowrap} td.w a:hover{background:var(--amber);color:var(--night)}
  .bar{display:inline-block;height:8px;background:var(--grass);border-radius:0 2px 2px 0;vertical-align:middle;margin-right:8px}
  .meta{color:var(--dim);font-size:12px;font-family:"IBM Plex Mono",monospace}
  .ev{display:inline-block;font-family:"Barlow Condensed",sans-serif;font-weight:800;font-size:11px;letter-spacing:1px;color:var(--chalk);border-radius:4px;padding:1px 6px;margin-left:6px;vertical-align:middle} .ev.gs{background:#3c8a4a} .ev.wo{background:#e5533d} .ev.ps{border:1px solid var(--amber);color:var(--amber)} .ev.ws{background:var(--amber);color:var(--night)} .ev.ms{background:var(--chalk);color:var(--night)}
  .chips a{display:inline-block;font-family:"IBM Plex Mono",monospace;font-size:12px;border:1px solid var(--line);border-radius:999px;padding:4px 10px;margin:0 6px 6px 0;text-decoration:none}
  .pn{display:flex;justify-content:space-between;font-family:"IBM Plex Mono",monospace;font-size:13px;margin:18px 0}
  footer{padding:24px;border-top:1px solid var(--line);color:var(--dim);font-family:"IBM Plex Mono",monospace;font-size:12px;line-height:1.7} footer a{color:var(--dim)}
  @media(max-width:640px){h1{font-size:30px} td.hide,th.hide{display:none} .bar{display:none}}
</style>
</head>
<body>
<header>
  <a class="brand" href="/"><img src="/logo-mark.svg" alt="" width="36" height="37">No <span>Doubters</span></a>
  <nav><a href="/">Today</a><a href="/season/">Season</a><a href="/players/">Players</a><a href="/teams/">Teams</a></nav>
</header>
<main>
<h1>${h1}</h1>
<p class="intro">${intro}</p>
${body}
</main>
<footer>Independent fan project, not affiliated with Major League Baseball. Video, data, and player images are MLB property. Distances are Statcast projected distances via the MLB Stats API.<br><a href="/">nodoubters.com</a> · <a href="https://x.com/NoDoubtersMLB">@NoDoubtersMLB</a> · <a href="https://buymeacoffee.com/nodoubters">buy me a coffee ☕</a></footer>
</body>
</html>`;
}

function rowsTable(rows, { rank = true, showDate = false, showPlayer = true, showTeam = true } = {}) {
  const maxFt = 500;
  return `<table>
<thead><tr>${rank ? "<th></th>" : ""}${showPlayer ? "<th>Player</th>" : ""}${showTeam ? '<th class="hide">Team</th>' : ""}<th>Distance</th><th class="hide">Exit velo</th>${showDate ? "<th>Date</th>" : '<th class="hide">Inning</th>'}<th></th></tr></thead>
<tbody>${rows.map((h, i) => `<tr>${rank ? `<td class="n">${i + 1}</td>` : ""}${showPlayer ? `<td><a href="/players/${playerSlug(h)}/">${esc(h.batter)}</a></td>` : ""}${showTeam ? `<td class="hide"><a href="/teams/${h.teamAbbr.toLowerCase()}/">${h.teamAbbr}</a> vs ${h.against}</td>` : ""}<td class="d"><span class="bar" style="width:${h.distance ? Math.max(4, (h.distance - 300) / (maxFt - 300) * 120) : 0}px"></span>${ft(h)}</td><td class="hide meta">${h.ev ? `${h.ev} mph · ${h.la}°` : ""}</td>${showDate ? `<td class="meta"><a href="/days/${h.date}/">${shortDate(h.date)}</a>${evTags(h)}</td>` : `<td class="hide meta">${h.half === "top" ? "T" : "B"}${h.inning} · ${h.rbi}-run · off ${esc(h.pitcher)}${evTags(h)}</td>`}<td class="w">${h.mp4 ? `<a href="${watch(h)}">Watch ▶</a>` : `<a href="https://www.mlb.com/gameday/${h.gamePk}/final/video" rel="noopener">MLB.com ↗</a>`}</td></tr>`).join("")}</tbody></table>`;
}
const itemList = (name, rows, url) => ({ "@context": "https://schema.org", "@type": "ItemList", name, url: SITE + url, numberOfItems: rows.length,
  itemListElement: rows.slice(0, 25).map((h, i) => ({ "@type": "ListItem", position: i + 1, name: `${h.batter} — ${ft(h)}`, url: SITE + watch(h) })) });

// ---------- group ----------
const days = {}; const players = {}; const teams = {};
for (const h of HR) { (days[h.date] ||= []).push(h); (players[h.batterId] ||= []).push(h); (teams[h.teamAbbr] ||= []).push(h); }
const dates = Object.keys(days).sort();
const urls = [];

// ---------- day pages ----------
for (const [i, d] of dates.entries()) {
  const rows = [...days[d]].sort(byDist); const best = rows[0]; const games = new Set(rows.map(h => h.gamePk)).size;
  const path = `/days/${d}/`;
  const body = rowsTable(rows) + `<div class="pn">${i > 0 ? `<a href="/days/${dates[i - 1]}/">← ${shortDate(dates[i - 1])}</a>` : "<span></span>"}${i < dates.length - 1 ? `<a href="/days/${dates[i + 1]}/">${shortDate(dates[i + 1])} →</a>` : "<span></span>"}</div>`;
  await write(`days/${d}/index.html`, layout({
    title: `Longest MLB Home Runs on ${longDate(d)} | No Doubters`,
    description: `${rows.length} home runs were hit on ${longDate(d)}. The longest: ${best.batter} (${best.teamAbbr}), ${ft(best)}. Every homer ranked by Statcast distance with the highlight video.`,
    path, h1: `Longest MLB home runs — ${longDate(d)}`,
    intro: `<b>${rows.length} home runs</b> across ${games} games. The longest was <b>${esc(best.batter)}</b> (${best.teamAbbr}), <b>${ft(best)}</b>${best.ev ? ` at ${best.ev} mph` : ""} off ${esc(best.pitcher)}. Every homer of the day is ranked below by Statcast distance; open the <a href="/#d=${d}">interactive board</a> to sort by time, team, or player and play each clip inline.`,
    body, jsonld: itemList(`Longest MLB home runs — ${longDate(d)}`, rows, path) }));
  urls.push({ loc: path, lastmod: d, changefreq: i === dates.length - 1 ? "hourly" : "monthly", priority: i === dates.length - 1 ? "0.9" : "0.5" });
}

// ---------- season page ----------
{
  const rows = [...HR].sort(byDist); const top = rows.slice(0, 100); const best = rows[0];
  const counts = Object.values(players).map(l => ({ h: l[0], n: l.length })).sort((a, b) => b.n - a.n).slice(0, 15);
  const body = `<h2>Longest 100 home runs of ${SEASON}</h2>` + rowsTable(top, { showDate: true }) +
    `<h2>Home run leaders</h2><table><thead><tr><th></th><th>Player</th><th>HR</th><th>Longest</th></tr></thead><tbody>${counts.map((c, i) => { const lg = [...players[c.h.batterId]].sort(byDist)[0]; return `<tr><td class="n">${i + 1}</td><td><a href="/players/${playerSlug(c.h)}/">${esc(c.h.batter)}</a></td><td class="d">${c.n}</td><td class="d">${ft(lg)}</td></tr>`; }).join("")}</tbody></table>`;
  const yearLinks = `<p class="chips">${YEARS.map(y => y === SEASON ? `<a href="/season/" style="border-color:var(--amber);color:var(--amber)">${y}</a>` : `<a href="/season/${y}/">${y}</a>`).join("")}</p>`;
  await write("season/index.html", layout({
    title: `Longest MLB Home Runs of the ${SEASON} Season — Ranked by Distance | No Doubters`,
    description: `The ${SEASON} MLB season's longest home runs, ranked by Statcast distance. #1: ${best.batter} (${best.teamAbbr}), ${ft(best)} on ${shortDate(best.date)}. ${HR.length} homers tracked, each with the highlight.`,
    path: "/season/", h1: `Longest MLB home runs of ${SEASON}`,
    intro: `<b>${HR.length} home runs</b> tracked this season. The longest so far is <b>${esc(best.batter)}</b> (${best.teamAbbr}), <b>${ft(best)}</b> on ${longDate(best.date)}. Updated every morning. The <a href="/#season">interactive leaderboard</a> has every homer, sortable, with the clip.`,
    body: yearLinks + body, jsonld: itemList(`Longest MLB home runs of ${SEASON}`, top, "/season/") }));
  urls.push({ loc: "/season/", lastmod: dates.at(-1), changefreq: "daily", priority: "0.9" });

  // one page per past season
  for (const y of YEARS.slice(1)) {
    const past = JSON.parse(await readFile(`data/seasons/${y}.json`, "utf8")).homeRuns.filter(h => h.date);
    const prows = [...past].sort(byDist); const ptop = prows.slice(0, 100); const pbest = prows[0];
    const pplayers = {}; for (const h of past) (pplayers[h.batterId] ||= []).push(h);
    const pcounts = Object.values(pplayers).map(l => ({ h: l[0], n: l.length })).sort((a, b) => b.n - a.n).slice(0, 15);
    const links = `<p class="chips">${YEARS.map(z => z === y ? `<a href="/season/${y}/" style="border-color:var(--amber);color:var(--amber)">${z}</a>` : z === SEASON ? `<a href="/season/">${z}</a>` : `<a href="/season/${z}/">${z}</a>`).join("")}</p>`;
    const pbody = links + `<h2>Longest 100 home runs of ${y}</h2>` + rowsTable(ptop, { showDate: true }).replaceAll(`href="/players/`, `href="/#season=${y}&amp;q=`).replace(/href="\/days\/([\d-]+)\/"/g, `href="/#d=$1"`) +
      `<h2>Home run leaders</h2><table><thead><tr><th></th><th>Player</th><th>HR</th><th>Longest</th></tr></thead><tbody>${pcounts.map((c, i) => { const lg = [...pplayers[c.h.batterId]].sort(byDist)[0]; return `<tr><td class="n">${i + 1}</td><td>${esc(c.h.batter)}</td><td class="d">${c.n}</td><td class="d">${ft(lg)}</td></tr>`; }).join("")}</tbody></table>`;
    await write(`season/${y}/index.html`, layout({
      title: `Longest MLB Home Runs of the ${y} Season — Ranked by Distance | No Doubters`,
      description: `The ${y} MLB season's longest home runs, ranked by Statcast distance. #1: ${pbest.batter} (${pbest.teamAbbr}), ${ft(pbest)} on ${shortDate(pbest.date)}. ${past.length} homers, each with the highlight where MLB has one.`,
      path: `/season/${y}/`, h1: `Longest MLB home runs of ${y}`,
      intro: `<b>${past.length} home runs</b> in ${y}. The longest: <b>${esc(pbest.batter)}</b> (${pbest.teamAbbr}), <b>${ft(pbest)}</b> on ${longDate(pbest.date)}. Open the <a href="/#season=${y}">interactive ${y} leaderboard</a> to sort and play each clip.`,
      body: pbody, jsonld: itemList(`Longest MLB home runs of ${y}`, ptop, `/season/${y}/`) }));
    urls.push({ loc: `/season/${y}/`, lastmod: prows.map(r => r.date).sort().at(-1), changefreq: "yearly", priority: "0.6" });
  }
}

// ---------- player pages + index ----------
const playerList = Object.values(players).map(l => ({ h: l[0], n: l.length, longest: [...l].sort(byDist)[0] })).sort((a, b) => a.h.batter.localeCompare(b.h.batter));
for (const { h: p, n, longest } of playerList) {
  const rows = [...players[p.batterId]].sort(byDist); const path = `/players/${playerSlug(p)}/`;
  const teamsFor = [...new Set(rows.map(h => h.teamAbbr))].join("/");
  await write(`players/${playerSlug(p)}/index.html`, layout({
    title: `${p.batter} Home Runs ${SEASON} — Longest ${ft(longest)} | No Doubters`,
    description: `${p.batter} (${teamsFor}) has ${n} home run${n === 1 ? "" : "s"} in ${SEASON}. Longest: ${ft(longest)} on ${shortDate(longest.date)}. Every one ranked by distance with the highlight video.`,
    path, h1: `${esc(p.batter)} — ${SEASON} home runs`,
    intro: `<b>${n} home run${n === 1 ? "" : "s"}</b> this season for <a href="/teams/${p.teamAbbr.toLowerCase()}/">${teamsFor}</a>. Longest: <b>${ft(longest)}</b> on <a href="/days/${longest.date}/">${longDate(longest.date)}</a>${longest.ev ? `, ${longest.ev} mph off the bat` : ""}. Average distance: <b>${Math.round(rows.filter(r => r.distance).reduce((s, r) => s + r.distance, 0) / Math.max(1, rows.filter(r => r.distance).length))} ft</b>.`,
    body: rowsTable(rows, { showDate: true, showPlayer: false }), jsonld: itemList(`${p.batter} home runs ${SEASON}`, rows, path) }));
  urls.push({ loc: path, lastmod: rows.map(r => r.date).sort().at(-1), changefreq: "weekly", priority: "0.6" });
}
await write("players/index.html", layout({
  title: `MLB Home Runs by Player, ${SEASON} | No Doubters`, description: `Every player with a home run in ${SEASON}, with their longest and total, each linking to a page of every homer with video.`,
  path: "/players/", h1: `${SEASON} home runs by player`, intro: `${playerList.length} players have gone deep this season. Each page lists every homer with distance, exit velocity, and the clip.`,
  body: `<table><thead><tr><th>Player</th><th>HR</th><th>Longest</th></tr></thead><tbody>${playerList.map(({ h, n, longest }) => `<tr><td><a href="/players/${playerSlug(h)}/">${esc(h.batter)}</a> <span class="meta">${h.teamAbbr}</span></td><td class="d">${n}</td><td class="d">${ft(longest)}</td></tr>`).join("")}</tbody></table>` }));
urls.push({ loc: "/players/", lastmod: dates.at(-1), changefreq: "daily", priority: "0.5" });

// ---------- team pages + index ----------
const teamList = Object.entries(teams).map(([abbr, l]) => ({ abbr, name: l[0].team, n: l.length, longest: [...l].sort(byDist)[0] })).sort((a, b) => b.n - a.n);
for (const { abbr, name, n, longest } of teamList) {
  const rows = [...teams[abbr]].sort(byDist); const path = `/teams/${abbr.toLowerCase()}/`;
  const leaders = Object.values(rows.reduce((m, h) => ((m[h.batterId] ||= { h, n: 0 }).n++, m), {})).sort((a, b) => b.n - a.n).slice(0, 10);
  await write(`teams/${abbr.toLowerCase()}/index.html`, layout({
    title: `${name} Home Runs ${SEASON} — Longest ${ft(longest)} | No Doubters`,
    description: `The ${name} have ${n} home runs in ${SEASON}. Longest: ${longest.batter}, ${ft(longest)}. Every homer ranked by distance with the highlight video, plus the team's HR leaders.`,
    path, h1: `${esc(name)} — ${SEASON} home runs`,
    intro: `<b>${n} home runs</b> this season. The longest: <b>${esc(longest.batter)}</b>, <b>${ft(longest)}</b> on <a href="/days/${longest.date}/">${longDate(longest.date)}</a>.`,
    body: `<h2>Team leaders</h2><div class="chips">${leaders.map(l => `<a href="/players/${playerSlug(l.h)}/">${esc(l.h.batter)} · ${l.n}</a>`).join("")}</div><h2>Longest ${Math.min(50, rows.length)}</h2>` + rowsTable(rows.slice(0, 50), { showDate: true, showTeam: false }),
    jsonld: itemList(`${name} home runs ${SEASON}`, rows, path) }));
  urls.push({ loc: path, lastmod: rows.map(r => r.date).sort().at(-1), changefreq: "daily", priority: "0.6" });
}
await write("teams/index.html", layout({
  title: `MLB Home Runs by Team, ${SEASON} | No Doubters`, description: `All 30 teams' ${SEASON} home run totals and longest homers, each linking to the full list with video.`,
  path: "/teams/", h1: `${SEASON} home runs by team`, intro: `Ranked by total. Click a team for its longest homers and leaders.`,
  body: `<table><thead><tr><th></th><th>Team</th><th>HR</th><th>Longest</th></tr></thead><tbody>${teamList.map((t, i) => `<tr><td class="n">${i + 1}</td><td><a href="/teams/${t.abbr.toLowerCase()}/">${esc(t.name)}</a></td><td class="d">${t.n}</td><td class="d">${ft(t.longest)} <span class="meta">${esc(t.longest.batter)}</span></td></tr>`).join("")}</tbody></table>` }));
urls.push({ loc: "/teams/", lastmod: dates.at(-1), changefreq: "daily", priority: "0.5" });

// ---------- share pages: one tiny page per homer with preview tags, then a redirect to the board ----------
// Current season plus the all-time lists. Crawlers (iMessage, X, Slack) read the tags; people get redirected.
{
  let allTop = { homeRuns: [], postseason: [] };
  try { allTop = JSON.parse(await readFile("data/all/top.json", "utf8")); } catch {}
  const set = new Map(); for (const h of [...HR, ...allTop.homeRuns, ...(allTop.postseason ?? [])]) if (h.id) set.set(h.id, h);
  let n = 0;
  for (const h of set.values()) {
    const bits = [ft(h), h.ev ? `${h.ev} mph` : null, h.wo && h.gs ? "walk-off grand slam" : h.wo ? "walk-off" : h.gs ? "grand slam" : null, h.parks === 30 ? "no doubter (30/30 parks)" : null].filter(Boolean).join(" · ");
    const title = `${h.batter} — ${ft(h)} home run${h.wo ? " walk-off" : ""}`;
    const desc = `${bits} off ${esc(h.pitcher)}, ${longDate(h.date)}${h.venue ? ` at ${esc(h.venue)}` : ""}. Watch the highlight on No Doubters.`;
    const target = `/#d=${h.date}&hr=${h.id}`;
    await write(`hr/${h.id}/index.html`, `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} | No Doubters</title>
<meta name="description" content="${esc(desc)}"><link rel="canonical" href="${SITE}${target}"><meta name="robots" content="noindex">
<meta property="og:type" content="video.other"><meta property="og:site_name" content="No Doubters"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${SITE}/hr/${h.id}/"><meta property="og:image" content="${h.poster ?? SITE + "/og-image.png"}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:site" content="@NoDoubtersMLB">
<meta http-equiv="refresh" content="0;url=${target}"><script>location.replace(${JSON.stringify(target)})</script>
<style>body{background:#0f1b2b;color:#f2efe6;font-family:system-ui;padding:40px}a{color:#f5b342}</style></head>
<body><p>${esc(title)}. <a href="${target}">Watch on No Doubters →</a></p></body></html>`);
    n++;
  }
  console.log(`share pages: ${n}`);
}

// ---------- sitemap ----------
urls.unshift({ loc: "/", lastmod: dates.at(-1), changefreq: "hourly", priority: "1.0" });
await writeFile("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(u => `  <url><loc>${SITE}${u.loc}</loc><lastmod>${u.lastmod}</lastmod><changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`).join("\n")}\n</urlset>\n`);

// ---------- homepage prerender block ----------
{
  // the latest *finished* day: never today's slate, even if a manual run pulled in-progress homers
  const todayPT = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const latest = dates.filter(d => d < todayPT).at(-1) ?? dates.at(-1); const rows = [...days[latest]].sort(byDist).slice(0, 5); const seasonBest = [...HR].sort(byDist)[0];
  const block = `
<h2 data-date="${latest}">Yesterday's longest home runs — ${longDate(latest)}</h2>
<ol>${rows.map(h => `<li><a href="${watch(h)}">${esc(h.batter)}</a> (${h.teamAbbr}) — ${ft(h)}${h.ev ? `, ${h.ev} mph` : ""}</li>`).join("")}</ol>
<p>${days[latest].length} home runs that day. <a href="/days/${latest}/">Full list for ${shortDate(latest)}</a> · Longest of ${SEASON} so far: <a href="/players/${playerSlug(seasonBest)}/">${esc(seasonBest.batter)}</a>, ${ft(seasonBest)} on <a href="/days/${seasonBest.date}/">${shortDate(seasonBest.date)}</a>. <a href="/season/">Season leaderboard</a></p>
<p>No Doubters tracks every Major League Baseball home run since 2016 with its Statcast distance, exit velocity, and launch angle, and links each one to the official highlight.<br>The board above updates live during games; the season archive, player and pitcher histories, and these pages update every morning.</p>
<p class="browse">Browse: <a href="/season/">season</a> · <a href="/players/">players</a> · <a href="/teams/">teams</a> · recent days: ${dates.slice(-7).reverse().map(d => `<a href="/days/${d}/">${shortDate(d)}</a>`).join(" · ")}</p>`;
  const html = await readFile("index.html", "utf8");
  const out = html.replace(/<!-- prerender:start -->[\s\S]*?<!-- prerender:end -->/, `<!-- prerender:start -->${block}\n<!-- prerender:end -->`);
  if (out !== html) await writeFile("index.html", out);
}
console.log(`built ${dates.length} day pages, ${playerList.length} player pages, ${teamList.length} team pages, season page, sitemap (${urls.length} urls)`);
