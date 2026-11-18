// Engines are llama.cpp builds: an executable (downloaded from llama.cpp's GitHub releases, or one already on disk).
// What runs is a loadout: one llama-server process for one loadout at a time, started from its engine's executable
// with the loadout's model and flags. Loading another loadout stops the running one first. The process is started
// detached with output going to the loadout's log, so it keeps running when the harness restarts and is picked up
// again from engines\running.json.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { spawn, execFile } = require("child_process");

const P = require("./paths");
const DIR = __dirname;
const FILE = P.engines;            // engines.json: {engines: [...], autostart, last}
const ENGINES_DIR = P.enginesDir;  // engines\<id>\ : downloaded build, help.json
const RUN_FILE = path.join(ENGINES_DIR, "running.json"); // the loadout process running now {loadout, engine, pid, sig}
const LOG_DIR = path.join(P.home, "logs", "loadouts");   // <loadout id>.log
const BASE_PORT = 9931;
const PORT = Number(process.env.LLAMA_PORT) || BASE_PORT; // one process at a time, so one port
const RELEASES_API = process.env.LLAMA_RELEASES_API || "https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=8"; // env: a stand-in for testing

// ---------- settings ----------
let data = load();
let busy = Promise.resolve();
// The loadout process: { loadout, name, engine, pid, sig, state: stopped|running|error, error, startedAt, child }
let cur = { loadout: null, name: null, engine: null, pid: null, sig: null, state: "stopped", error: null, startedAt: null, child: null };

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (Array.isArray(d.engines)) return { autostart: true, last: null, ...d };
  } catch {}
  return migrate();
}
function save(d = data) { fs.mkdirSync(path.dirname(FILE), { recursive: true }); P.writeJson(FILE, d); }

// First run after engines were added: the old single engine (llama-server.json) becomes engine "llama", keeping any
// extra flags it was given (loadouts.js moves them into its loadouts).
function migrate() {
  let old = {};
  try { old = JSON.parse(fs.readFileSync(P.llama, "utf8")); } catch {}
  const exe = old.exe || "llama";
  const toks = [...String(old.args || "").matchAll(/"([^"]*)"|(\S+)/g)].map((m) => (m[1] !== undefined ? m[1] : m[2]));
  const extraArgs = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === "serve" && i === 0) continue;
    if (t === "--jinja") continue;
    if (["--models-preset", "--host", "--port"].includes(t)) { i++; continue; }
    extraArgs.push(t);
  }
  const d = { engines: [{ id: "llama", name: "llama.cpp", type: "llama.cpp", exe, backend: guessBackend(exe), build: "", extraArgs, legacy: true }],
    autostart: old.autostart !== false, last: null };
  try { save(d); } catch {}
  if (old.exe || old.args) console.log(`[engines] moved the engine settings into engines.json${extraArgs.length ? ` (kept flags: ${extraArgs.join(" ")})` : ""}`);
  return d;
}
function guessBackend(exe) {
  const s = String(exe).toLowerCase();
  return /cuda/.test(s) ? "cuda" : /vulkan/.test(s) ? "vulkan" : /rocm|hip/.test(s) ? "rocm" : /sycl/.test(s) ? "sycl" : /cpu/.test(s) ? "cpu" : "";
}

const byId = (id) => data.engines.find((e) => e.id === id) || null;
const engineDir = (e) => path.join(ENGINES_DIR, e.id);
const logFile = (loadoutId) => path.join(LOG_DIR, String(loadoutId).replace(/[^A-Za-z0-9._-]/g, "_") + ".log");
// Engine for new loadouts: the one running now, else the one used last, else the first.
const isLlamaCpp = (e) => e && (e.type || "llama.cpp") === "llama.cpp";
const defaultEngine = () => [byId(cur.engine), byId(data.lastEngine), ...data.engines].find(isLlamaCpp) || null; // Strata loadouts come later

// ---------- process ----------
const subcmd = (exe) => (path.basename(exe).toLowerCase().replace(/\.exe$/, "") === "llama" ? ["serve"] : []); // "llama serve" vs llama-server.exe
const url = () => (process.env.LLAMA_URL ? process.env.LLAMA_URL.replace(/\/+$/, "") : `http://127.0.0.1:${PORT}`);

function alive(p) {
  if (!p) return false;
  try { process.kill(p, 0); return true; } catch (err) { return err.code === "EPERM"; }
}
// Guard against PID reuse: only treat a PID as ours if it is actually a llama process.
function isLlama(p, exe) {
  if (!alive(p)) return Promise.resolve(false);
  if (process.platform !== "win32") return Promise.resolve(true);
  const want = path.basename(exe || "llama").toLowerCase().replace(/\.exe$/, "");
  return new Promise((resolve) =>
    execFile("tasklist", ["/FI", `PID eq ${p}`, "/FO", "CSV", "/NH"], { windowsHide: true }, (err, out) => {
      if (err) return resolve(false);
      const name = (out.match(/^"([^"]+)"/m) || [])[1] || "";
      resolve(/llama/i.test(name) || name.toLowerCase().replace(/\.exe$/, "") === want);
    }));
}
async function health() {
  try {
    const r = await fetch(url() + "/health", { signal: AbortSignal.timeout(1500) });
    return r.ok ? "ready" : r.status === 503 ? "loading" : `http ${r.status}`;
  } catch { return "unreachable"; }
}
async function kill(p) {
  if (process.platform === "win32") await new Promise((r) => execFile("taskkill", ["/PID", String(p), "/T", "/F"], { windowsHide: true }, () => r()));
  else try { process.kill(-p, "SIGTERM"); } catch { try { process.kill(p, "SIGTERM"); } catch {} }
  for (let i = 0; i < 50 && alive(p); i++) await new Promise((r) => setTimeout(r, 200));
}
function writeRun() {
  try {
    if (cur.pid || (cur.strata && cur.state === "running")) fs.writeFileSync(RUN_FILE, JSON.stringify({ loadout: cur.loadout, name: cur.name, engine: cur.engine, pid: cur.pid, strata: !!cur.strata, sig: cur.sig, startedAt: cur.startedAt }));
    else fs.unlinkSync(RUN_FILE);
  } catch {}
}

// A loadout process is up (llama-server's PID, or a Strata launch qqstudio started and hasn't seen fail).
const up = () => !!cur.pid || (!!cur.strata && cur.state === "running");
async function stopNow() {
  if (cur.strata) return stopStrata();
  const p = cur.pid, e = byId(cur.engine);
  if (p && (await isLlama(p, e?.exe))) { await kill(p); console.log(`[loadouts] stopped ${cur.name} (pid ${p})`); }
  cur = { ...cur, pid: null, state: "stopped", error: null, child: null };
  writeRun();
}

// Starts the process for a loadout: spec = { loadout, name, engine, args, sig } (args from loadouts.argsFor).
// Whatever runs now is stopped first.
function launch(spec) {
  return (busy = busy.then(async () => {
    const e = byId(spec.engine);
    if (!e) throw new Error(`The loadout "${spec.name}" has no engine. Pick one in Settings > Loadouts.`);
    if (up() || cur.strata) await stopNow();
    if (e.type === "strata") return launchStrata(e, spec);
    for (let i = 0; i < 25 && (await health()) !== "unreachable"; i++) await new Promise((r) => setTimeout(r, 200)); // the old one letting go of the port
    cur = { loadout: spec.loadout, name: spec.name, engine: e.id, pid: null, sig: spec.sig, state: "stopped", error: null, startedAt: null, child: null };
    if ((await health()) !== "unreachable") {
      cur.state = "error"; cur.error = `Something is already answering on ${url()} (another llama-server?). Stop it first.`;
      return;
    }
    const args = [...subcmd(e.exe), ...spec.args, "--jinja", "--host", "127.0.0.1", "--port", String(PORT), "--alias", spec.loadout];
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const out = fs.openSync(logFile(spec.loadout), "w");
    fs.writeSync(out, `[harness] ${new Date().toISOString()} loading ${spec.name} on ${e.name}: ${e.exe} ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}\n`);
    let child;
    try {
      child = spawn(e.exe, args, { detached: true, windowsHide: true, stdio: ["ignore", out, out], cwd: path.isAbsolute(e.exe) ? path.dirname(e.exe) : DIR });
    } catch (err) { fs.closeSync(out); cur.state = "error"; cur.error = err.message; return; }
    fs.closeSync(out);
    const me = cur;
    me.child = child;
    child.on("error", (err) => {
      if (cur !== me) return;
      me.state = "error"; me.pid = null;
      me.error = err.code === "ENOENT" ? `"${e.exe}" not found. Check the engine in Settings > Engines.` : err.message;
      writeRun();
    });
    child.on("exit", (code) => {
      if (cur !== me || me.child !== child) return;
      me.child = null;
      if (me.pid === child.pid) { me.pid = null; writeRun(); }
      if (me.state === "running") { me.state = code ? "error" : "stopped"; if (code) me.error = `llama-server exited with code ${code} (see the log)`; }
    });
    child.unref();
    if (child.pid) {
      me.pid = child.pid; me.state = "running"; me.startedAt = Date.now();
      data.last = spec.loadout; data.lastEngine = e.id; save();
      writeRun();
      console.log(`[loadouts] loading ${spec.name} on ${e.name} (pid ${me.pid}) -> ${url()}`);
    }
    await new Promise((r) => setTimeout(r, 300)); // let a spawn error surface
  }));
}
function stop() { return (busy = busy.then(stopNow)); }

// The loadout process now: state "loaded" | "loading" | "failed" | "stopped", with the loadout id and engine.
async function status() {
  if (cur.strata) return strataStatus();
  if (cur.pid && !alive(cur.pid)) { cur.pid = null; writeRun(); if (cur.state === "running") { cur.state = "error"; cur.error = cur.error || "llama-server exited (see the log)"; } }
  const h = cur.pid ? await health() : "unreachable";
  const state = cur.pid ? (h === "ready" ? "loaded" : "loading") : cur.state === "error" ? "failed" : "stopped";
  return { state, loadout: cur.loadout, name: cur.name, engine: cur.engine, pid: cur.pid, sig: cur.sig, error: cur.error, startedAt: cur.startedAt, url: url(), health: h };
}
const current = () => ({ loadout: up() ? cur.loadout : null, engine: up() ? cur.engine : null, sig: up() ? cur.sig : null });

async function list() {
  const s = await status();
  const out = data.engines.map((e) => ({ ...e, type: e.type || "llama.cpp", inUse: up() && s.engine === e.id, downloaded: e.type === "strata" || isInside(engineDir(e), e.exe) }));
  return { engines: out, autostart: data.autostart, running: s, jobs: [...jobs.values()].map(({ child, abort, ...j }) => j) };
}

function log(loadoutId, bytes = 64 * 1024) {
  const id = loadoutId || cur.loadout;
  if (!id) return "";
  try {
    const f = logFile(id), size = fs.statSync(f).size, fd = fs.openSync(f, "r"), len = Math.min(size, bytes), buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    return buf.toString("utf8").replace(/\x1b\[[0-9;]*m/g, "");
  } catch { return ""; }
}

// ---------- adding, editing, removing ----------
function newId(name) {
  const base = String(name || "engine").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "engine";
  let id = base, n = 2;
  while (byId(id) || fs.existsSync(path.join(ENGINES_DIR, id))) id = `${base}-${n++}`;
  return id;
}
function add({ name, exe, backend = "", build = "" }) {
  name = String(name || "").trim(); exe = String(exe || "").trim();
  if (!exe) throw Object.assign(new Error("The engine needs an executable (llama-server.exe or llama.exe)"), { status: 400 });
  const e = { id: newId(name || path.basename(path.dirname(exe)) || "engine"), name: name || "llama.cpp", type: "llama.cpp", exe, backend: backend || guessBackend(exe), build, extraArgs: [] };
  data.engines.push(e);
  save();
  return e;
}
function update(id, patch) {
  const e = byId(id);
  if (!e) throw Object.assign(new Error("No such engine"), { status: 404 });
  if (typeof patch.name === "string" && patch.name.trim()) e.name = patch.name.trim().slice(0, 80);
  if (typeof patch.exe === "string" && patch.exe.trim()) e.exe = patch.exe.trim();
  if (Array.isArray(patch.extraArgs)) e.extraArgs = patch.extraArgs.map(String).filter(Boolean);
  save();
  return e;
}
async function remove(id) {
  const e = byId(id);
  if (!e) throw Object.assign(new Error("No such engine"), { status: 404 });
  if (data.engines.length === 1) throw Object.assign(new Error("This is the only engine; add another one first"), { status: 400 });
  if (cur.engine === id && cur.pid) await stop();
  data.engines = data.engines.filter((x) => x.id !== id);
  save();
  if (fs.existsSync(engineDir(e))) await rmRetry(engineDir(e)); // the downloaded build and its --help cache
}
function setOptions(o) {
  if (typeof o.autostart === "boolean") data.autostart = o.autostart;
  save();
}
async function rmRetry(dir) {
  for (let i = 0; ; i++) {
    try { await fs.promises.rm(dir, { recursive: true, force: true }); return; }
    catch (err) { if (i >= 20 || !["EBUSY", "EPERM", "ENOTEMPTY"].includes(err.code)) throw err; await new Promise((r) => setTimeout(r, 200)); }
  }
}
function isInside(dir, p) { const r = path.relative(dir, path.resolve(p)); return !!r && !r.startsWith("..") && !path.isAbsolute(r); }

// ---------- downloads from GitHub releases ----------
// Windows x64 assets look like llama-b12445-bin-win-vulkan-x64.zip; CUDA builds also need the matching
// cudart-llama-bin-win-cuda-12.4-x64.zip in the same folder.
const BACKEND_LABEL = { cpu: "CPU", vulkan: "Vulkan", sycl: "SYCL (Intel)" };
const labelOf = (b) => BACKEND_LABEL[b] || b.replace(/^cuda-/, "CUDA ").replace(/^rocm-/, "ROCm ").replace(/^hip-/, "HIP ").replace(/^openvino-/, "OpenVINO ");
// The release list is cached on disk for an hour (harness restarts don't refetch), only one GitHub request runs at a
// time, and after a rate-limit answer nothing is sent until GitHub's reset time; the last list is shown meanwhile.
// Unauthenticated GitHub allows 60 requests an hour; set GITHUB_TOKEN for 5,000.
const REL_FILE = path.join(ENGINES_DIR, "releases.json"); // {at, value, blockedUntil}
const REL_TTL = 60 * 60 * 1000;
let relCache = null, relRunning = null;
function relLoad() {
  if (!relCache) { try { relCache = JSON.parse(fs.readFileSync(REL_FILE, "utf8")); } catch { relCache = {}; } }
  // A saved list whose download links point anywhere but GitHub is dropped (an earlier build fetched it through a
  // third-party mirror).
  if (relCache.value && !(relCache.value.backends || []).every((b) => trustedUrl(b.asset?.url) && (!b.runtime || trustedUrl(b.runtime.url)))) relCache = {};
  return relCache;
}
// Builds and Strata are only ever downloaded from GitHub itself (its release pages redirect to its own file hosts).
function trustedUrl(u) {
  try { const h = new URL(u).hostname.toLowerCase(); return new URL(u).protocol === "https:" && (h === "github.com" || h.endsWith(".github.com") || h.endsWith(".githubusercontent.com")); }
  catch { return false; }
}
function relSave() { try { fs.mkdirSync(ENGINES_DIR, { recursive: true }); fs.writeFileSync(REL_FILE, JSON.stringify(relCache)); } catch {} }
function releases({ force = false } = {}) {
  const c = relLoad(), now = Date.now();
  if (c.blockedUntil > now) { // rate-limited: don't ask again before the reset
    const when = new Date(c.blockedUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    if (c.value) return Promise.resolve({ ...c.value, stale: true, note: `GitHub rate limit; showing the list from ${new Date(c.at).toLocaleString()} until ${when}` });
    return Promise.reject(new Error(`GitHub rate limit reached; try again after ${when}`));
  }
  if (!force && c.value && now - c.at < REL_TTL) return Promise.resolve(c.value);
  if (!relRunning) relRunning = releasesNow().finally(() => { relRunning = null; });
  return relRunning.catch((err) => { if (c.value) return { ...c.value, stale: true, note: err.message }; throw err; });
}
async function releasesNow() {
  const headers = { "User-Agent": "qqstudio", Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  let r;
  try { r = await fetch(RELEASES_API, { headers, signal: AbortSignal.timeout(15000) }); }
  catch (err) { throw new Error(`${err.message}${err.cause ? ` (${err.cause.code || err.cause.message})` : ""}`); }
  if (r.status === 403 || r.status === 429) {
    const reset = Number(r.headers.get("x-ratelimit-reset")) * 1000, retry = Number(r.headers.get("retry-after")) * 1000;
    relLoad().blockedUntil = reset > Date.now() ? reset : Date.now() + (retry || REL_TTL);
    relSave();
    throw new Error(`GitHub rate limit reached; try again after ${new Date(relCache.blockedUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`);
  }
  if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
  const list = await r.json();
  for (const rel of list) {
    const assets = rel.assets || [], backends = [];
    for (const a of assets) {
      const m = a.name.match(/^llama-(b\d+)-bin-win-(.+)-x64\.zip$/);
      if (!m) continue;
      const backend = m[2];
      const rt = /^cuda-/.test(backend) ? assets.find((x) => x.name === `cudart-llama-bin-win-${backend}-x64.zip`) : null;
      backends.push({ backend, label: labelOf(backend), asset: { name: a.name, size: a.size, url: a.browser_download_url },
        runtime: rt ? { name: rt.name, size: rt.size, url: rt.browser_download_url } : null });
    }
    if (backends.length) {
      const order = (b) => (/^cuda/.test(b) ? 0 : b === "vulkan" ? 1 : b === "cpu" ? 2 : 3);
      backends.sort((a, b) => order(a.backend) - order(b.backend) || a.backend.localeCompare(b.backend));
      relCache = { at: Date.now(), value: { build: rel.tag_name, published: rel.published_at, url: rel.html_url, backends } };
      relSave();
      return relCache.value;
    }
  }
  throw new Error("No Windows x64 builds found in the latest llama.cpp releases");
}

const jobs = new Map(); // job id -> { id, name, build, backend, state, done, total, error, engine }
async function download({ build, backend, name }) {
  const rel = await releases();
  if (build && build !== rel.build) throw Object.assign(new Error(`Only the latest build (${rel.build}) can be downloaded`), { status: 400 });
  const b = rel.backends.find((x) => x.backend === backend);
  if (!b) throw Object.assign(new Error(`No ${backend} build in ${rel.build}`), { status: 400 });
  const label = String(name || "").trim() || `llama.cpp ${b.label} ${rel.build}`;
  const id = newId(label);
  const dir = path.join(ENGINES_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const parts = [b.asset, b.runtime].filter(Boolean);
  const job = { id, name: label, build: rel.build, backend, state: "downloading", done: 0, total: parts.reduce((n, p) => n + p.size, 0), error: null, engine: null };
  jobs.set(id, job);
  (async () => {
    try {
      for (const p of parts) {
        const zip = path.join(dir, p.name);
        await fetchTo(p.url, zip, (n) => (job.done += n), job);
        job.state = "unpacking";
        await unzip(zip, dir);
        await fs.promises.unlink(zip).catch(() => {});
        if (job.cancelled) throw new Error("cancelled");
        job.state = "downloading";
      }
      const exe = findExe(dir);
      if (!exe) throw new Error("llama-server.exe was not found in the download");
      const e = { id, name: label, type: "llama.cpp", exe, backend, build: rel.build, extraArgs: [] };
      data.engines.push(e);
      save();
      job.state = "done"; job.engine = id;
      console.log(`[engines] downloaded ${label} -> ${exe}`);
    } catch (err) {
      job.state = job.cancelled ? "cancelled" : "error"; job.error = job.cancelled ? null : err.message;
      await rmRetry(dir).catch(() => {});
    }
  })();
  return job;
}
function cancel(id) { const j = jobs.get(id); if (j && !["done", "error", "cancelled"].includes(j.state)) { j.cancelled = true; j.abort?.abort(); try { j.child?.kill(); } catch {} } }
function clearJobs() { for (const [k, j] of jobs) if (["done", "error", "cancelled"].includes(j.state)) jobs.delete(k); }

async function fetchTo(u, file, onBytes, job) {
  if (!trustedUrl(u) && !process.env.LLAMA_RELEASES_API && !process.env.STRATA_RELEASES_API) throw new Error(`refusing to download from ${u}: not a GitHub address`);
  job.abort = new AbortController();
  const r = await fetch(u, { headers: { "User-Agent": "qqstudio" }, signal: job.abort.signal });
  if (!r.ok || !r.body) throw new Error(`download failed: HTTP ${r.status}`);
  const out = fs.createWriteStream(file);
  try {
    for await (const chunk of r.body) {
      if (!out.write(chunk)) await new Promise((res) => out.once("drain", res));
      onBytes(chunk.length);
    }
  } finally { await new Promise((res) => out.end(res)); }
}
// ---------- Strata (an engine type: https://github.com/Niko1221/Strata) ----------
// qqstudio downloads Strata's Terminal ("Control": its own Python, the strata CLI and server) from the latest GitHub
// release into engines\<id>\, then lets Strata fetch the GPU engine for this PC from its signed update feed
// (`strata update`). The copy keeps its own state under engines\<id>\state (components, profiles, runtime, tuning,
// settings), so it never touches a Strata app the user installed separately. See qqstudio/STRATA_PLAN.md.
const STRATA_API = process.env.STRATA_RELEASES_API || "https://api.github.com/repos/Niko1221/Strata/releases/latest";
const STRATA_ASSET = process.platform === "win32" ? /^strata-control-([\d.]+)-windows-x86_64\.zip$/ : /^strata-control-([\d.]+)-linux-x86_64\.zip$/;
// Kept on disk like llama.cpp's list (engines\strata-release.json): after one good answer, a GitHub outage or rate
// limit shows the last known release "(cached)" instead of an error.
const STRATA_REL_FILE = path.join(ENGINES_DIR, "strata-release.json");
let strataRel = (() => { try { const c = JSON.parse(fs.readFileSync(STRATA_REL_FILE, "utf8")); return trustedUrl(c.value?.asset?.url) ? c : null; } catch { return null; } })(), strataRelRunning = null; // {at, value}
function strataRelease({ force = false } = {}) {
  if (!force && strataRel && Date.now() - strataRel.at < REL_TTL) return Promise.resolve(strataRel.value);
  if (!strataRelRunning) strataRelRunning = (async () => {
    const headers = { "User-Agent": "qqstudio", Accept: "application/vnd.github+json" };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    let r;
    try { r = await fetch(STRATA_API, { headers, signal: AbortSignal.timeout(15000) }); }
    catch (err) { throw new Error(`${err.message}${err.cause ? ` (${[err.cause.code || err.cause.message, err.cause.syscall, err.cause.hostname].filter(Boolean).join(" ")})` : ""}`); } // "fetch failed" alone says nothing
    if (!r.ok) throw new Error(r.status === 403 || r.status === 429 ? "GitHub rate limit reached; try again later" : `GitHub answered ${r.status}`);
    const rel = await r.json();
    const a = (rel.assets || []).find((x) => STRATA_ASSET.test(x.name));
    if (!a) throw new Error(`The latest Strata release (${rel.tag_name}) has no Terminal package for this system`);
    const value = { release: rel.tag_name, control: a.name.match(STRATA_ASSET)[1], published: rel.published_at, url: rel.html_url,
      asset: { name: a.name, size: a.size, url: a.browser_download_url } };
    strataRel = { at: Date.now(), value };
    try { fs.mkdirSync(ENGINES_DIR, { recursive: true }); fs.writeFileSync(STRATA_REL_FILE, JSON.stringify(strataRel)); } catch {}
    return value;
  })().finally(() => { strataRelRunning = null; });
  return strataRelRunning.catch((err) => { if (strataRel) return { ...strataRel.value, stale: true, note: err.message }; throw err; });
}
const strataState = (e) => path.join(engineDir(e), "state");
const strataPython = (root) => (process.platform === "win32" ? path.join(root, "python", "python.exe") : path.join(root, "python", "bin", "python3"));
// The environment Strata runs in: its own Python only, and every per-user folder moved into this engine's state folder.
function strataEnv(e) {
  const s = strataState(e), env = { ...process.env };
  delete env.PYTHONHOME; delete env.PYTHONPATH;
  Object.assign(env, {
    PYTHONUTF8: "1", PYTHONNOUSERSITE: "1",
    // A call to a tool the request didn't declare comes back as a tool call, not as text: qqstudio declares only some tools
    // (call_tool, enable_tools, …) and routes a call to any other name itself, as it does with llama.cpp.
    STRATA_UNDECLARED_TOOL_CALLS: "call",
    STRATA_COMPONENTS_DIR: path.join(s, "components"), STRATA_PROFILE_DIR: path.join(s, "profiles"), STRATA_RUNTIME_DIR: path.join(s, "runtime"),
    STRATA_STATE_DIR: path.join(s, "state"), STRATA_INSTALL_DIR: path.join(s, "install"), STRATA_DATA_DIR: path.join(s, "data"),
    STRATA_SETTINGS_FILE: path.join(s, "settings.json"),
    LOCALAPPDATA: path.join(s, "local"), APPDATA: path.join(s, "roaming"), XDG_STATE_HOME: path.join(s, "local"), XDG_DATA_HOME: path.join(s, "data-home"),
  });
  for (const k of ["STRATA_COMPONENTS_DIR", "STRATA_PROFILE_DIR", "STRATA_RUNTIME_DIR", "STRATA_STATE_DIR", "STRATA_INSTALL_DIR", "STRATA_DATA_DIR", "LOCALAPPDATA", "APPDATA"])
    fs.mkdirSync(env[k], { recursive: true });
  return env;
}
// Runs `strata <args>` with this engine's Python and state; onEvent gets each JSON line it prints (--output jsonl).
// Resolves with { code, last } (last: the final JSON object, if any) and keeps the output in state\strata.log.
function strataRun(e, args, onEvent, job) {
  return new Promise((resolve, reject) => {
    const py = strataPython(e.root);
    if (!fs.existsSync(py)) return reject(new Error(`Strata's Python is missing (${py}); download Strata again`));
    fs.mkdirSync(strataState(e), { recursive: true });
    const logPath = path.join(strataState(e), "strata.log");
    fs.appendFileSync(logPath, `[harness] ${new Date().toISOString()} strata ${args.join(" ")}\n`);
    const child = spawn(py, [path.join(e.root, "strata.py"), ...args], { cwd: e.root, env: strataEnv(e), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    if (job) job.child = child;
    let buf = "", last = null, errText = "";
    child.stdout.on("data", (d) => {
      fs.appendFileSync(logPath, d);
      buf += d.toString("utf8");
      const lines = buf.split(/\r?\n/); buf = lines.pop();
      for (const l of lines) { let j; try { j = JSON.parse(l); } catch { continue; } last = j; if (onEvent) onEvent(j); }
    });
    child.stderr.on("data", (d) => { fs.appendFileSync(logPath, d); errText = (errText + d.toString("utf8")).slice(-2000); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (buf.trim()) { try { last = JSON.parse(buf); if (onEvent) onEvent(last); } catch {} }
      resolve({ code, last, stderr: errText.trim() });
    });
  });
}
// The engine for this PC from Strata's feed (or an update of it). Progress goes into the job.
async function strataUpdate(e, job, extra = []) {
  job.state = "engine"; job.done = 0; job.total = 0; job.label = "Engine for this PC";
  const r = await strataRun(e, ["update", "--yes", "--output", "jsonl", ...extra], (ev) => {
    if (ev.event === "progress") { job.done = ev.done || 0; job.total = ev.total || 0; job.label = ev.label || job.label; }
    else if (ev.event === "phase" || ev.event === "waiting") job.note = ev.message || job.note;
  }, job);
  if (job.cancelled) throw new Error("cancelled");
  const out = r.last || {};
  if (r.code !== 0 || out.ok === false) throw new Error(out.error?.message || r.stderr.split("\n").pop() || `strata update failed (exit ${r.code})`);
  const eng = (out.results || []).find((x) => x.component === "engine");
  const ctl = (out.results || []).find((x) => x.component === "control");
  const after = eng?.installed_after || {};
  if (after.version) e.engineVersion = after.version;
  if (after.backend || after.family || after.target) e.backend = after.backend || after.target || after.family;
  if (ctl?.installed_after) e.build = String(ctl.installed_after.version || ctl.installed_after);
  e.updatedAt = Date.now();
  save();
  return out;
}
// Download Strata: the Terminal package, then the engine for this PC. Adds the engine when both are in.
async function downloadStrata({ name } = {}) {
  const rel = await strataRelease();
  const label = String(name || "").trim() || "Strata";
  const id = newId(label === "Strata" ? "strata" : label);
  const dir = path.join(ENGINES_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const job = { id, name: label, kind: "strata", build: rel.control, backend: "", state: "downloading", label: "Strata Terminal " + rel.control, done: 0, total: rel.asset.size, error: null, engine: null };
  jobs.set(id, job);
  (async () => {
    const e = { id, name: label, type: "strata", root: path.join(dir, "terminal"), exe: "", backend: "", build: rel.control, engineVersion: "", release: rel.release, extraArgs: [] };
    try {
      const zip = path.join(dir, rel.asset.name);
      await fetchTo(rel.asset.url, zip, (n) => (job.done += n), job);
      if (job.cancelled) throw new Error("cancelled");
      job.state = "unpacking";
      fs.mkdirSync(e.root, { recursive: true });
      await unzip(zip, e.root);
      await fs.promises.unlink(zip).catch(() => {});
      if (!fs.existsSync(path.join(e.root, "strata.py"))) { // some archives wrap everything in one folder
        const sub = fs.readdirSync(e.root).map((n) => path.join(e.root, n)).find((p) => fs.existsSync(path.join(p, "strata.py")));
        if (!sub) throw new Error("strata.py was not found in the download");
        e.root = sub;
      }
      e.exe = path.join(e.root, "bin", process.platform === "win32" ? "strata.cmd" : "strata");
      if (job.cancelled) throw new Error("cancelled");
      await strataUpdate(e, job, ["--no-control"]); // the Terminal is the one just downloaded; fetch only the engine
      data.engines.push(e);
      save();
      job.state = "done"; job.engine = id;
      console.log(`[engines] downloaded Strata ${rel.control} (engine ${e.engineVersion || "?"}) -> ${e.root}`);
    } catch (err) {
      job.state = job.cancelled ? "cancelled" : "error"; job.error = job.cancelled ? null : err.message;
      await rmRetry(dir).catch(() => {});
    } finally { job.child = null; }
  })();
  const { child, abort, ...shown } = job; // the response: no process or controller objects
  return shown;
}
// ---------- a loadout on Strata ----------
// Load runs `strata launch … --no-tui` in the engine's own state: it adopts the model files, fetches what the model
// still needs (its drafter, the first time), starts the server on qqstudio's port and returns once it serves. The server
// itself is owned by Strata's runtime (it keeps running if this harness restarts). Eject runs `strata launch --stop`.
function launchStrata(e, spec) {
  const py = strataPython(e.root);
  cur = { loadout: spec.loadout, name: spec.name, engine: e.id, pid: null, strata: true, sig: spec.sig, state: "running", error: null, startedAt: Date.now(), child: null, launching: true, progress: null };
  const me = cur;
  // Readable lines (not --output json, which says nothing until the end): a first start downloads the model or the drafter,
  // tunes and loads for minutes, and these lines are the progress the session and the log show.
  const args = [path.join(e.root, "strata.py"), "launch", ...spec.args, "--port", String(PORT), "--access", "local", "--no-tui", "--yes", "--restart",
    "--save-preset", spec.loadout];
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logPath = logFile(spec.loadout);
  fs.writeFileSync(logPath, `[harness] ${new Date().toISOString()} loading ${spec.name} on ${e.name}: strata ${args.slice(1).map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}\n`);
  let child;
  try { child = spawn(py, args, { cwd: e.root, env: strataEnv(e), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); }
  catch (err) { me.state = "error"; me.error = err.message; return; }
  me.child = child;
  let buf = "", lines = [];
  const onOut = (d) => {
    fs.appendFileSync(logPath, d);
    buf += d.toString("utf8");
    const parts = buf.split(/\r?\n|\r/); buf = parts.pop();
    for (const raw of parts) {
      const l = raw.trim();
      if (!l) continue;
      lines.push(l); if (lines.length > 200) lines.shift();
      me.progress = strataProgress(l, me.progress);
    }
  };
  child.stdout.on("data", onOut); child.stderr.on("data", onOut);
  child.on("error", (err) => { if (cur === me) { me.state = "error"; me.error = err.message; me.launching = false; writeRun(); } });
  child.on("close", async (code) => {
    if (cur !== me) return;
    me.child = null;
    if (buf.trim()) lines.push(buf.trim());
    if (me.state !== "running") { me.launching = false; return; } // ejected meanwhile
    const said = [...lines].reverse().find((l) => l.startsWith("[X]"));
    if (code !== 0 || said) {
      me.state = "error";
      me.error = said ? said.slice(3).trim() : `strata launch ended with code ${code}: ${lines.slice(-1)[0] || "see the log"}`;
    } else if ((await health()) !== "ready") { // e.g. "Strata couldn't find an engine for this computer": exit 0, nothing started
      const warn = [...lines].reverse().find((l) => l.startsWith("[!]"));
      me.state = "error"; me.error = `Strata didn't start: ${(warn || lines.slice(-1)[0] || "see the log").replace(/^\[!\]\s*/, "")}`;
    }
    me.launching = false; me.progress = null;
    writeRun();
  });
  data.last = spec.loadout; data.lastEngine = e.id; save();
  writeRun();
  console.log(`[loadouts] loading ${spec.name} on Strata -> ${url()}`);
}
// One line of `strata launch` as progress: { text, pct } (pct from "… 12.3 of 66.4 GB" download lines, else null).
function strataProgress(line, prev) {
  const text = line.replace(/^\[[!X]\]\s*/, "").replace(/\s+\d+%\s*$/, "");
  if (!text || /^https?:\/\//.test(text)) return prev;
  const m = text.match(/([\d.]+) of ([\d.]+) GB/), pct = m && Number(m[2]) > 0 ? Math.min(100, (100 * Number(m[1])) / Number(m[2])) : null;
  return { text: text.length > 160 ? text.slice(0, 157) + "…" : text, pct, at: Date.now() };
}
async function stopStrata() {
  const e = byId(cur.engine), name = cur.name;
  if (cur.child) { try { cur.child.kill(); } catch {} }
  cur = { ...cur, state: "stopped", child: null, launching: false };
  if (e && e.type === "strata") {
    const r = await strataRun(e, ["launch", "--stop"]).catch((err) => ({ code: 1, stderr: err.message }));
    console.log(`[loadouts] stopped ${name} on Strata${r.code ? ` (strata said: ${r.stderr || r.code})` : ""}`);
    for (let i = 0; i < 25 && (await health()) !== "unreachable"; i++) await new Promise((r2) => setTimeout(r2, 200));
  }
  cur = { loadout: cur.loadout, name: cur.name, engine: cur.engine, pid: null, sig: cur.sig, state: "stopped", error: null, startedAt: null, child: null };
  writeRun();
}
async function strataStatus() {
  const h = await health();
  let state;
  if (cur.state === "error") state = "failed";
  else if (cur.state !== "running") state = "stopped";
  else if (h === "ready" && !cur.launching) state = "loaded";
  else if (cur.launching || h === "loading") state = "loading";
  else { state = "failed"; cur.state = "error"; cur.error = cur.error || "Strata stopped serving (see the log)"; writeRun(); }
  return { state, loadout: cur.loadout, name: cur.name, engine: cur.engine, pid: null, strata: true, sig: cur.sig, error: cur.error, startedAt: cur.startedAt, url: url(), health: h,
    progress: state === "loading" ? cur.progress || null : null };
}

// Strata's model catalog for this PC (its own catalog code, through strata_catalog.py): cached on disk, refreshed when asked
// or when older than a day. Rows: {family, model, title, about, downloadGb, verdict, words, installed, recommended, …}.
const catalogs = new Map(); // engine id -> {at, rows, computer, error} | Promise
function strataCatalogFile(e) { return path.join(P.enginesDir, e.id, "catalog.json"); }
function strataCatalog(id, fresh = false) {
  const e = byId(id);
  if (!e || e.type !== "strata") return Promise.reject(Object.assign(new Error("No such Strata engine"), { status: 404 }));
  let c = catalogs.get(id);
  if (!c) { try { c = JSON.parse(fs.readFileSync(strataCatalogFile(e), "utf8")); catalogs.set(id, c); } catch {} }
  if (c && !(c instanceof Promise) && !fresh && Date.now() - c.at < 24 * 3600e3) return Promise.resolve(c);
  if (c instanceof Promise) return c;
  const job = new Promise((resolve) => {
    const py = strataPython(e.root);
    execFile(py, [path.join(__dirname, "strata_catalog.py"), e.root], { cwd: e.root, env: strataEnv(e), windowsHide: true, timeout: 120000, maxBuffer: 8 << 20 },
      (err, stdout, stderr) => {
        let j = null;
        try { j = JSON.parse(String(stdout).trim().split(/\r?\n/).pop()); } catch {}
        const out = j && j.ok ? { at: Date.now(), rows: j.rows || [], files: j.files || [], computer: j.computer || "", unavailable: j.unavailable || [], error: null }
          : { at: Date.now(), rows: [], computer: "", error: j?.error || (err ? err.message : String(stderr).trim().split(/\r?\n/).pop() || "no answer") };
        if (out.error && c && c.rows?.length) { catalogs.set(id, c); return resolve({ ...c, error: out.error, stale: true }); } // keep the last good list
        catalogs.set(id, out);
        if (!out.error) { try { fs.writeFileSync(strataCatalogFile(e), JSON.stringify(out)); } catch {} }
        resolve(out);
      });
  });
  catalogs.set(id, job);
  return job;
}
// The last catalog known without running anything (for lists that must answer at once).
function strataCatalogCached(id) { const c = catalogs.get(id); if (c && !(c instanceof Promise)) return c; const e = byId(id); if (!e) return null; try { const j = JSON.parse(fs.readFileSync(strataCatalogFile(e), "utf8")); catalogs.set(id, j); return j; } catch { return null; } }

// Update an installed Strata (Terminal and engine) through its own updater.
const strataBusy = new Set();
async function updateStrata(id) {
  const e = byId(id);
  if (!e || e.type !== "strata") throw Object.assign(new Error("No such Strata engine"), { status: 404 });
  if (strataBusy.has(id)) throw Object.assign(new Error("Already updating"), { status: 409 });
  if (cur.pid && cur.engine === id) throw Object.assign(new Error("A loadout on this engine is loaded; eject it first"), { status: 409 });
  const job = { id: "upd-" + id, name: e.name, kind: "strata", build: e.build, state: "engine", label: "Checking for updates", done: 0, total: 0, error: null, engine: id };
  jobs.set(job.id, job); strataBusy.add(id);
  (async () => {
    try { await strataUpdate(e, job); job.state = "done"; job.label = "Up to date"; }
    catch (err) { job.state = job.cancelled ? "cancelled" : "error"; job.error = job.cancelled ? null : err.message; }
    finally { strataBusy.delete(id); job.child = null; }
  })();
  const { child, abort, ...shown } = job; // the response: no process or controller objects
  return shown;
}

function findExe(dir) {
  const all = [];
  (function walk(d, depth) {
    for (const x of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, x.name);
      if (x.isDirectory() && depth < 3) walk(p, depth + 1); else all.push(p);
    }
  })(dir, 0);
  const pick = (n) => all.find((p) => path.basename(p).toLowerCase() === n);
  return pick("llama-server.exe") || pick("llama.exe") || pick("llama-server") || pick("llama") || null;
}

// Minimal zip reader (stored and deflate entries, zip64 sizes), streaming each file to disk.
async function unzip(file, dest) {
  const fd = await fs.promises.open(file, "r");
  try {
    const size = (await fd.stat()).size;
    const tailLen = Math.min(size, 65557), tail = Buffer.alloc(tailLen);
    await fd.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error("not a zip file");
    let count = tail.readUInt16LE(eocd + 10), cdSize = tail.readUInt32LE(eocd + 12), cdOff = tail.readUInt32LE(eocd + 16);
    if (cdOff === 0xffffffff || count === 0xffff) { // zip64 end of central directory
      const loc = eocd - 20;
      if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) throw new Error("zip64 locator missing");
      const z64off = Number(tail.readBigUInt64LE(loc + 8)), z = Buffer.alloc(56);
      await fd.read(z, 0, 56, z64off);
      count = Number(z.readBigUInt64LE(32)); cdSize = Number(z.readBigUInt64LE(40)); cdOff = Number(z.readBigUInt64LE(48));
    }
    const cd = Buffer.alloc(cdSize);
    await fd.read(cd, 0, cdSize, cdOff);
    let p = 0;
    for (let n = 0; n < count; n++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error("bad zip central directory");
      const mode = cd.readUInt32LE(p + 38) >>> 16; // unix permissions, if the zip recorded them
      const method = cd.readUInt16LE(p + 10), nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commentLen = cd.readUInt16LE(p + 32);
      let csize = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24), lho = cd.readUInt32LE(p + 42);
      const name = cd.toString("utf8", p + 46, p + 46 + nameLen);
      let e = p + 46 + nameLen; const eEnd = e + extraLen;
      while (e + 4 <= eEnd) { // zip64 extra field: the 0xffffffff values, in order
        const tag = cd.readUInt16LE(e), len = cd.readUInt16LE(e + 2); let q = e + 4;
        if (tag === 1) {
          if (usize === 0xffffffff) { usize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (csize === 0xffffffff) { csize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (lho === 0xffffffff) { lho = Number(cd.readBigUInt64LE(q)); q += 8; }
        }
        e += 4 + len;
      }
      p = eEnd + commentLen;
      const out = path.resolve(dest, name);
      const rel = path.relative(path.resolve(dest), out);
      if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`unsafe path in zip: ${name}`);
      if (name.endsWith("/")) { await fs.promises.mkdir(out, { recursive: true }); continue; }
      await fs.promises.mkdir(path.dirname(out), { recursive: true });
      const lh = Buffer.alloc(30);
      await fd.read(lh, 0, 30, lho);
      if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error("bad zip local header");
      const dataStart = lho + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      if (csize === 0) { await fs.promises.writeFile(out, ""); continue; }
      const src = fs.createReadStream(file, { start: dataStart, end: dataStart + csize - 1 });
      const dst = fs.createWriteStream(out);
      await new Promise((resolve, reject) => {
        const s = method === 8 ? src.pipe(zlib.createInflateRaw()) : method === 0 ? src : null;
        if (!s) return reject(new Error(`unsupported zip compression (${method}) for ${name}`));
        s.on("error", reject); dst.on("error", reject); dst.on("finish", resolve);
        s.pipe(dst);
      });
      if (process.platform !== "win32" && mode & 0o111) await fs.promises.chmod(out, mode & 0o777).catch(() => {});
    }
  } finally { await fd.close(); }
}

// ---------- startup ----------
// Engines used to run llama-server in router mode, each with its own PID file. A router left running from before
// would hold the port and the GPU, so it is stopped. Then the loadout process from running.json is picked up.
// Returns whether one was picked up (if not, server.js may load the last-used loadout).
async function init() {
  fs.mkdirSync(ENGINES_DIR, { recursive: true });
  for (const f of [P.pid, ...data.engines.map((e) => path.join(engineDir(e), "server.pid"))]) {
    try {
      const p = Number(fs.readFileSync(f, "utf8"));
      if (p && (await isLlama(p))) { await kill(p); console.log(`[engines] stopped an old router-mode engine (pid ${p}); loadouts now run as their own process`); }
      fs.unlinkSync(f);
    } catch {}
  }
  delete data.active; delete data.restartOnModelsChange;
  for (const e of data.engines) delete e.port;
  save();
  try {
    const r = JSON.parse(fs.readFileSync(RUN_FILE, "utf8"));
    const e = byId(r.engine);
    if (r.strata && e && e.type === "strata" && (await health()) !== "unreachable") { // Strata keeps serving on its own after a harness restart
      cur = { loadout: r.loadout, name: r.name || r.loadout, engine: r.engine, pid: null, strata: true, sig: r.sig, state: "running", error: null, startedAt: r.startedAt || null, child: null, launching: false };
      console.log(`[loadouts] picked up running ${cur.name} on Strata`);
      return true;
    }
    if (r.pid && e && (await isLlama(r.pid, e.exe))) {
      cur = { loadout: r.loadout, name: r.name || r.loadout, engine: r.engine, pid: r.pid, sig: r.sig, state: "running", error: null, startedAt: r.startedAt || null, child: null };
      console.log(`[loadouts] picked up running ${cur.name} (pid ${r.pid})`);
      return true;
    }
    fs.unlinkSync(RUN_FILE);
  } catch {}
  return false;
}

module.exports = {
  init, launch, stop, status, current, list, log, url, add, update, remove, setOptions, releases, download, cancel, clearJobs, unzip,
  strataRelease, downloadStrata, updateStrata, strataCatalog, strataCatalogCached,
  byId, all: () => data.engines, defaultEngine, subcmd,
  settings: () => ({ autostart: data.autostart, last: data.last }),
};
