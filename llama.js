// Manages a llama-server process for the harness.
// The process is started detached with output going to llama-server.log, so it keeps running when the
// harness restarts (hot reload); on startup the harness re-adopts it via llama-server.pid.
const fs = require("fs");
const path = require("path");
const { spawn, execFile } = require("child_process");

const P = require("./paths");
const DIR = __dirname;
const SETTINGS_FILE = P.llama;
const PID_FILE = P.pid;
const LOG_FILE = P.log;
const PRESET_FILE = P.presets;

const DEFAULTS = {
  exe: "llama",
  args: 'serve --models-preset "{presets}" --jinja --host 127.0.0.1 --port 9931',
  autostart: true,          // start when the harness starts (if not already running)
  restartOnModelsChange: true, // restart when models.ini changes (new downloads)
};

let settings = load();
let pid = null;
let state = "stopped"; // stopped | running | error
let error = null;
let startedAt = null;
let child = null;
let busy = Promise.resolve();

function load() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) }; } catch { return { ...DEFAULTS }; }
}
function getSettings() { return { ...settings, presetFile: PRESET_FILE, logFile: LOG_FILE }; }
function saveSettings(s) {
  settings = { ...settings, ...pick(s, Object.keys(DEFAULTS)) };
  P.writeJson(SETTINGS_FILE, settings);
  return getSettings();
}
function pick(o, keys) { return Object.fromEntries(keys.filter((k) => o && k in o).map((k) => [k, o[k]])); }

function argv() {
  const s = settings.args.replace(/\{presets\}/g, PRESET_FILE);
  const a = [...s.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => (m[1] !== undefined ? m[1] : m[2]));
  // Newer llama.cpp ships one "llama" binary with subcommands: the server is "llama serve".
  // Older builds have a separate "llama-server" binary that takes no subcommand.
  const bin = path.basename(settings.exe).toLowerCase().replace(/\.exe$/, "");
  if (bin === "llama" && a[0] !== "serve") a.unshift("serve");
  if (bin === "llama-server" && a[0] === "serve") a.shift();
  return a;
}
function port() {
  const a = argv();
  const i = a.findIndex((x) => x === "--port");
  return i >= 0 && a[i + 1] ? Number(a[i + 1]) : 8080;
}
function host() {
  const a = argv();
  const i = a.findIndex((x) => x === "--host");
  const h = i >= 0 ? a[i + 1] : "127.0.0.1";
  return h === "0.0.0.0" ? "127.0.0.1" : h;
}
function url() { return process.env.LLAMA_URL ? process.env.LLAMA_URL.replace(/\/+$/, "") : `http://${host()}:${port()}`; }

function alive(p) {
  if (!p) return false;
  try { process.kill(p, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

// Guard against PID reuse: only treat a PID as ours if it is actually llama-server.
function isLlama(p) {
  if (!alive(p)) return Promise.resolve(false);
  if (process.platform !== "win32") return Promise.resolve(true);
  const want = path.basename(settings.exe).toLowerCase().replace(/\.exe$/, "");
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

function start() {
  return (busy = busy.then(async () => {
    if (pid && alive(pid)) return;
    if ((await health()) !== "unreachable") {
      state = "error";
      error = `Something is already answering on ${url()} (another llama-server?). Stop it first.`;
      return;
    }
    error = null;
    const out = fs.openSync(LOG_FILE, "w");
    fs.writeSync(out, `[harness] ${new Date().toISOString()} starting: ${settings.exe} ${argv().map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}\n`);
    try {
      child = spawn(settings.exe, argv(), {
        detached: true, windowsHide: true, stdio: ["ignore", out, out],
        cwd: path.isAbsolute(settings.exe) ? path.dirname(settings.exe) : DIR,
      });
    } catch (e) {
      fs.closeSync(out);
      state = "error"; error = e.message; return;
    }
    fs.closeSync(out);
    const c = child;
    c.on("error", (e) => {
      state = "error"; pid = null;
      error = e.code === "ENOENT" ? `"${settings.exe}" not found. Set the full path to llama.exe (or llama-server.exe on older builds) in Engine settings.` : e.message;
      try { fs.unlinkSync(PID_FILE); } catch {}
    });
    c.on("exit", (code) => {
      if (child !== c) return;
      child = null;
      if (pid === c.pid) { pid = null; try { fs.unlinkSync(PID_FILE); } catch {} }
      if (state === "running") { state = code ? "error" : "stopped"; if (code) error = `llama-server exited with code ${code} (see log)`; }
    });
    c.unref();
    if (c.pid) {
      pid = c.pid; state = "running"; startedAt = Date.now();
      fs.writeFileSync(PID_FILE, String(pid));
      console.log(`[llama] started pid ${pid} -> ${url()}`);
    }
    await new Promise((r) => setTimeout(r, 300)); // let a spawn error surface
  }));
}

function stop() {
  return (busy = busy.then(async () => {
    if (!pid || !(await isLlama(pid))) { pid = null; state = "stopped"; try { fs.unlinkSync(PID_FILE); } catch {} return; }
    const p = pid;
    if (process.platform === "win32") await new Promise((r) => execFile("taskkill", ["/PID", String(p), "/T", "/F"], { windowsHide: true }, () => r()));
    else try { process.kill(-p, "SIGTERM"); } catch { try { process.kill(p, "SIGTERM"); } catch {} }
    for (let i = 0; i < 50 && alive(p); i++) await new Promise((r) => setTimeout(r, 200));
    pid = null; state = "stopped"; error = null; child = null;
    try { fs.unlinkSync(PID_FILE); } catch {}
    console.log(`[llama] stopped pid ${p}`);
  }));
}

async function restart() { await stop(); await start(); }

async function status() {
  if (pid && !alive(pid)) { pid = null; if (state === "running") { state = "error"; error = error || "llama-server exited (see log)"; } }
  return { state, pid, error, startedAt, url: url(), health: pid ? await health() : (await health()) === "unreachable" ? "unreachable" : "external" };
}

function log(bytes = 64 * 1024) {
  try {
    const size = fs.statSync(LOG_FILE).size;
    const fd = fs.openSync(LOG_FILE, "r");
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    return buf.toString("utf8").replace(/\x1b\[[0-9;]*m/g, "");
  } catch { return ""; }
}

// On harness startup: re-adopt a running llama-server, or autostart.
async function init() {
  try {
    const p = Number(fs.readFileSync(PID_FILE, "utf8"));
    if (p && (await isLlama(p))) { pid = p; state = "running"; console.log(`[llama] adopted running pid ${p}`); return; }
    fs.unlinkSync(PID_FILE);
  } catch {}
  if (settings.autostart) await start();
}

module.exports = { init, start, stop, restart, status, log, url, getSettings, saveSettings, settings: () => settings };
