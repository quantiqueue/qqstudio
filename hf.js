// Hugging Face model search + GGUF downloader.
// Optional: set HF_TOKEN env var for gated/private repos.
const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");
const { Readable } = require("stream");

const HF = (process.env.HF_ENDPOINT || "https://huggingface.co").replace(/\/+$/, "");
const TOKEN = process.env.HF_TOKEN || "";
const REPO_RX = /^(?!\.{1,2}\/)[\w.-]+\/(?!\.{1,2}$)[\w.-]+$/; // owner/name, no "." or ".." segments
const jobs = new Map(); // id -> job

function hfHeaders(extra = {}) {
  return { "User-Agent": "llamacpp-harness/0.1", ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}), ...extra };
}

function quantOf(name) {
  const m = name.match(/(?:^|[-_.])((?:UD-)?(?:IQ\d_[A-Z0-9_]+|Q\d(?:_[A-Z0-9]+)*|TQ\d_\d|BF16|F16|FP16|F32|MXFP4(?:_MOE)?))(?=[-_.]|$)/i);
  return m ? m[1].toUpperCase() : "";
}

async function search(q, limit = 30) {
  const url = `${HF}/api/models?search=${encodeURIComponent(q || "")}&filter=gguf&sort=downloads&direction=-1&limit=${limit}&full=false`;
  const r = await fetch(url, { headers: hfHeaders(), signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`Hugging Face search failed: HTTP ${r.status}`);
  return (await r.json()).map((m) => ({
    id: m.id || m.modelId, downloads: m.downloads || 0, likes: m.likes || 0,
    updated: m.lastModified || m.createdAt || null, gated: !!m.gated,
  }));
}

function targetDir(folder, repo) {
  const [vendor, name] = repo.split("/");
  return path.join(folder, vendor, name);
}

// GGUF files in a repo, split files (-00001-of-00003) grouped into one entry.
async function files(repo, folder) {
  if (!REPO_RX.test(repo || "")) throw new Error("Bad repo id");
  const r = await fetch(`${HF}/api/models/${repo}/tree/main?recursive=true`, { headers: hfHeaders(), signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`Could not list files: HTTP ${r.status}${r.status === 401 || r.status === 403 ? " (gated repo: set HF_TOKEN)" : ""}`);
  const all = (await r.json()).filter((f) => f.type === "file" && /\.gguf$/i.test(f.path));
  const groups = new Map();
  for (const f of all) {
    const base = f.path.replace(/-\d{5}-of-\d{5}(\.gguf)$/i, "$1");
    const g = groups.get(base) || { name: path.posix.basename(base), paths: [], size: 0 };
    g.paths.push(f.path);
    g.size += (f.lfs && f.lfs.size) || f.size || 0;
    groups.set(base, g);
  }
  const dir = folder ? targetDir(folder, repo) : null;
  return [...groups.values()]
    .map((g) => {
      g.paths.sort();
      g.parts = g.paths.length;
      g.quant = quantOf(g.name);
      g.mmproj = /mmproj/i.test(g.name);
      g.installed = !!dir && g.paths.every((p) => fs.existsSync(path.join(dir, path.posix.basename(p))));
      return g;
    })
    .sort((a, b) => a.mmproj - b.mmproj || a.size - b.size);
}

function startDownload({ repo, paths, folder, sizes = {} }) {
  if (!REPO_RX.test(repo || "")) throw new Error("Bad repo id");
  if (!folder) throw new Error("Models folder is required");
  if (!Array.isArray(paths) || !paths.length) throw new Error("No files given");
  const dir = targetDir(path.resolve(folder), repo);
  const created = [];
  for (const p of paths) {
    const file = path.posix.basename(p);
    if (!/\.gguf$/i.test(file) || p.includes("..")) throw new Error(`Bad file: ${p}`);
    const dest = path.join(dir, file);
    const existing = [...jobs.values()].find((j) => j.dest === dest && j.status === "downloading");
    if (existing) { created.push(existing.id); continue; }
    const job = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      repo, file, path: p, dest, total: sizes[p] || 0, done: 0, speed: 0,
      status: "downloading", error: null, started: Date.now(), ac: new AbortController(),
    };
    jobs.set(job.id, job);
    created.push(job.id);
    runJob(job);
  }
  return created;
}

async function runJob(job) {
  const part = job.dest + ".part";
  try {
    if (fs.existsSync(job.dest)) { job.status = "done"; job.done = job.total = fs.statSync(job.dest).size; return; }
    fs.mkdirSync(path.dirname(job.dest), { recursive: true });
    let start = 0;
    try { start = fs.statSync(part).size; } catch {}
    const url = `${HF}/${job.repo}/resolve/main/${job.path.split("/").map(encodeURIComponent).join("/")}`;
    const r = await fetch(url, { headers: hfHeaders(start ? { Range: `bytes=${start}-` } : {}), redirect: "follow", signal: job.ac.signal });
    if (r.status === 416 && start) { fs.renameSync(part, job.dest); job.done = job.total = start; job.status = "done"; return; }
    if (!r.ok) throw new Error(`HTTP ${r.status}${r.status === 401 || r.status === 403 ? " (gated repo: accept the license on huggingface.co and set HF_TOKEN)" : ""}`);
    if (start && r.status !== 206) start = 0; // server ignored Range: start over
    job.total = start + Number(r.headers.get("content-length") || 0) || job.total;
    job.done = start;
    let lastT = Date.now(), lastB = start;
    const src = Readable.fromWeb(r.body);
    src.on("data", (c) => {
      job.done += c.length;
      const now = Date.now();
      if (now - lastT >= 1000) { job.speed = ((job.done - lastB) * 1000) / (now - lastT); lastT = now; lastB = job.done; }
    });
    await pipeline(src, fs.createWriteStream(part, { flags: start ? "a" : "w" }));
    fs.renameSync(part, job.dest);
    job.status = "done";
    console.log(`[hf] downloaded ${job.dest}`);
  } catch (e) {
    if (job.ac.signal.aborted) { job.status = "cancelled"; return; } // .part kept so it can resume
    job.status = "error";
    job.error = e.message;
    console.error(`[hf] ${job.file}: ${e.message}`);
  } finally {
    job.speed = 0;
  }
}

function cancel(id) {
  const j = jobs.get(id);
  if (j && j.status === "downloading") j.ac.abort();
}

function clearFinished() {
  for (const [id, j] of jobs) if (j.status !== "downloading") jobs.delete(id);
}

function list() {
  return [...jobs.values()].map(({ ac, ...j }) => j).sort((a, b) => b.started - a.started);
}

module.exports = { search, files, startDownload, cancel, clearFinished, list };
