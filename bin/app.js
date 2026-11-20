// `qqstudio --app` / `qqstudio --stop`: qqstudio as a desktop-style app.
//  --app : if qqstudio isn't running yet, start it hidden in the background (no console window; output goes to
//          <data folder>/logs/qqstudio.log), then open the page in its own window: Edge or Chrome in app mode
//          (no address bar or tabs, its own profile so the window keeps its size and position), else the default
//          browser. Closing the window leaves qqstudio running (the tray icon or `qqstudio --stop` ends it).
//  --stop: asks the background qqstudio to exit. A loaded loadout keeps running on purpose (it's picked up again
//          on the next start), as with Ctrl+C.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const dataHome = () => path.resolve(process.env.QQSTUDIO_HOME || path.join(os.homedir(), ".qqstudio"));
const logFile = () => path.join(dataHome(), "logs", "qqstudio.log");

// GET /api/ping on this computer. cb(state, info): "qqstudio" (running), "other" (port taken by another program), "down".
function ping(port, cb) {
  const req = http.get({ host: "127.0.0.1", port, path: "/api/ping", timeout: 2000, headers: { Host: "localhost:" + port } }, (res) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (d) => { if (body.length < 65536) body += d; });
    res.on("end", () => {
      try { const j = JSON.parse(body); if (j && j.app === "qqstudio") return cb("qqstudio", j); } catch {}
      cb("other", null);
    });
  });
  req.on("timeout", () => req.destroy(new Error("timeout")));
  req.on("error", () => cb("down", null));
}

function waitUntilUp(port, ms, cb) {
  const until = Date.now() + ms;
  (function again() {
    ping(port, (state, info) => {
      if (state !== "down") return cb(state, info);
      if (Date.now() > until) return cb("down");
      setTimeout(again, 300);
    });
  })();
}

// Start bin/qqstudio.js again, detached and without a window, writing to the log (kept to about 2 MB, one old copy).
function startBackground(flags) {
  const log = logFile();
  let out = "ignore";
  try {
    fs.mkdirSync(path.dirname(log), { recursive: true });
    try { if (fs.statSync(log).size > 2 * 1048576) fs.renameSync(log, log + ".old"); } catch {}
    out = fs.openSync(log, "a");
  } catch {}
  const env = { ...process.env, QQSTUDIO_BACKGROUND: "1" };
  delete env.QQSTUDIO_OPEN;
  const child = spawn(process.execPath, [path.join(__dirname, "qqstudio.js"), ...flags],
    { detached: true, windowsHide: true, stdio: ["ignore", out, out], env, cwd: os.homedir() });
  child.unref();
  return child.pid;
}

// Browsers that can open a page as an app window (--app=URL).
function appBrowsers() {
  const list = [];
  if (process.platform === "win32") {
    const roots = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
    for (const r of roots) list.push({ name: "Edge", exe: path.join(r, "Microsoft", "Edge", "Application", "msedge.exe") });
    for (const r of roots) list.push({ name: "Chrome", exe: path.join(r, "Google", "Chrome", "Application", "chrome.exe") });
  } else if (process.platform === "darwin") {
    list.push({ name: "Chrome", exe: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
    list.push({ name: "Edge", exe: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" });
  } else {
    for (const exe of ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"])
      list.push({ name: path.basename(exe), exe });
  }
  return list.filter((b) => { try { return fs.statSync(b.exe).isFile(); } catch { return false; } });
}

// The app window's own browser profile (keeps its size and position; apart from your normal browsing).
function profileDir(browser) {
  const base = process.platform === "win32" ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "qqstudio")
    : process.platform === "darwin" ? path.join(os.homedir(), "Library", "Caches", "qqstudio")
    : path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "qqstudio");
  return path.join(base, browser === "Edge" ? "window" : "window-" + browser.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
}

function openWindow(url) {
  const b = appBrowsers()[0];
  if (!b) { require("./open")(url); return "your default browser"; }
  try {
    const p = spawn(b.exe, ["--app=" + url, "--user-data-dir=" + profileDir(b.name), "--no-first-run", "--no-default-browser-check"],
      { detached: true, stdio: "ignore" });
    p.on("error", () => require("./open")(url));
    p.unref();
    return b.name;
  } catch { require("./open")(url); return "your default browser"; }
}

// opts: { port, flags }
function app(opts) {
  const url = "http://localhost:" + opts.port + "/";
  const done = (code) => setTimeout(() => process.exit(code), 300);
  ping(opts.port, (state) => {
    if (state === "other") {
      console.log("qqstudio: port " + opts.port + " is used by another program. Use --port to pick another one.");
      return done(1);
    }
    if (state === "qqstudio") {
      console.log("qqstudio is already running - opening it in " + openWindow(url) + ".");
      return done(0);
    }
    startBackground(opts.flags);
    console.log("Starting qqstudio in the background (log: " + logFile() + ")...");
    waitUntilUp(opts.port, 30000, (s) => {
      if (s !== "qqstudio") {
        console.log("qqstudio: it did not start" + (s === "other" ? " (port " + opts.port + " is used by another program)" : "") + ". See " + logFile());
        return done(1);
      }
      console.log("Opening it in " + openWindow(url) + ". Stop it with: qqstudio --stop");
      done(0);
    });
  });
}

function stop(port) {
  const req = http.request({ host: "127.0.0.1", port, path: "/api/stop", method: "POST", timeout: 5000,
    headers: { Host: "localhost:" + port, "X-QQStudio": "stop", "Content-Length": 0 } }, (res) => {
    res.resume();
    res.on("end", () => {
      if (res.statusCode === 200) console.log("qqstudio (port " + port + ") stopped.");
      else console.log("qqstudio: port " + port + " did not accept the stop request (HTTP " + res.statusCode + ") - is it an older qqstudio or another program?");
      process.exit(res.statusCode === 200 ? 0 : 1);
    });
  });
  req.on("timeout", () => req.destroy(new Error("timeout")));
  req.on("error", () => { console.log("qqstudio is not running on port " + port + "."); process.exit(0); });
  req.end();
}

module.exports = { app, stop, ping, openWindow };
