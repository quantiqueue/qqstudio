// Process trees, the same on every OS: start a command in its own process group (Linux/macOS) so the whole tree can be
// stopped, and stop it (Windows: taskkill /T /F; elsewhere SIGTERM to the group, then SIGKILL if it hasn't gone).
// onExit hooks run when qqstudio exits, also on Ctrl+C or a kill (Linux/macOS: a process in its own group doesn't get
// the terminal's Ctrl+C, so qqstudio stops it itself).
const { execFile, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const WIN = process.platform === "win32";

const group = WIN ? {} : { detached: true }; // spawn options for a stoppable tree

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}
const signal = (pid, sig) => { try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch {} } };

// Stops pid and everything it started. Resolves when it's gone (or after the forced stop).
async function killTree(pid, { wait = 3000 } = {}) {
  if (!pid) return;
  if (WIN) return new Promise((r) => execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => r()));
  signal(pid, "SIGTERM");
  for (let t = 0; t < wait && alive(pid); t += 100) await new Promise((r) => setTimeout(r, 100));
  if (alive(pid)) signal(pid, "SIGKILL");
}
// For exit handlers, which can't wait.
function killTreeSync(pid) {
  if (!pid) return;
  if (WIN) { try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch {} return; }
  signal(pid, "SIGTERM");
}

const hooks = new Set();
function runHooks() { for (const f of hooks) { try { f(); } catch {} } hooks.clear(); }
function onExit(fn) { hooks.add(fn); }
process.on("exit", runHooks);
if (!WIN) {
  for (const [sig, n] of [["SIGINT", 2], ["SIGTERM", 15], ["SIGHUP", 1]]) {
    process.on(sig, () => { runHooks(); process.exit(128 + n); }); // what Node does by default, plus the hooks
  }
}

// Whether a program is on PATH (no process started).
function onPath(name) {
  const exts = WIN ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  return (process.env.PATH || "").split(path.delimiter).filter(Boolean).some((d) => exts.some((x) => {
    try { const f = path.join(d, name + x); return fs.statSync(f).isFile() && (WIN || (fs.accessSync(f, fs.constants.X_OK), true)); } catch { return false; }
  }));
}

module.exports = { group, alive, killTree, killTreeSync, onExit, onPath };
