// The Windows tray icon (from ai_scope's tray.js). server.js calls start() once it listens; tray.ps1 draws the icon
// and its menu (Open qqstudio / Quit qqstudio).
// Rules:
//  - The icon belongs to the server process that started it: it shows however qqstudio runs (installed --app, a
//    console run, start.bat/dev.js) and goes away when that process ends. tray.ps1 holds a handle to this process
//    and takes the icon down itself. Never hard-kill the helper from here: on Windows kill() is TerminateProcess,
//    so the helper never reaches $notify.Dispose() and Windows keeps a dead icon until the mouse crosses it.
//  - Windows only, and it never takes anything with it: every failure is one logged line and qqstudio runs on.
//  - The menu items are loopback calls to this same server (POST /api/tray/open, /api/stop), so no paths or
//    command lines are handed to PowerShell.
// QQSTUDIO_TRAY=0 turns it off (CI and test copies).
"use strict";
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

let child = null;
const log = (msg) => console.log("[tray] " + msg);

function start(opts) {
  if (process.platform !== "win32") return null;
  if (String(process.env.QQSTUDIO_TRAY || "") === "0") { log("off (QQSTUDIO_TRAY=0)"); return null; }
  if (child) return child.pid; // one helper per qqstudio process
  const script = path.join(__dirname, "tray.ps1");
  if (!fs.existsSync(script)) { log("no tray.ps1 in this copy - no icon"); return null; }
  const icon = path.join(__dirname, "public", "qqstudio.ico");
  const args = ["-NoProfile", "-NonInteractive", "-STA", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass",
    "-File", script, "-Port", String(opts.port), "-Version", String(opts.version), "-Icon", icon, "-ParentPid", String(process.pid)];
  try {
    // Not detached on purpose: detached makes powershell.exe hand off to a grandchild that outlives us.
    child = spawn("powershell.exe", args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) { log("could not start: " + e.message + " - qqstudio runs on without an icon"); return null; }
  const me = child;
  const note = (line) => { const s = String(line).replace(/\s+$/, ""); if (s) log(s); };
  me.stdout.setEncoding("utf8"); me.stderr.setEncoding("utf8");
  me.stdout.on("data", note); me.stderr.on("data", note);
  me.on("error", (e) => { log("the tray helper could not run: " + e.message); if (child === me) child = null; });
  me.on("exit", (code) => {
    if (child === me) child = null;
    if (!me.putDown) log("the tray icon stopped (exit " + code + ") - qqstudio keeps running");
  });
  // The helper must never be what keeps qqstudio alive.
  me.unref(); me.stdout.unref && me.stdout.unref(); me.stderr.unref && me.stderr.unref();
  return me.pid;
}

// The helper closes itself within 500 ms of this process exiting; only mark the exit as ours.
function stop() { if (!child) return false; child.putDown = true; child = null; return true; }

process.on("exit", stop);

module.exports = { start, stop };
