// Hugging Face model search + GGUF (and .strata) downloader.
// Optional: set HF_TOKEN env var for gated/private repos.
const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");
const { Readable } = require("stream");

const HF = (process.env.HF_ENDPOINT || "https://huggingface.co").replace(/\/+$/, "");
const TOKEN = process.env.HF_TOKEN || "";
const REPO_RX = /^(?!\.{1,2}\/)[\w.-]+\/(?!\.{1,2}$)[\w.-]+$/; // owner/name, no "." or ".." segments
const jobs = new Map(); // id -> job
// Model files: .gguf, and .gguf_file, which Unsloth uses for its Mainline_Support copies (the same weights in the layout
// mainline llama.cpp reads; the ending keeps tools from listing them beside the root files of the same name). Saved as .gguf.
// And .strata: Strata's own format (Inkling-2-Mini's SQ builds in strata-engine's repos), which only the Strata engine runs.
const GGUF_RX = /\.(?:gguf(?:_file)?|strata)$/i;
const trees = new Map(); // repo -> {at, paths}: the repo's model files, from the last listing (for the names downloads are saved under)

function hfHeaders(extra = {}) {
  return { "User-Agent": "llamacpp-harness/0.1", ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}), ...extra };
}

function quantOf(name) {
  const m = name.match(/(?:^|[-_.])((?:UD-)?(?:SQ-\d+|IQ\d_[A-Z0-9_]+|Q\d(?:_[A-Z0-9]+)*|TQ\d_\d|BF16|F16|FP16|F32|MXFP4(?:_MOE)?))(?=[-_.]|$)/i);
  return m ? m[1].toUpperCase() : "";
}

// The repo's model files (paths), listed fresh.
async function tree(repo) {
  const r = await fetch(`${HF}/api/models/${repo}/tree/main?recursive=true`, { headers: hfHeaders(), signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`Could not list files: HTTP ${r.status}${r.status === 401 || r.status === 403 ? " (gated repo: set HF_TOKEN)" : ""}`);
  const all = (await r.json()).filter((f) => f.type === "file" && GGUF_RX.test(f.path));
  trees.set(repo, { at: Date.now(), paths: all.map((f) => f.path) });
  return all;
}

// The name each file is saved under. Downloads are flat in models\<vendor>\<repo>\ (so the models scan pairs a model with
// the repo's mmproj); .gguf_file becomes .gguf, and a name that another file in the repo has too (Mainline_Support/x.gguf_file
// beside x.gguf) gets its folder before the part number: x-Mainline_Support.gguf, x-Mainline_Support-00001-of-00002.gguf.
// Split parts keep the -0000N-of-0000M.gguf ending llama.cpp finds the other parts by.
function saveNames(paths) {
  const plain = (p) => path.posix.basename(p).replace(/\.gguf_file$/i, ".gguf");
  const seen = new Map();
  for (const p of paths) seen.set(plain(p).toLowerCase(), (seen.get(plain(p).toLowerCase()) || 0) + 1);
  const out = new Map();
  for (const p of paths) {
    let n = plain(p);
    const dir = path.posix.dirname(p);
    if (seen.get(n.toLowerCase()) > 1 && dir !== ".") {
      const tag = dir.replace(/[^\w.-]+/g, "_");
      n = n.replace(/(-\d{5}-of-\d{5})?\.gguf$/i, (m, part) => `-${tag}${part || ""}.gguf`);
    }
    out.set(p, n);
  }
  return out;
}

// GGUF repos, plus the repos of `owners` that `keep` accepts (Strata's own .strata builds, which carry no GGUF tag: only the
// repos Strata's catalog lists), most downloaded first.
async function search(q, limit = 30, owners = [], keep = () => true) {
  const ask = async (extra) => {
    const url = `${HF}/api/models?search=${encodeURIComponent(q || "")}${extra}&sort=downloads&direction=-1&limit=${limit}&full=false`;
    const r = await fetch(url, { headers: hfHeaders(), signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`Hugging Face search failed: HTTP ${r.status}`);
    return r.json();
  };
  const [gguf, ...own] = await Promise.all([ask("&filter=gguf"), ...owners.map((o) => ask(`&author=${encodeURIComponent(o)}`).catch(() => []))]);
  const seen = new Set();
  return [...gguf, ...own.flat().filter((m) => keep(m.id || m.modelId))]
    .map((m) => ({ id: m.id || m.modelId, downloads: m.downloads || 0, likes: m.likes || 0, updated: m.lastModified || m.createdAt || null, gated: !!m.gated }))
    .filter((m) => m.id && !seen.has(m.id) && seen.add(m.id))
    .sort((a, b) => b.downloads - a.downloads);
}

function targetDir(folder, repo) {
  const [vendor, name] = repo.split("/");
  return path.join(folder, vendor, name);
}

// GGUF files in a repo, split files (-00001-of-00003) grouped into one entry.
async function files(repo, folder) {
  if (!REPO_RX.test(repo || "")) throw new Error("Bad repo id");
  const all = await tree(repo);
  const names = saveNames(all.map((f) => f.path));
  const groups = new Map();
  for (const f of all) {
    const base = f.path.replace(/-\d{5}-of-\d{5}(\.gguf(?:_file)?)$/i, "$1");
    const g = groups.get(base) || { name: path.posix.basename(base).replace(/\.gguf_file$/i, ".gguf"), paths: [], size: 0, sizes: {} };
    g.paths.push(f.path);
    g.sizes[repo + "/" + f.path] = (f.lfs && f.lfs.size) || f.size || 0;
    g.size += g.sizes[repo + "/" + f.path];
    groups.set(base, g);
  }
  const dir = folder ? targetDir(folder, repo) : null;
  return [...groups.values()]
    .map((g) => {
      g.paths.sort();
      g.parts = g.paths.length;
      g.quant = quantOf(g.name);
      g.mmproj = /mmproj/i.test(g.name) || /vision\.strata$/i.test(g.name); // Strata's Vision shard is a .strata model's picture reader
      g.saveAs = g.paths.map((p) => names.get(p));
      // The folder it's in, as a tag, unless it's only the quant's own folder (split files: UD-Q4_K_XL/…)
      const folder = path.posix.dirname(g.paths[0]);
      if (folder !== "." && !(g.quant && folder.toLowerCase().includes(g.quant.toLowerCase()))) g.folder = folder;
      if (g.paths.some((p) => /\.gguf_file$/i.test(p))) g.renamed = true;
      g.installed = !!dir && g.saveAs.every((n) => fs.existsSync(path.join(dir, n)));
      return g;
    })
    .sort((a, b) => a.mmproj - b.mmproj || a.size - b.size);
}

async function startDownload({ repo, paths, folder, sizes = {} }) {
  if (!REPO_RX.test(repo || "")) throw new Error("Bad repo id");
  if (!folder) throw new Error("Models folder is required");
  if (!Array.isArray(paths) || !paths.length) throw new Error("No files given");
  for (const p of paths) if (typeof p !== "string" || !GGUF_RX.test(p) || p.includes("..")) throw new Error(`Bad file: ${p}`);
  const dir = targetDir(path.resolve(folder), repo);
  // Saved names depend on the whole repo (same-name files in other folders): the listing the page showed, else a fresh one
  const t = trees.get(repo);
  const names = saveNames(t && Date.now() - t.at < 30 * 60 * 1000 && paths.every((p) => t.paths.includes(p)) ? t.paths : (await tree(repo)).map((f) => f.path));
  const created = [];
  for (const p of paths) {
    const file = names.get(p);
    if (!file) throw new Error(`Not in ${repo}: ${p}`);
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
    if (r.status === 416 && start) { fs.renameSync(part, job.dest); require("./presets").invalidate(); job.done = job.total = start; job.status = "done"; return; }
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
    require("./presets").invalidate(); // the models list shows it now (no watcher off Windows and macOS)
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
