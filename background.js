// Long-running commands (builds, dev servers, big downloads): start one in the background, check its output later,
// stop it. Output is kept in memory (the last 200 KB per process); everything is stopped when the harness exits.
const { spawn, execFile } = require("child_process");

const KEEP = 200 * 1024;
const procs = new Map(); // id -> { id, command, cwd, child, out, read, started, exit }
let seq = 0;

function start(command, cwd) {
  const id = "bg" + ++seq;
  const child = spawn(command, { cwd, shell: true, windowsHide: true, env: process.env });
  const p = { id, command, cwd, child, out: "", dropped: 0, read: 0, started: Date.now(), exit: null };
  const add = (d) => {
    p.out += d.toString("utf8");
    if (p.out.length > KEEP) { const cut = p.out.length - KEEP; p.out = p.out.slice(cut); p.dropped += cut; p.read = Math.max(0, p.read - cut); }
  };
  child.stdout.on("data", add);
  child.stderr.on("data", add);
  child.on("exit", (code, signal) => { p.exit = signal ? `stopped (${signal})` : `exit code ${code}`; });
  child.on("error", (e) => { add(`\n[failed to start: ${e.message}]\n`); p.exit = "failed to start"; });
  procs.set(id, p);
  return p;
}

const ago = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; };
const state = (p) => (p.exit ? `finished (${p.exit})` : `running for ${ago(Date.now() - p.started)}`);

// New output since the last check (or the last `tail` characters when asked).
function check(id, tail) {
  const p = procs.get(id);
  if (!p) return `ERROR: no background command "${id}". Running or finished: ${[...procs.keys()].join(", ") || "none"}.`;
  let text;
  if (tail) text = p.out.slice(-Math.min(Number(tail) || 4000, KEEP));
  else { text = p.out.slice(p.read); p.read = p.out.length; }
  return `${p.id}: ${state(p)} · ${p.command}\n--- ${tail ? "last output" : "new output"} ---\n${text || "(none)"}`;
}

function stop(id) {
  const p = procs.get(id);
  if (!p) return Promise.resolve(`ERROR: no background command "${id}".`);
  if (p.exit) return Promise.resolve(`${id} had already ${p.exit === "failed to start" ? "failed to start" : "finished (" + p.exit + ")"}.`);
  return new Promise((resolve) => {
    const done = () => resolve(`Stopped ${id} (${p.command}).`);
    if (process.platform === "win32") execFile("taskkill", ["/pid", String(p.child.pid), "/t", "/f"], { windowsHide: true }, done); // the whole tree (shell + program)
    else { try { p.child.kill("SIGTERM"); } catch {} setTimeout(done, 300); }
  });
}

function list() {
  if (!procs.size) return "No background commands.";
  return [...procs.values()].map((p) => `${p.id}: ${state(p)} · ${p.command}${p.out.length > p.read ? " · new output" : ""}`).join("\n");
}

function stopAll() {
  for (const p of procs.values()) if (!p.exit) {
    try { if (process.platform === "win32") require("child_process").execFileSync("taskkill", ["/pid", String(p.child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" }); else p.child.kill("SIGTERM"); } catch {}
  }
}
process.on("exit", stopAll);

module.exports = { start, check, stop, list, stopAll };
