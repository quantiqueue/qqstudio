// Dev launcher: runs server.js and restarts it when server-side .js files change.
// Works on any Node version (no --watch needed). Browser reload is handled by server.js itself.
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const WATCH = (f) => f && /\.(js|json)$/i.test(f) && !f.startsWith("public") && !f.startsWith("chats") && !f.includes("node_modules") && f !== "dev.js";
let child = null, timer = null, restarting = false;

function start() {
  child = spawn(process.execPath, [path.join(ROOT, "server.js")], { stdio: "inherit", env: process.env });
  child.on("exit", (code) => {
    if (restarting) { restarting = false; start(); }
    else console.log(`[dev] server exited (code ${code}); waiting for a file change to restart...`);
  });
}

function restart(file) {
  console.log(`[dev] ${file} changed -> restarting server`);
  if (child && child.exitCode === null) { restarting = true; child.kill(); }
  else start();
}

function onChange(_evt, file) {
  if (!file) return;
  file = file.split(path.sep).join("/");
  if (!WATCH(file)) return;
  clearTimeout(timer);
  timer = setTimeout(() => restart(file), 150);
}

try {
  fs.watch(ROOT, { recursive: true }, onChange); // recursive works on Windows/macOS
} catch {
  fs.watch(ROOT, onChange); // Linux on old Node: top-level only, which covers server.js/tools.js
}
process.on("SIGINT", () => { if (child) child.kill(); process.exit(0); });
console.log("[dev] watching server files for changes (restart this window if dev.js itself changes)");
start();
