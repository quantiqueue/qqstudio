#!/usr/bin/env node
// qqstudio command line (installed as `qqstudio` by install.ps1 / install.sh).
// Parses the flags, then runs server.js in this process (no restarts on file changes; dev.js is for development).
"use strict";
const path = require("path");
const pkg = require("../package.json");

const major = parseInt(process.versions.node.split(".")[0], 10);
if (major < 18) {
  console.log("qqstudio needs Node.js 18 or newer (you have " + process.version + "). Run the qqstudio installer again to get a private copy, or install the LTS version from nodejs.org.");
  process.exit(1);
}

const DEFAULT_PORT = Number(process.env.PORT) || 8003;

const HELP = [
  "qqstudio " + pkg.version + " - local AI studio for llama.cpp and Strata",
  "",
  "Usage: qqstudio [options]",
  "",
  "Options:",
  "  -p, --port <n>          Port for the page (default 8003)",
  "      --host <addr>       127.0.0.1 = this computer only, 0.0.0.0 = also other devices",
  "                          (default: Settings > Server decides)",
  "  -o, --open              Open qqstudio in your browser once it runs",
  "      --app               Run in the background (no console window) and open qqstudio in its",
  "                          own window; if it's already running, just open the window",
  "      --stop              Stop qqstudio running in the background (a loaded model keeps running;",
  "                          eject it first in Settings > Loadouts if you want its memory back)",
  "      --data-dir <path>   Where settings, sessions, engines and models live (default ~/.qqstudio)",
  "      --uninstall         Remove qqstudio (when installed with install.ps1 / install.sh)",
  "  -v, --version           Show the version",
  "  -h, --help              Show this help",
  "",
  "Examples:",
  "  qqstudio --app",
  "  qqstudio --open",
  "  qqstudio --stop",
  "  qqstudio --port 8010",
].join("\n");

function fail(msg) { console.log("qqstudio: " + msg + "\n\nRun \"qqstudio --help\" for the options."); process.exit(1); }

const argv = process.argv.slice(2);
const opts = { port: null, host: null, open: false, app: false, stop: false, dataDir: null };
const passOn = []; // flags handed to the background copy started by --app
for (let i = 0; i < argv.length; i++) {
  let a = argv[i], val = null;
  const eq = a.indexOf("=");
  if (a.startsWith("--") && eq > 0) { val = a.slice(eq + 1); a = a.slice(0, eq); }
  const next = () => {
    if (val !== null) return val;
    if (i + 1 >= argv.length || argv[i + 1].startsWith("-")) fail(a + " needs a value");
    return argv[++i];
  };
  switch (a) {
    case "-p": case "--port": {
      const p = parseInt(next(), 10);
      if (!(p >= 1 && p <= 65535)) fail("port must be a number from 1 to 65535");
      opts.port = p; passOn.push("--port", String(p)); break;
    }
    case "--host": opts.host = next(); passOn.push("--host", opts.host); break;
    case "-o": case "--open": opts.open = true; break;
    case "--app": opts.app = true; break;
    case "--stop": opts.stop = true; break;
    case "--data-dir": opts.dataDir = path.resolve(next()); passOn.push("--data-dir", opts.dataDir); break;
    case "--uninstall":
      // Normally handled by the qqstudio launcher before Node starts; we only get here when run another way.
      console.log(process.env.QQSTUDIO_LAUNCHER ? "The uninstaller did not start. Run the installer's uninstall script from the app folder's install/ folder."
        : "This copy was not installed with install.ps1 / install.sh. A cloned folder can just be deleted (your data is in ~/.qqstudio).");
      process.exit(0); break;
    case "-v": case "--version": console.log(pkg.version); process.exit(0); break;
    case "-h": case "--help": console.log(HELP); process.exit(0); break;
    default: fail("unknown option " + a);
  }
}

const port = opts.port || DEFAULT_PORT;
if (opts.dataDir) process.env.QQSTUDIO_HOME = opts.dataDir;

if (opts.stop) require("./app").stop(port);
else if (opts.app) require("./app").app({ port, flags: passOn });
else {
  if (opts.port) process.env.PORT = String(opts.port);
  if (opts.host) process.env.HOST = opts.host;
  if (opts.open) process.env.QQSTUDIO_OPEN = "1";
  if (process.env.HOT_RELOAD === undefined) process.env.HOT_RELOAD = "0"; // page reloads on file changes are for development
  if (process.stdout.isTTY) process.title = "qqstudio";
  console.log("qqstudio " + pkg.version + (process.env.QQSTUDIO_BACKGROUND ? "  (background, started " + new Date().toLocaleString() + ")" : "  (Ctrl+C to stop)"));
  require("../server.js");
}
