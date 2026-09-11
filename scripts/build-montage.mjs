// Builds and posts a two-homer montage, then tells the Worker what tweet id it got.
// Only exists because Cloudflare Workers can't run ffmpeg; everything else lives in the Worker.
//
// Driven by repository_dispatch from the live Worker. Payload:
//   { game, date, text, clips: [url, url], ids: [playId, playId] }
//
// Env: X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_SECRET,
//      WORKER_URL (the live Worker's address), RUN_KEY (matches the Worker's), PAYLOAD (JSON)

import { readFile, writeFile, stat, mkdir } from "node:fs/promises";
import { createHmac, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const MEDIA = "https://upload.x.com/1.1/media/upload.json";
const TWEETS = "https://api.x.com/2/tweets";
const CHUNK = 4 * 1024 * 1024;
const TMP = "/tmp/montage";

const p = JSON.parse(process.env.PAYLOAD || "{}");
if (!p.clips?.length || !p.text) { console.error("payload missing clips or text"); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());

function authHeader(method, url, q = {}) {
  const { X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET } = process.env;
  if (!X_API_KEY || !X_ACCESS_TOKEN) throw new Error("Missing X_* secrets");
  const o = { oauth_consumer_key: X_API_KEY, oauth_nonce: randomBytes(16).toString("hex"), oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(), oauth_token: X_ACCESS_TOKEN, oauth_version: "1.0" };
  const all = { ...o, ...q };
  const base = `${method}&${enc(url)}&${enc(Object.keys(all).sort().map(k => `${enc(k)}=${enc(all[k])}`).join("&"))}`;
  o.oauth_signature = createHmac("sha1", `${enc(X_API_SECRET)}&${enc(X_ACCESS_SECRET)}`).update(base).digest("base64");
  return "OAuth " + Object.keys(o).sort().map(k => `${enc(k)}="${enc(o[k])}"`).join(", ");
}
async function xFetch(method, base, q = {}, init = {}) {
  const url = base + (Object.keys(q).length ? "?" + new URLSearchParams(q) : "");
  const r = await fetch(url, { ...init, method, headers: { ...(init.headers ?? {}), Authorization: authHeader(method, base, q) } });
  const text = await r.text();
  let body = {}; try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!r.ok) throw new Error(`X ${method} → ${r.status}: ${text.slice(0, 250)}`);
  return body;
}

async function download(url, dest) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`clip download ${r.status}`);
  await writeFile(dest, Buffer.from(await r.arrayBuffer()));
  return dest;
}

// Dip to black and crossfade the audio at the seam, so it reads as a produced package
// rather than a hard cut mid-celebration.
async function stitch(files, out) {
  const durs = [];
  for (const f of files) {
    const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]);
    durs.push(parseFloat(stdout.trim()));
  }
  const args = ["-y"];
  for (const f of files) args.push("-i", f);
  const parts = [], labels = [];
  files.forEach((_, i) => {
    const first = i === 0, last = i === files.length - 1;
    const vf = [!first && "fade=t=in:st=0:d=0.4", !last && `fade=t=out:st=${(durs[i] - 0.6).toFixed(2)}:d=0.6`].filter(Boolean).join(",");
    const af = [!first && "afade=t=in:st=0:d=0.4", !last && `afade=t=out:st=${(durs[i] - 0.6).toFixed(2)}:d=0.6`].filter(Boolean).join(",");
    parts.push(`[${i}:v]${vf || "null"}[v${i}]`, `[${i}:a]${af || "anull"}[a${i}]`);
    labels.push(`[v${i}][a${i}]`);
  });
  parts.push(`${labels.join("")}concat=n=${files.length}:v=1:a=1[v][a]`);
  args.push("-filter_complex", parts.join(";"), "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out);
  await run("ffmpeg", args, { maxBuffer: 1 << 26 });
  const { size } = await stat(out);
  console.log(`stitched ${files.length} clips → ${(size / 1048576).toFixed(1)} MB`);
  return out;
}

async function upload(path) {
  const { size } = await stat(path);
  const init = await xFetch("POST", MEDIA, { command: "INIT", media_type: "video/mp4", total_bytes: String(size), media_category: "tweet_video" });
  const id = init.media_id_string ?? init.data?.id;
  if (!id) throw new Error(`INIT gave no media id: ${JSON.stringify(init)}`);
  const buf = await readFile(path);
  for (let i = 0, seg = 0; i < buf.length; i += CHUNK, seg++) {
    const fd = new FormData();
    fd.append("media", new Blob([buf.subarray(i, i + CHUNK)]), "chunk");
    await xFetch("POST", MEDIA, { command: "APPEND", media_id: id, segment_index: String(seg) }, { body: fd });
  }
  const fin = await xFetch("POST", MEDIA, { command: "FINALIZE", media_id: id });
  let info = fin.processing_info ?? fin.data?.processing_info;
  for (let i = 0; info && info.state !== "succeeded" && i < 40; i++) {
    if (info.state === "failed") throw new Error(`transcode failed: ${JSON.stringify(info)}`);
    await sleep(Math.max(1, info.check_after_secs ?? 2) * 1000);
    const st = await xFetch("GET", MEDIA, { command: "STATUS", media_id: id });
    info = st.processing_info ?? st.data?.processing_info;
    if (!info) break;
  }
  return id;
}

const DRY = process.env.DRY_RUN === "1";
console.log(`montage for ${p.game} (${p.date})\n\n${p.text}\n`);

await mkdir(TMP, { recursive: true });
const files = [];
for (const [i, url] of p.clips.entries()) files.push(await download(url, `${TMP}/c${i}.mp4`));
const video = files.length > 1 ? await stitch(files, `${TMP}/out.mp4`) : files[0];

if (DRY) { console.log("[dry run] built the video, posting nothing"); process.exit(0); }

const media = await upload(video);
const body = await xFetch("POST", TWEETS, {}, {
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ text: p.text, media: { media_ids: [String(media)] } }),
});
const tweetId = body.data?.id;
console.log(`posted ${tweetId}`);

// Tell the Worker, so later homers in this game can hang their signpost replies off it.
if (process.env.WORKER_URL && tweetId) {
  const u = `${process.env.WORKER_URL.replace(/\/$/, "")}/montage-done?game=${encodeURIComponent(p.game)}&tweet=${tweetId}&key=${encodeURIComponent(process.env.RUN_KEY ?? "")}`;
  const r = await fetch(u, { method: "POST" });
  console.log(`callback to Worker: ${r.status} ${await r.text()}`);
} else {
  console.log("WORKER_URL not set — the Worker won't know this montage's id, so signpost replies will be skipped");
}
