// Where user data lives: %USERPROFILE%\.qqstudio (override with QQSTUDIO_HOME).
// The app folder only holds code. Old files from the app folder are moved here on first run.
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOME = path.resolve(process.env.QQSTUDIO_HOME || path.join(os.homedir(), ".qqstudio"));
const P = {
  home: HOME,
  chats: path.join(HOME, "chats"),               // old (pre-workspaces) sessions folder; moved into workspaces\Default
  workspaces: path.join(HOME, "workspaces"),     // <id>\{workspace.json, sessions\, files\}
  models: path.join(HOME, "models"),             // default models folder (<vendor>\<model>\<file>.gguf)
  skills: path.join(HOME, "skills"),             // <name>\SKILL.md (Anthropic Agent Skills format)
  skillsCfg: path.join(HOME, "skills.json"),     // enabled/disabled skills
  mcp: path.join(HOME, "mcp.json"),              // MCP servers, Claude Desktop format {"mcpServers": {...}}
  config: path.join(HOME, "config.json"),        // general settings (models folder, ...)
  tools: path.join(HOME, "tools.json"),          // tool enable / ask-first
  llama: path.join(HOME, "llama-server.json"),   // old single-engine settings (moved into engines.json on first run)
  engines: path.join(HOME, "engines.json"),      // {engines: [...], active, autostart, restartOnModelsChange}
  enginesDir: path.join(HOME, "engines"),
  loadouts: path.join(HOME, "loadouts.json"),    // {loadouts: [{id, name, engine, model, vision, load, other, sampling}]}        // <id>\ : downloaded llama.cpp build, server.log, server.pid
  presets: path.join(HOME, "models.ini"),        // generated llama-server presets
  uploads: path.join(HOME, "uploads"),          // images pasted or dropped into the chat
  pid: path.join(HOME, "llama-server.pid"),
  log: path.join(HOME, "logs", "llama-server.log"),
};

for (const d of [HOME, P.models, P.skills, path.dirname(P.log)]) fs.mkdirSync(d, { recursive: true });

function move(from, to) {
  if (!fs.existsSync(from) || fs.existsSync(to)) return false;
  try { fs.renameSync(from, to); }
  catch { try { fs.copyFileSync(from, to); try { fs.unlinkSync(from); } catch {} } catch { return false; } }
  return true;
}

// One-time migration from the app folder.
(function migrate() {
  const APP = __dirname;
  const moved = [];
  for (const [from, to] of [
    ["llama-server.cfg", P.llama], ["tools.cfg", P.tools], ["models.ini", P.presets],
    ["llama-server.pid", P.pid], ["llama-server.log", P.log],
  ]) if (move(path.join(APP, from), to)) moved.push(from);
  const oldChats = path.join(APP, "chats");
  try {
    for (const f of fs.readdirSync(oldChats)) if (f.endsWith(".json") && move(path.join(oldChats, f), path.join(P.chats, f))) moved.push("chats/" + f);
    if (!fs.readdirSync(oldChats).length) fs.rmdirSync(oldChats);
  } catch {}
  if (moved.length) console.log(`[data] moved ${moved.length} file(s) to ${HOME}`);
})();

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function writeJson(file, obj) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

module.exports = { ...P, paths: P, readJson, writeJson };
