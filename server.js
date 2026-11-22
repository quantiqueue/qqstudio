// Minimal harness: serves a chat UI and proxies to llama-server.
// No dependencies; needs Node 18+ (built-in fetch).
const http = require("http");
const os = require("os");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 8003;
const llama = require("./llama");
const PUBLIC = path.join(__dirname, "public");
const DATA = require("./paths"); // must load first: migrates old data into %USERPROFILE%\.qqstudio
const ws = require("./workspaces");
ws.init(); // makes Default, moves the old chats\ folder into it
const lazyTools = require("./lazytools");
const { ROOTS, addRoot, removeRoot, runTool, toolList, toolSettings, saveToolSettings, isEnabled, resolvePath, servable, allowServe, IMAGE_EXT } = require("./tools");
const hf = require("./hf");
const presets = require("./presets");
const loadouts = require("./loadouts");
const createRuns = require("./runs");
// Local only by default: the API can run commands. Settings > Server can open it to the local network
// (other devices then need the access key once). The HOST env var overrides the setting.
function lanCfg() {
  const c = DATA.readJson(DATA.config, {});
  if (!c.lanKey) { c.lanKey = crypto.randomBytes(12).toString("base64url"); DATA.writeJson(DATA.config, c); }
  return { enabled: !!c.lanAccess, key: c.lanKey };
}
const wantHost = () => process.env.HOST || (lanCfg().enabled ? "0.0.0.0" : "127.0.0.1");
let HOST = wantHost();

// ---- Hot reload (disable with HOT_RELOAD=0) ----
// Browser reloads when files in public/ change. Server restarts on server.js/tools.js changes come from
// dev.js; the page notices the new boot id when it reconnects and reloads too.
const HOT = process.env.HOT_RELOAD !== "0";
const BOOT_ID = Date.now().toString(36);
const reloadClients = new Set();
const RELOAD_SNIPPET = `<script>(() => {
  let boot = null;
  const es = new EventSource("/__reload");
  // Pages can set window.harnessBusy = true to defer reloads (e.g. while a reply is streaming).
  const reload = () => { if (window.harnessBusy) window.harnessReloadPending = true; else location.reload(); };
  es.addEventListener("hello", (e) => { if (boot && boot !== e.data) reload(); boot = e.data; });
  es.addEventListener("reload", reload);
  // Leaving the page closes the stream, so a page kept in the back/forward cache can't hold one of the browser's
  // few connections to this server; coming back to such a page reloads it.
  addEventListener("pagehide", () => es.close());
  addEventListener("pageshow", (e) => { if (e.persisted) location.reload(); });
})();</script>`;

if (HOT) {
  let timer = null;
  try {
    fs.watch(PUBLIC, { recursive: true }, (_evt, file) => {
      if (!file || !/\.(html|css|js)$/i.test(file)) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        console.log(`[hot] ${file} changed -> reloading ${reloadClients.size} page(s)`);
        for (const c of reloadClients) c.write("event: reload\ndata: 1\n\n");
      }, 120);
    });
  } catch (e) {
    console.warn("[hot] file watching unavailable:", e.message);
  }
}

function handleReloadStream(req, res) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write(`retry: 500\nevent: hello\ndata: ${BOOT_ID}\n\n`);
  reloadClients.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => { clearInterval(ping); reloadClients.delete(res); });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function readRaw(req, limit) { // raw bytes, refuses bodies over `limit`
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on("data", (c) => { n += c.length; if (n > limit) { reject(Object.assign(new Error("Too large"), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ---- Images for vision models ----
// Which models can see: they have an mmproj in the models folder and vision isn't switched off for them.
function visionMap() {
  const off = presets.visionOff(), out = new Map();
  try { for (const m of presets.list(getConfig().modelsFolder)) out.set(m.name, !!m.mmproj && !off.has(m.name)); } catch {}
  return out;
}
// A loadout can see when vision is on for it and its model has an mmproj; ids that aren't loadouts: the old rule.
const visionOf = (model) => { const v = loadouts.visionOf(model); return v === null ? !!visionMap().get(model) : v; };
// One loadout runs at a time, as its own llama-server process (llama.js). Model requests hold the running loadout
// while they stream (inflight), so it is never stopped or swapped under a reply: a request for another loadout
// waits until those finish, then switches.
const inflight = new Map(); // loadout id -> requests streaming now
let switching = Promise.resolve();
const busyCount = () => [...inflight.values()].reduce((a, b) => a + b, 0);
llama.setInUse(() => { const c = llama.current(); return !!c.loadout && (inflight.get(c.loadout) || 0) > 0; }); // status checks skip /health meanwhile
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
// After loadouts or model files change: reload the running loadout if it would now start differently (or stop it if
// it's gone). If a reply is using it, nothing happens now and restartNeeded says so; the next request reloads it.
async function regenPresets() {
  const c = llama.current();
  if (!c.loadout || process.env.LLAMA_URL) return { restarted: false, restartNeeded: false };
  const sp = loadouts.spec(c.loadout);
  if (sp && sp.sig === c.sig) return { restarted: false, restartNeeded: false };
  if (busyCount()) return { restarted: false, restartNeeded: true };
  if (!sp) { await llama.stop(); return { restarted: false, restartNeeded: false, stopped: true }; }
  console.log(`[loadouts] ${sp.name} changed -> reloading`);
  await llama.launch(sp);
  return { restarted: true, restartNeeded: false };
}
// Before a model request: the session's loadout must be the one running (with its current settings). Returns a
// function that releases it when the request ends. phase(text) shows progress in the reply; signal stops waiting.
async function ensureEngine(model, phase, signal) {
  const lo = loadouts.get(model);
  if (!lo || process.env.LLAMA_URL) return () => {};
  const job = switching.then(async () => {
    for (let shown = null; ; ) {
      if (signal?.aborted) throw new Error("stopped");
      const sp = loadouts.spec(lo.id);
      if (!sp) throw new Error(llama.byId(lo.engine) ? `The model for the loadout "${lo.name}" can't be found` : `The loadout "${lo.name}" has no engine; pick one in Settings > Loadouts`);
      const c = llama.current();
      if (c.loadout === lo.id && c.sig === sp.sig) break;
      if (!busyCount()) {
        if (phase) phase(`Loading ${lo.name}`);
        console.log(`[loadouts] loading ${lo.name}${c.loadout && c.loadout !== lo.id ? ` (unloading ${loadouts.get(c.loadout)?.name || c.loadout})` : ""}`);
        await llama.launch(sp);
        break;
      }
      const other = [...inflight].find(([, n]) => n > 0)?.[0];
      const t = other === lo.id ? `Waiting to reload ${lo.name} (a reply is using it)` : `Waiting for ${loadouts.get(other)?.name || other} to finish`;
      if (phase && shown !== t) phase((shown = t));
      await sleepMs(500);
    }
    inflight.set(lo.id, (inflight.get(lo.id) || 0) + 1); // held before the next switch can start
  });
  switching = job.catch(() => {});
  await job;
  let done = false;
  const release = () => { if (!done) { done = true; inflight.set(lo.id, Math.max(0, (inflight.get(lo.id) || 1) - 1)); } };
  try {
    for (let i = 0, said = null; ; i++) {
      const s = await llama.status();
      if (s.state === "loaded") return release;
      if (s.state === "failed" || s.state === "stopped") throw new Error((s.error || `${lo.name} stopped while loading`) + " (Settings > Loadouts > Log)");
      if (signal?.aborted) throw new Error("stopped");
      // Strata: a first start downloads (the model itself, for a catalog loadout) and tunes; it fails only after 30 minutes
      // with no new progress line. llama.cpp: 10 minutes in all.
      const strata = loadouts.isStrata(lo.engine), quietFor = strata && s.progress?.at ? (Date.now() - s.progress.at) / 1000 : i / 2;
      if (strata ? quietFor > 1800 : i > 1200) throw new Error(`${lo.name} didn't finish loading in ${strata ? "30 minutes without progress" : "10 minutes"} (Settings > Loadouts > Log)`);
      const t = `Loading ${lo.name}` + (s.progress?.text ? ` · ${s.progress.text}` : "");
      if (phase && said !== t) { phase(t, s.progress?.pct ?? null); said = t; }
      await sleepMs(500);
    }
  } catch (e) { release(); throw e; }
}
// Loads a loadout ahead of time (Load button, autostart). Refuses rather than waiting if a reply holds another one.
async function preload(id) {
  const lo = loadouts.get(id);
  if (!lo) throw Object.assign(new Error("No such loadout"), { status: 404 });
  const c = llama.current(), sp = loadouts.spec(id);
  if (!sp) throw Object.assign(new Error(`The model for "${lo.name}" can't be found, or it has no engine`), { status: 400 });
  if (c.loadout === id && c.sig === sp.sig) return;
  if (busyCount()) throw Object.assign(new Error(`A reply is using ${loadouts.get(c.loadout)?.name || "the running loadout"}; try again when it finishes`), { status: 409 });
  const job = switching.then(() => llama.launch(sp));
  switching = job.catch(() => {});
  await job;
}
async function unloadLoadout(id) {
  const c = llama.current();
  if (id && c.loadout !== id) return;
  if (busyCount()) throw Object.assign(new Error("A reply is using it; stop the reply first"), { status: 409 });
  await llama.stop();
}
// Whether a loadout is loaded / loading / failed (null: not running).
async function modelState(id) {
  const s = await llama.status();
  return s.loadout === id ? (s.state === "stopped" ? null : s.state) : null;
}
const UPLOADS = DATA.uploads;
// The file on disk behind a pasted image's /api/uploads/<name> link (null for other image refs).
// Pasted images live in the session's workspace files (/api/workspaces/<ws>/files/<name>); older ones in uploads\.
function uploadPath(src) {
  if (typeof src !== "string") return null;
  if (src.startsWith("/api/uploads/")) return path.join(UPLOADS, path.basename(decodeURIComponent(src.slice(13))));
  const m = src.split("?")[0].match(/^\/api\/workspaces\/([^/]+)\/files\/(.+)$/);
  if (m) try { return ws.filePath(decodeURIComponent(m[1]), m[2].split("/").map(decodeURIComponent).join("/")); } catch {}
  return null;
}
const IMG_MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", webp: "image/webp" };
const MODEL_IMG = /^image\/(png|jpeg|gif|bmp)$/; // what llama.cpp's image loader decodes
const MAX_IMG_BYTES = 12 * 1024 * 1024;
// Turns an image reference (pasted upload, local file, web URL, data URL) into a data URL the model can take.
// Returns null when it can't be read or the format isn't one llama.cpp decodes.
async function loadImage(src) {
  try {
    let buf, mime;
    if (src.startsWith("data:")) {
      const m = src.match(/^data:([^;,]+);base64,/);
      return m && MODEL_IMG.test(m[1]) ? src : null;
    } else if (uploadPath(src)) {
      const file = uploadPath(src);
      buf = await fs.promises.readFile(file);
      mime = IMG_MIME[path.extname(file).slice(1).toLowerCase()];
    } else if (src.startsWith("/api/file?")) {
      const file = servable(new URL(src, "http://x").searchParams.get("path"));
      buf = await fs.promises.readFile(file);
      mime = IMG_MIME[path.extname(file).slice(1).toLowerCase()];
    } else if (/^https?:\/\//i.test(src)) {
      const r = await fetch(src, { signal: AbortSignal.timeout(15000), headers: { "User-Agent": "Mozilla/5.0 qqstudio" } });
      if (!r.ok) return null;
      mime = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      buf = Buffer.from(await r.arrayBuffer());
    } else return null;
    // Trust the file's own signature over its name or headers.
    if (buf[0] === 0x89 && buf[1] === 0x50) mime = "image/png";
    else if (buf[0] === 0xff && buf[1] === 0xd8) mime = "image/jpeg";
    else if (buf.slice(0, 3).toString() === "GIF") mime = "image/gif";
    else if (buf[0] === 0x42 && buf[1] === 0x4d) mime = "image/bmp";
    if (!MODEL_IMG.test(mime || "") || buf.length > MAX_IMG_BYTES) return null;
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch { return null; }
}
// Image files named in a tool's text result (e.g. an MCP tool that exported a PNG); each found is allowed on /api/file.
function imagePathsIn(text) {
  const out = [];
  const rx = /(?:[A-Za-z]:[\\/]|\/)[^\s"'<>|*?\r\n]*?\.(?:png|jpe?g|gif|bmp|webp)\b/gi;
  for (const m of String(text || "").matchAll(rx)) {
    try { const f = resolvePath(m[0]); if (fs.statSync(f).isFile() && !out.includes(f)) { out.push(f); allowServe(f); } } catch {}
    if (out.length >= 4) break;
  }
  // &v=<modified time>: a re-exported file with the same name must not show (or reach the model as) the old version
  return out.map((f) => {
    let v = 0; try { v = Math.round(fs.statSync(f).mtimeMs); } catch {}
    const src = "/api/file?path=" + encodeURIComponent(f) + "&v=" + v;
    return { src, full: src, caption: path.basename(f) };
  });
}
async function handleUploads(req, res) {
  const name = path.basename(decodeURIComponent(req.url.split("?")[0].slice("/api/uploads".length).replace(/^\//, "")));
  if (req.method === "POST" && !name) {
    const ext = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp" }[(req.headers["content-type"] || "").split(";")[0].trim()];
    if (!ext) return sendJson(res, 415, { error: "Only PNG, JPEG, GIF, WebP or BMP images" });
    let buf;
    try { buf = await readRaw(req, 25 * 1024 * 1024); } catch (e) { return sendJson(res, e.status || 400, { error: e.status === 413 ? "Image is larger than 25 MB" : e.message }); }
    // ?workspace=<id>: save into that workspace's files (named after the dropped file, or "pasted-<date>-<time>")
    const wsId = new URL(req.url, "http://x").searchParams.get("workspace");
    if (wsId && ws.exists(wsId)) {
      const want = new URL(req.url, "http://x").searchParams.get("name");
      const d = new Date(), p2 = (n) => String(n).padStart(2, "0");
      const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
      const base = want && /\.(png|jpe?g|gif|webp|bmp)$/i.test(want) ? want : `pasted-${stamp}.${ext}`;
      await fs.promises.mkdir(ws.filesDir(wsId), { recursive: true });
      const name = ws.freeName(wsId, base);
      await fs.promises.writeFile(path.join(ws.filesDir(wsId), name), buf);
      ws.invalidateFiles(wsId);
      return sendJson(res, 200, { src: `/api/workspaces/${encodeURIComponent(wsId)}/files/${encodeURIComponent(name)}`, bytes: buf.length });
    }
    await fs.promises.mkdir(UPLOADS, { recursive: true });
    const file = `${Date.now().toString(36)}${crypto.randomBytes(4).toString("hex")}.${ext}`;
    await fs.promises.writeFile(path.join(UPLOADS, file), buf);
    return sendJson(res, 200, { src: "/api/uploads/" + file, bytes: buf.length });
  }
  if (req.method === "GET" && name) {
    const file = path.join(UPLOADS, name);
    const type = IMG_MIME[path.extname(name).slice(1).toLowerCase()];
    if (!type) return sendJson(res, 404, { error: "Not found" });
    const st = fs.createReadStream(file);
    st.on("error", () => sendJson(res, 404, { error: "Not found" }));
    st.on("open", () => { res.writeHead(200, { "Content-Type": type, "Cache-Control": "private, max-age=31536000, immutable" }); st.pipe(res); });
    return;
  }
  sendJson(res, 405, { error: "Method not allowed" });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function handleModels(res) {
  const los = loadouts.list();
  if (los.length) {
    const s = await llama.status();
    return sendJson(res, 200, { models: los.map((l) => ({ id: l.id, name: l.name, engine: l.engine, engineName: llama.byId(l.engine)?.name || l.engine,
      status: s.loadout === l.id && s.state !== "stopped" ? s.state : null, vision: !!loadouts.visionOf(l.id) })) });
  }
  try {
    const r = await fetch(`${llama.url()}/v1/models`, { signal: AbortSignal.timeout(3000) });
    const body = await r.json();
    // OpenAI shape: { data: [{ id, ... }] }. Older/other shapes: { models: [...] }.
    const vis = visionMap();
    const list = (body.data || body.models || []).map((m) => ({
      id: m.id || m.name || m.model,
      status: m.status && (m.status.value || m.status),
      vision: !!vis.get(m.id || m.name || m.model),
    }));
    sendJson(res, 200, { models: list });
  } catch (e) {
    sendJson(res, 502, { error: `Cannot reach llama-server at ${llama.url()}: ${e.message}` });
  }
}

// ---- Model management: the loadout process stands in for the old router (GET /models, POST /models/load|unload) ----
function statusOf(m) {
  const s = m.status;
  if (!s) return null;
  return typeof s === "string" ? s : s.value || null;
}

// The Models tab's list: every loadout with its state, plus models in llama.cpp's download cache (shown as external).
async function handleRouterModels(res) {
  try {
    const s = await llama.status(), models = loadouts.localModels();
    const list = loadouts.list().map((l) => {
      const run = s.loadout === l.id && s.state !== "stopped";
      const m = models.find((x) => x.name === l.model);
      return { id: l.id, status: run ? (s.state === "failed" ? "unloaded" : s.state) : "unloaded", failed: run && s.state === "failed", path: m ? m.model : l.modelPath || null };
    });
    for (const m of loadouts.cachedModels()) if (!list.some((x) => x.id === m.name)) list.push({ id: m.name, status: "unloaded", failed: false, path: m.path });
    sendJson(res, 200, { router: true, models: list });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
}

// POST /api/router/load|unload {model: <loadout id>}
async function handleRouterAction(req, res, action) {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: "Invalid JSON" }); }
  if (!body.model) return sendJson(res, 400, { error: "model is required" });
  try {
    if (action === "load") await preload(body.model); else await unloadLoadout(body.model);
    console.log(`[models] ${action} ${body.model}`);
    sendJson(res, 200, { ok: true });
  } catch (e) {
    sendJson(res, e.status || 500, { error: e.message });
  }
}

// ---- Chat history: one JSON file per chat in ./chats ----
for (const w of ws.list()) addRoot(w.dir); // each workspace's files folder is one of qqstudio's folders (served by /api/file)
const chatFile = (id) => ws.sessionFile(id); // sessions live in workspaces\<ws>\sessions\

// All chat-file writes go through one queue per file, so a run's saves and the page's edits (title, mode, ...)
// never read-modify-write over each other.
const chatQueues = new Map();
function updateChat(file, fn) {
  const next = (chatQueues.get(file) || Promise.resolve()).then(async () => {
    let cur = null;
    try { cur = JSON.parse(await fs.promises.readFile(file, "utf8")); } catch {}
    const out = await fn(cur);
    if (out) await writeChat(file, out);
    else if (!fs.existsSync(file)) ws.noteSession(file, null); // deleted
    return out;
  });
  const tail = next.catch(() => {});
  chatQueues.set(file, tail);
  tail.then(() => { if (chatQueues.get(file) === tail) chatQueues.delete(file); });
  return next;
}
// A tool may have written into a workspace (or anywhere): file lists are read again (watchers catch it on Windows and macOS).
const runToolSeen = async (...a) => { try { return await runTool(...a); } finally { ws.invalidateFiles(); } };
const runs = createRuns({ llama, runTool: runToolSeen, toolList, isEnabled, chatFile, updateChat, statusOf, modelState, visionOf, loadImage, imagePathsIn, uploadPath, getConfig, nCtx, nSlots, samplingFor: loadouts.samplingFor, ensureEngine, newSession: newSubSession,
  filesDirOf: (sid) => ws.filesDir(ws.workspaceOf(sid) || ws.DEFAULT), mcpCwd: (server) => mcp.cwdOf(server), mcpPaths: (server) => mcp.pathsMode(server),
  memoryWs: (sid) => { const w = ws.workspaceOf(sid) || ws.DEFAULT; return ws.memoryOn(w) ? w : null; }, externalEngine: () => !!process.env.LLAMA_URL,
  workspaceSessions: async (w) => (await ws.allSessions()).filter((x) => x.ws === w).map((x) => x.chat) });
// A sub-agent's session (runs.js run_agent): in its main session's workspace, marked with parent so the sidebar hides it.
async function newSubSession(parentId, data) {
  const id = parentId.slice(0, 30) + "s" + (Date.now().toString(36) + Math.random().toString(36).slice(2, 5)).slice(-7);
  const file = ws.placeSession(id, ws.workspaceOf(parentId));
  const now = Date.now();
  await updateChat(file, () => ({ id, workspace: ws.workspaceOf(id), parent: parentId, created: now, updated: now, ...data }));
  return id;
}

async function writeChat(file, obj) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`; // unique: runs and the page can save at once
  await fs.promises.writeFile(tmp, JSON.stringify(obj, null, 1), "utf8");
  await fs.promises.rename(tmp, file); // atomic replace
  ws.noteSession(file, obj); // the sessions list's index
}

// ---- Skills ----
const skills = require("./skills");
async function handleSkills(req, res) {
  const u = new URL(req.url, "http://x");
  try {
    if (req.method === "GET" && u.pathname === "/api/skills") return sendJson(res, 200, { dir: skills.dir, skills: skills.list() });
    if (req.method === "GET" && u.pathname === "/api/skills/get") {
      const s = skills.get(u.searchParams.get("name"));
      return s ? sendJson(res, 200, s) : sendJson(res, 404, { error: "No such skill" });
    }
    if (req.method === "PUT" && u.pathname === "/api/skills/enabled") {
      const b = JSON.parse(await readBody(req));
      skills.setEnabled(b.name, !!b.enabled);
      return sendJson(res, 200, { skills: skills.list() });
    }
    if (req.method === "POST" && u.pathname === "/api/skills/example") { skills.createExample(); return sendJson(res, 200, { skills: skills.list() }); }
    if (req.method === "POST" && u.pathname === "/api/skills/open") {
      const b = JSON.parse((await readBody(req)) || "{}");
      const target = (b.name && skills.list().find((x) => x.name === b.name)?.dir) || skills.dir;
      const err = await openFolder(target);
      return sendJson(res, err ? 500 : 200, err ? { error: err, path: target } : { ok: true });
    }
    sendJson(res, 404, { error: "Not found" });
  } catch (e) { sendJson(res, 400, { error: e.message }); }
}
// Opens a folder in the file manager of the machine qqstudio runs on. Resolves with null, or an error message (no file
// manager here, e.g. a Linux server without a desktop). Spawn errors arrive as an 'error' event; without a listener
// they would end the process.
function openFolder(dir) {
  const { spawn } = require("child_process");
  const cmd = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  return new Promise((resolve) => {
    let child, done = false;
    const end = (err) => { if (!done) { done = true; resolve(err); } };
    // no windowsHide: on Windows it would hide Explorer's window too
    try { child = spawn(cmd, [dir], { detached: true, stdio: "ignore" }); } catch (e) { return end(`Couldn't open a file manager (${e.message})`); }
    child.on("error", (e) => end(e.code === "ENOENT" ? `No file manager to open here (${cmd} is missing)` : `Couldn't open a file manager (${e.message})`));
    // explorer.exe exits with 1 even when it worked, so only xdg-open/open's exit code counts.
    child.on("exit", (code) => end(code && process.platform !== "win32" ? `Couldn't open a file manager (${cmd} exited with ${code})` : null));
    child.unref();
    setTimeout(() => end(null), 3000); // still running (some file managers stay attached): it opened
  });
}

// ---- Engines ----
// Engines are builds (nothing to start or stop here: loadouts run). GET/POST /api/engines · PATCH/DELETE /api/engines/<id>
// PUT /api/engines/options · GET /api/engines/releases · POST /api/engines/download · POST /api/engines/jobs/<id>/cancel · POST /api/engines/jobs/clear
async function handleEngines(req, res) {
  const parts = new URL(req.url, "http://x").pathname.split("/").slice(3).map(decodeURIComponent);
  const [a, b, c] = parts;
  const body = async () => JSON.parse((await readBody(req)) || "{}");
  try {
    if (!a) {
      if (req.method === "GET") return sendJson(res, 200, await llama.list());
      if (req.method === "POST") return sendJson(res, 200, { engine: llama.add(await body()) });
    }
    if (a === "options" && req.method === "PUT") { llama.setOptions(await body()); return sendJson(res, 200, await llama.list()); }
    if (a === "releases" && req.method === "GET") return sendJson(res, 200, await llama.releases());
    if (a === "strata" && b === "release" && req.method === "GET") return sendJson(res, 200, await llama.strataRelease());
    if (a === "strata" && b === "download" && req.method === "POST") return sendJson(res, 200, { job: await llama.downloadStrata(await body()) });
    if (a === "download" && req.method === "POST") return sendJson(res, 200, { job: await llama.download(await body()) });
    if (a === "jobs" && b === "clear" && req.method === "POST") { llama.clearJobs(); return sendJson(res, 200, { ok: true }); }
    if (a === "jobs" && c === "cancel" && req.method === "POST") { llama.cancel(b); return sendJson(res, 200, { ok: true }); }
    if (a && !llama.byId(a)) return sendJson(res, 404, { error: "No such engine" });
    if (a && b === "check" && req.method === "POST") // Strata: what an update would change; llama.cpp: the release list, fetched now
      return sendJson(res, 200, { check: llama.byId(a).type === "strata" ? await llama.checkStrata(a) : await llama.checkLlama(a) });
    if (a && b === "update" && req.method === "POST" && llama.byId(a).type !== "strata") { // a downloaded llama.cpp build: newer build of the same backend, swapped in place
      const beforeSwap = async () => { // eject its loadout for the swap, once no reply is using it (up to 10 min)
        for (let i = 0; llama.current().engine === a && busyCount(); i++) {
          if (i > 1200) throw new Error("A reply kept using this engine's loadout; try the update again");
          await new Promise((r) => setTimeout(r, 500));
        }
        if (llama.current().engine === a) await llama.stop();
      };
      return sendJson(res, 200, { job: await llama.updateLlama(a, { beforeSwap }) });
    }
    if (a && b === "update" && req.method === "POST") { // Strata: its own updater. A loaded Strata loadout is ejected first (Strata won't update while it serves)
      if (llama.current().engine === a) await unloadLoadout(null);
      return sendJson(res, 200, { job: await llama.updateStrata(a) });
    }
    if (a && b === "catalog" && req.method === "GET") return sendJson(res, 200, await llama.strataCatalog(a, new URL(req.url, "http://x").searchParams.has("fresh")));
    if (a && !b) {
      if (req.method === "PATCH") return sendJson(res, 200, { engine: llama.update(a, await body()) });
      if (req.method === "DELETE") { if (llama.current().engine === a) await unloadLoadout(null); await llama.remove(a); return sendJson(res, 200, { ok: true }); }
    }
    sendJson(res, 405, { error: "Method not allowed" });
  } catch (e) {
    sendJson(res, e.status || 500, { error: e.message });
  }
}

// ---- Loadouts ----
// Models in llama.cpp's download cache (-hf) that aren't in the models folder ("external"). A loadout uses one by its
// file path, or else by its Hugging Face name (hf-repo).
async function externalModels() {
  const local = new Set(loadouts.localModels().map((m) => m.name)), los = new Set(loadouts.list().map((l) => l.id));
  return loadouts.cachedModels().filter((m) => !local.has(m.name) && !los.has(m.name));
}
// The page sends only the model's name; where an external model's file is comes from the engine, never from the page.
async function withSource(input, prev) {
  delete input.modelPath; delete input.hfRepo;
  const model = typeof input.model === "string" ? input.model : prev?.model;
  if (!model || loadouts.localModels().some((m) => m.name === model)) { input.modelPath = ""; input.hfRepo = ""; return input; }
  const ext = (await externalModels()).find((m) => m.name === model);
  if (ext) {
    if (ext.path && /\.gguf$/i.test(ext.path)) { input.modelPath = ext.path; input.hfRepo = ""; }
    else if (/^[\w.-]+\/[\w.-]+(:[\w.-]+)?$/.test(ext.name)) { input.modelPath = ""; input.hfRepo = ext.name; }
    else throw Object.assign(new Error(`Can't tell where the file for "${model}" is.`), { status: 400 });
  } // not in the cache now: an existing loadout keeps the source it had
  return input;
}
// GET/POST /api/loadouts · PUT/DELETE /api/loadouts/<id> · GET /api/loadouts/<id>/preview|log · POST /api/loadouts/<id>/load|unload
async function handleLoadouts(req, res) {
  const id = decodeURIComponent(new URL(req.url, "http://x").pathname.split("/")[3] || "");
  const sub = new URL(req.url, "http://x").pathname.split("/")[4];
  try {
    if (!id && req.method === "GET") {
      const engs = [];
      for (const e of llama.all()) engs.push({ id: e.id, name: e.name, type: e.type || "llama.cpp", active: e.id === llama.defaultEngine()?.id, support: await loadouts.fieldSupport(e) });
      return sendJson(res, 200, { loadouts: loadouts.list(), fields: loadouts.FIELDS, sampling: loadouts.SAMPLING, engines: engs,
        models: loadouts.localModels().map((m) => ({ name: m.name, mmproj: !!m.mmproj, size: m.size, maxCtx: loadouts.trainedContext(m.model) })),
        external: (await externalModels()).map((m) => ({ name: m.name, external: true })), defaultCtx: loadouts.DEFAULT_CTX, running: await llama.status(),
        strataFields: loadouts.STRATA_FIELDS, strataModels: (strataCatalogNow(), loadouts.strataModels().map((m) => m.name)) });
    }
    if (id && sub === "preview" && req.method === "GET") { const l = loadouts.get(id); if (!l) return sendJson(res, 404, { error: "No such loadout" }); return sendJson(res, 200, { cmd: loadouts.commandLine(l) }); }
    if (id && sub === "log" && req.method === "GET") { res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }); return res.end(llama.log(id)); }
    if (id && (sub === "load" || sub === "unload") && req.method === "POST") { if (sub === "load") await preload(id); else await unloadLoadout(id); return sendJson(res, 200, { ok: true, running: await llama.status() }); }
    const apply = async () => { const r = await regenPresets(); return { restarted: r.restarted, restartNeeded: r.restartNeeded }; }; // reloads the running loadout if it changed
    if (!id && req.method === "POST") { const l = loadouts.create(await withSource(JSON.parse((await readBody(req)) || "{}"))); return sendJson(res, 200, { loadout: l, ...(await apply(l.engine)) }); }
    if (id && !sub && req.method === "PUT") {
      const prev = loadouts.get(id);
      const l = loadouts.update(id, await withSource(JSON.parse((await readBody(req)) || "{}"), prev));
      return sendJson(res, 200, { loadout: l, ...(await apply()) });
    }
    if (id && !sub && req.method === "DELETE") { const l = loadouts.get(id); loadouts.remove(id); return sendJson(res, 200, { ok: true, ...(l ? await apply() : {}) }); }
    sendJson(res, 405, { error: "Method not allowed" });
  } catch (e) {
    sendJson(res, e.status || 500, { error: e.message });
  }
}

// ---- Workspaces ----
// GET/POST /api/workspaces · PATCH/DELETE /api/workspaces/<id> · GET/POST /api/workspaces/<id>/files
// GET/DELETE /api/workspaces/<id>/files/<path> · POST /api/workspaces/<id>/open
const MAX_FILE = 1024 * 1024 * 1024; // 1 GB per dropped file
const FILE_MIME = { ...IMG_MIME, svg: "image/svg+xml", ico: "image/x-icon", json: "application/json; charset=utf-8", txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8", csv: "text/plain; charset=utf-8", log: "text/plain; charset=utf-8", lua: "text/plain; charset=utf-8",
  js: "text/plain; charset=utf-8", py: "text/plain; charset=utf-8", html: "text/plain; charset=utf-8", pdf: "application/pdf" };
async function handleWorkspaces(req, res) {
  const u = new URL(req.url, "http://x");
  const parts = u.pathname.split("/").slice(3).map(decodeURIComponent); // after /api/workspaces
  const [id, sub] = parts, rest = parts.slice(2).join("/");
  try {
    if (!id) {
      if (req.method === "GET") return sendJson(res, 200, { workspaces: ws.list(), default: ws.DEFAULT });
      if (req.method === "POST") { const w = ws.create(JSON.parse((await readBody(req)) || "{}")); addRoot(w.dir); return sendJson(res, 200, { workspace: w }); }
      return sendJson(res, 405, { error: "Method not allowed" });
    }
    if (!ws.exists(id)) return sendJson(res, 404, { error: "No such workspace" });
    if (!sub) {
      if (req.method === "GET") return sendJson(res, 200, { workspace: ws.info(id) });
      if (req.method === "PATCH") return sendJson(res, 200, { workspace: ws.update(id, JSON.parse((await readBody(req)) || "{}")) });
      if (req.method === "DELETE") {
        const dir = ws.filesDir(id);
        const inWs = (await ws.allSessions()).filter((x) => x.ws === id).map((x) => x.chat.id);
        for (const s of inWs) runs.deleted(s); // stop replies in progress there
        await new Promise((r) => setTimeout(r, inWs.some((s) => runs.has(s)) ? 300 : 0));
        await ws.remove(id);
        removeRoot(dir);
        return sendJson(res, 200, { ok: true, deleted: inWs.length });
      }
      return sendJson(res, 405, { error: "Method not allowed" });
    }
    // ?dir=<folder in the files folder>: open / upload into that folder (the files view's current folder)
    const subDir = u.searchParams.get("dir") ? ws.filePath(id, u.searchParams.get("dir")) : ws.filesDir(id);
    if (!subDir) return sendJson(res, 400, { error: "Bad folder" });
    if (sub === "memory" && req.method === "POST") { // {ops: [{op: "add"|"replace"|"remove", section, id, text}]}, applied like the model's changes
      const M = require("./memory"), b = JSON.parse((await readBody(req)) || "{}");
      const r = await M.apply(id, Array.isArray(b.ops) ? b.ops : [], { cap: Math.max(200, Number(getConfig().memoryTokens) || M.DEFAULT_CAP) });
      M.log(id, `edit (API) · ${r.done.join(", ") || "nothing"}${r.refused.length ? ` · refused: ${r.refused.join("; ")}` : ""}`);
      return sendJson(res, 200, { ...r, text: M.text(id) });
    }
    if (sub === "memory" && req.method === "GET") { const M = require("./memory"); return sendJson(res, 200, { on: ws.memoryOn(id), text: M.text(id), stats: M.stats(id), ...(u.searchParams.has("log") ? { log: M.readLog(id) } : {}) }); } // workspace memory (memory.js); ?log adds memory.log
    if (sub === "open" && req.method === "POST") {
      const target = fs.existsSync(subDir) ? subDir : ws.filesDir(id), err = await openFolder(target);
      return sendJson(res, err ? 500 : 200, err ? { error: err, path: target } : { ok: true });
    }
    if (sub !== "files") return sendJson(res, 404, { error: "Not found" });
    if (req.method !== "GET") res.on("finish", () => ws.invalidateFiles(id)); // uploads and deletes: the list shows them now
    if (!rest) {
      if (req.method === "GET") return sendJson(res, 200, { dir: ws.filesDir(id), files: await ws.files(id) });
      if (req.method === "POST") { // raw body; ?name=<file name>
        const name = ws.freeName(id, u.searchParams.get("name"), subDir);
        const dest = path.join(subDir, name), part = dest + ".part";
        await fs.promises.mkdir(subDir, { recursive: true });
        let size = 0, tooBig = false;
        await new Promise((resolve, reject) => {
          const out = fs.createWriteStream(part);
          req.on("data", (c) => { size += c.length; if (size > MAX_FILE && !tooBig) { tooBig = true; req.unpipe(out); out.destroy(); resolve(); } });
          req.pipe(out); out.on("finish", resolve); out.on("error", reject); req.on("error", reject);
        });
        if (tooBig) { await fs.promises.unlink(part).catch(() => {}); return sendJson(res, 413, { error: "File is larger than 1 GB" }); }
        await fs.promises.rename(part, dest);
        return sendJson(res, 200, { path: path.relative(ws.filesDir(id), dest).split(path.sep).join("/"), size });
      }
      return sendJson(res, 405, { error: "Method not allowed" });
    }
    const file = ws.filePath(id, rest);
    if (!file) return sendJson(res, 400, { error: "Bad file path" });
    if (req.method === "GET") {
      const st = await fs.promises.stat(file).catch(() => null);
      if (!st || !st.isFile()) return sendJson(res, 404, { error: "Not found" });
      const type = FILE_MIME[path.extname(file).slice(1).toLowerCase()];
      const disp = (type && u.searchParams.get("download") !== "1" ? "inline" : "attachment") + `; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`;
      res.writeHead(200, { "Content-Type": type || "application/octet-stream", "Content-Length": st.size, "Content-Disposition": disp,
        "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox", "Cache-Control": "no-cache" });
      return fs.createReadStream(file).pipe(res);
    }
    if (req.method === "DELETE") {
      await fs.promises.unlink(file);
      for (let d = path.dirname(file); d !== ws.filesDir(id) && d.startsWith(ws.filesDir(id)); d = path.dirname(d)) { // tidy empty subfolders
        try { await fs.promises.rmdir(d); } catch { break; }
      }
      return sendJson(res, 200, { ok: true });
    }
    sendJson(res, 405, { error: "Method not allowed" });
  } catch (e) {
    sendJson(res, e.status || (e.code === "ENOENT" ? 404 : 500), { error: e.message });
  }
}

// ---- Context size of a loaded model (best effort; never triggers a load) ----
// Only the running loadout can answer (a loadout's own process); anything else would report another model's numbers.
async function modelProps(model, pick) {
  if (!process.env.LLAMA_URL && loadouts.get(model) && llama.current().loadout !== model) return null;
  for (const u of [`${llama.url()}/props`]) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(2000) });
      if (!r.ok) continue;
      const n = pick(await r.json());
      if (n) return n;
    } catch {}
  }
  return null;
}
// Strata's catalog as last known (the first Strata engine's), for lists that answer at once; refreshed in the background.
function strataCatalogNow() {
  const e = llama.all().find((x) => x.type === "strata");
  if (!e) return null;
  const c = llama.strataCatalogCached(e.id);
  if (!c || !c.files?.[0]?.sizes || Date.now() - c.at > 24 * 3600e3) llama.strataCatalog(e.id, !!c).catch(() => {}); // (an older cache has no file list)
  return c ? { engine: e.id, rows: c.rows, files: c.files || [], computer: c.computer, error: c.error } : { engine: e.id, rows: [], files: [], loading: true };
}
// Strata answers /props in llama-server's shape too (the context it actually fitted, its batch slots); its loadout's
// settings stand in only while it can't answer.
const strataSetting = (model, key) => { const l = loadouts.get(model); return l && loadouts.isStrata(l.engine) ? Number(l.load?.[key]) || null : undefined; };
const ctxPick = (j) => j.default_generation_settings?.n_ctx || j.n_ctx || j.default_generation_settings?.params?.n_ctx;
async function nCtx(model) {
  const n = await modelProps(model, ctxPick);
  return n || strataSetting(model, "ctx-size") || null;
}
// Parallel slots of the loaded model (llama-server --parallel); each keeps its own prompt cache.
async function nSlots(model) { return (await modelProps(model, (j) => j.total_slots)) || strataSetting(model, "parallel") || null; }
// For the page's context meter: the running engine's own figure (exact), or, while the loadout isn't loaded, the context
// size in its settings (any engine; blank means the model's trained context, unknown until it loads).
async function handleCtx(req, res) {
  const model = new URL(req.url, "http://x").searchParams.get("model") || "";
  const live = await modelProps(model, ctxPick), l = loadouts.get(model);
  sendJson(res, 200, { n_ctx: live || (l && Number(l.load?.["ctx-size"])) || null, exact: !!live });
}

// ---- MCP servers ----
const mcp = require("./mcp");
async function handleMcp(req, res) {
  const u = new URL(req.url, "http://x");
  try {
    if (req.method === "GET" && u.pathname === "/api/mcp") return sendJson(res, 200, { path: mcp.path, raw: mcp.rawConfig(), servers: mcp.status(), example: mcp.EXAMPLE });
    if (req.method === "GET" && u.pathname === "/api/mcp/log") { res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }); return res.end(mcp.log(u.searchParams.get("name"))); }
    if (req.method === "PUT" && u.pathname === "/api/mcp") { await mcp.saveRaw(JSON.parse(await readBody(req)).raw); return sendJson(res, 200, { servers: mcp.status() }); }
    if (req.method === "POST" && u.pathname === "/api/mcp/restart") { await mcp.restart(JSON.parse(await readBody(req)).name); return sendJson(res, 200, { servers: mcp.status() }); }
    if (req.method === "PUT" && u.pathname === "/api/mcp/paths") { // {name, mode: "workspace"|"as-given"}
      const b = JSON.parse(await readBody(req));
      mcp.setPaths(b.name, b.mode);
      return sendJson(res, 200, { servers: mcp.status() });
    }
    if (req.method === "PUT" && u.pathname === "/api/mcp/enabled") {
      const b = JSON.parse(await readBody(req));
      await mcp.setEnabled(b.name, !!b.enabled);
      return sendJson(res, 200, { servers: mcp.status() });
    }
    sendJson(res, 404, { error: "Not found" });
  } catch (e) { sendJson(res, 400, { error: e.message }); }
}

// Tools on request (lazytools.js): the threshold and each MCP server's estimated size, for the pages.
const lazyInfo = () => ({ lazyAt: lazyTools.threshold(getConfig()), serverTokens: lazyTools.serverTokens(toolList()) });
// ---- General user config (config.json) ----
// Effort (a hint the chat template reads) and thinking budget (a token cap) are separate. budgets: the three fixed caps a
// session's Thinking menu offers (1k / 4k / 16k); effort / budget: what new sessions start at.
const THINK_DEFAULTS = { budgets: { low: 1024, medium: 4096, high: 16384 }, message: "", effort: "medium", budget: "unlimited" };
const EFFORTS = ["default", "off", "low", "medium", "high", "max"]; // "default" is shown as Auto (nothing sent)
const BUDGETS = ["auto", "off", "low", "medium", "high", "unlimited"]; // low/medium/high: the caps in budgets
const CONFIG_DEFAULTS = { modelsFolder: DATA.models, replyTokens: 16384, compactAt: 90, maskSecrets: true, lazyToolsAt: 3000, memoryTokens: 2000, midTurn: "steer" }; // memoryTokens: workspace memory cap; midTurn: what a message sent during a reply does (steer, queue or interrupt)
const AGENT_DEFAULTS = { maxActive: 1, reportWords: 300, instructions: "" }; // Settings > Agents // replyTokens: output cap per model call (0 = none); compactAt: % of the context window that triggers compaction (0 = off)
function getConfig() {
  const c = DATA.readJson(DATA.config, {});
  const t = c.thinking || {};
  delete c.lanAccess; delete c.lanKey; // served by /api/server (local requests only)
  return { ...CONFIG_DEFAULTS, ...c, agents: { ...AGENT_DEFAULTS, ...(c.agents || {}) }, version: require("./package.json").version, thinking: { budgets: THINK_DEFAULTS.budgets, message: t.message ?? THINK_DEFAULTS.message,
    effort: EFFORTS.includes(t.effort) ? t.effort : EFFORTS.includes(t.level) ? t.level : THINK_DEFAULTS.effort, budget: BUDGETS.includes(t.budget) ? t.budget : THINK_DEFAULTS.budget }, dataDir: DATA.home };
}
async function handleConfig(req, res) {
  if (req.method === "GET") return sendJson(res, 200, getConfig());
  if (req.method === "PUT") {
    let patch;
    try { patch = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: "Invalid JSON" }); }
    const cur = DATA.readJson(DATA.config, {});
    if (typeof patch.modelsFolder === "string") cur.modelsFolder = patch.modelsFolder.trim();
    if (typeof patch.maskSecrets === "boolean") cur.maskSecrets = patch.maskSecrets;
    if (patch.agents && typeof patch.agents === "object") {
      const a = { ...AGENT_DEFAULTS, ...(cur.agents || {}) }, p = patch.agents, int = (v, lo, hi) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null; };
      if (p.maxActive !== undefined && int(p.maxActive, 1, 8) !== null) a.maxActive = int(p.maxActive, 1, 8);
      if (p.reportWords !== undefined && int(p.reportWords, 50, 3000) !== null) a.reportWords = int(p.reportWords, 50, 3000);
      if (typeof p.instructions === "string") a.instructions = p.instructions.slice(0, 4000);
      cur.agents = a;
    }
    if ("compactAt" in patch) { const v = patch.compactAt === "" || patch.compactAt == null ? 0 : Math.round(Number(patch.compactAt)); if (Number.isFinite(v) && v >= 0 && v <= 99) cur.compactAt = v; }
    if (["steer", "queue", "interrupt"].includes(patch.midTurn)) cur.midTurn = patch.midTurn;
    if ("memoryTokens" in patch) { const v = Math.round(Number(patch.memoryTokens)); if (Number.isFinite(v) && v >= 200 && v <= 20000) cur.memoryTokens = v; }
    if ("lazyToolsAt" in patch) { const v = patch.lazyToolsAt === "" || patch.lazyToolsAt == null ? 0 : Math.round(Number(patch.lazyToolsAt)); if (Number.isFinite(v) && v >= 0) cur.lazyToolsAt = v; }
    if ("replyTokens" in patch) { const v = patch.replyTokens === "" || patch.replyTokens == null ? 0 : Math.round(Number(patch.replyTokens)); if (Number.isFinite(v) && v >= 0) cur.replyTokens = v; }
    if (patch.thinking && typeof patch.thinking === "object") {
      const t = cur.thinking || {};
      cur.thinking = { message: typeof patch.thinking.message === "string" ? patch.thinking.message : t.message || "",
        effort: EFFORTS.includes(patch.thinking.effort) ? patch.thinking.effort : t.effort ?? t.level,
        budget: BUDGETS.includes(patch.thinking.budget) ? patch.thinking.budget : t.budget };
    }
    DATA.writeJson(DATA.config, cur);
    return sendJson(res, 200, getConfig());
  }
  sendJson(res, 405, { error: "Method not allowed" });
}

async function handleChats(req, res) {
  const id = (req.url.split("?")[0].match(/^\/api\/chats\/?([^/]*)$/) || [])[1];
  try {
    if (!id) {
      if (req.method !== "GET") return sendJson(res, 405, { error: "Method not allowed" });
      const list = [];
      for (const { ws: w, chat: c } of await ws.listSessions())
        if (!c.parent) list.push({ id: c.id, title: c.title, updated: c.updated, model: c.model, workspace: w, running: runs.has(c.id), settling: runs.settling(c.id), waiting: runs.waiting(c.id), unread: !!c.unread }); // sub-agent sessions open from their chip
      list.sort((a, b) => (b.updated || 0) - (a.updated || 0));
      return sendJson(res, 200, { chats: list });
    }
    const file = chatFile(id);
    if (!file) return sendJson(res, 400, { error: "Bad chat id" });
    if (req.method === "GET") {
      const data = await fs.promises.readFile(file, "utf8").catch(() => null);
      if (data === null) return sendJson(res, 404, { error: "Chat not found" });
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(data);
    }
    if (req.method === "PUT") {
      if (runs.has(id)) return sendJson(res, 409, { error: "A reply is in progress in this chat; stop it first." });
      const c = JSON.parse(await readBody(req));
      c.id = id;
      const placed = ws.placeSession(id, c.workspace); // a new session goes into the workspace it names (else Default)
      c.workspace = ws.workspaceOf(id);
      await updateChat(placed, (disk) => { if (!Array.isArray(c.loaded) && Array.isArray(disk?.loaded)) c.loaded = disk.loaded; if (!Array.isArray(c.promoted) && Array.isArray(disk?.promoted)) c.promoted = disk.promoted; if (!Array.isArray(c.todo) && Array.isArray(disk?.todo)) c.todo = disk.todo; if (typeof c.memory !== "string" && typeof disk?.memory === "string") c.memory = disk.memory; if (disk?.titled && !c.titled) { c.title = disk.title; c.titled = true; } return c; }); // keep groups the model turned on, tools given full details
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "PATCH") {
      const patch = JSON.parse(await readBody(req));
      const done = await updateChat(file, (c) => {
        if (!c) return null;
        if (typeof patch.title === "string") { c.title = patch.title.slice(0, 200); c.titled = true; } // the user's title: never replaced by an automatic one
        if (patch.unread === false) delete c.unread;
        if (patch.mode === "manual" || patch.mode === "auto") c.mode = patch.mode;
        if (typeof patch.model === "string") c.model = patch.model;
        for (const k of ["skills", "mcp", "cats"]) if (patch[k] && typeof patch[k] === "object") c[k] = patch[k];
        if (Array.isArray(patch.loaded)) c.loaded = patch.loaded.filter((x) => typeof x === "string");
        if (EFFORTS.includes(patch.think)) c.think = patch.think; // before effort/thinkBudget were separate
        if (EFFORTS.includes(patch.effort)) c.effort = patch.effort;
        if (BUDGETS.includes(patch.thinkBudget)) c.thinkBudget = patch.thinkBudget;
        return c;
      });
      if (!done) return sendJson(res, 404, { error: "Chat not found" });
      if (patch.mode) runs.modeChanged(id, patch.mode); // after saving, so a waiting approval sees the new mode
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "DELETE") {
      for (const { chat: s } of await ws.listSessions()) if (s.parent === id) { // its sub-agents' sessions go with it
        runs.deleted(s.id);
        const f = chatFile(s.id);
        if (f) await updateChat(f, async () => { await fs.promises.unlink(f).catch(() => {}); return null; });
        ws.forgetSession(s.id);
      }
      runs.deleted(id);
      await updateChat(file, async () => { await fs.promises.unlink(file).catch(() => {}); return null; }); // queued behind any save in flight
      ws.forgetSession(id);
      return sendJson(res, 200, { ok: true });
    }
    sendJson(res, 405, { error: "Method not allowed" });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
}

// ---- Installed model files (models folder only) ----
const SHARD_RE = /-(\d{5})-of-(\d{5})\.gguf$/i;
function insideFolder(root, p) { const rel = path.relative(root, p); return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel); }
// Every file that belongs to a model: all shards, plus its mmproj when no other model in that folder uses it.
function modelFiles(m, all) {
  const dir = path.dirname(m.model), first = path.basename(m.model), shard = first.match(SHARD_RE);
  let files = [m.model];
  if (shard) {
    const prefix = first.slice(0, shard.index).toLowerCase();
    try { files = fs.readdirSync(dir).filter((n) => { const x = n.match(SHARD_RE); return x && x[2] === shard[2] && n.slice(0, x.index).toLowerCase() === prefix; }).map((n) => path.join(dir, n)); } catch {}
  }
  if (m.mmproj && !all.some((o) => o !== m && path.dirname(o.model) === dir)) files.push(m.mmproj);
  const size = files.reduce((t, f) => { try { return t + fs.statSync(f).size; } catch { return t; } }, 0);
  return { files, size };
}
async function handleLocalModels(req, res) {
  const root = path.resolve(getConfig().modelsFolder);
  const all = presets.list(root);
  const off = presets.visionOff();
  if (req.method === "GET" && req.url === "/api/models/local")
    return sendJson(res, 200, { folder: root, models: all.map((m) => ({ id: m.name, path: m.model, mmproj: !!m.mmproj, vision: !!m.mmproj && !off.has(m.name), ...modelFiles(m, all) })) });
  if (req.method === "POST" && req.url === "/api/models/vision") {
    let b; try { b = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: "Invalid JSON" }); }
    const m = all.find((x) => x.name === b.id);
    if (!m || !m.mmproj) return sendJson(res, 404, { error: "That model has no vision projector (mmproj) in its folder." });
    presets.setVision(m.name, b.on === true);
    for (const l of loadouts.list().filter((x) => x.model === m.name)) loadouts.update(l.id, { vision: b.on === true });
    const { restarted } = await regenPresets();
    console.log(`[models] vision ${b.on ? "on" : "off"} for ${m.name}${restarted ? " (engine restarted)" : ""}`);
    return sendJson(res, 200, { vision: b.on === true, restarted });
  }
  if (req.method !== "POST" || req.url !== "/api/models/delete") return sendJson(res, 405, { error: "Method not allowed" });
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: "Invalid JSON" }); }
  const m = all.find((x) => x.name === body.id);
  if (!m) return sendJson(res, 404, { error: `"${body.id}" isn't in the models folder (${root}).` });
  const { files, size } = modelFiles(m, all);
  if (!files.every((f) => insideFolder(root, f))) return sendJson(res, 400, { error: "Refusing to delete files outside the models folder." });
  // Unload first so Windows lets go of the file: stop the running loadout if it uses this model (or as its draft).
  const runLo = loadouts.get(llama.current().loadout);
  if (runLo && (runLo.model === m.name || runLo.load?.["model-draft"] === m.name)) {
    try { await unloadLoadout(runLo.id); } catch (e) { return sendJson(res, e.status || 500, { error: `${runLo.name} is using this model: ${e.message}` }); }
  }
  const deleted = [];
  try {
    presets.invalidate(); // even if a file can't be deleted, the list is read again
    for (const f of files) {
      for (let tries = 0; ; tries++) { // a just-unloaded model can stay locked for a moment
        try { await fs.promises.rm(f, { force: true }); break; }
        catch (e) { if (tries >= 8 || !/EBUSY|EPERM|EACCES/.test(e.code || "")) throw e; await new Promise((r) => setTimeout(r, 500)); }
      }
      deleted.push(f);
    }
  } catch (e) {
    console.error(`[models] delete ${m.name} failed: ${e.message}`);
    return sendJson(res, 500, { error: `Could not delete ${path.basename(e.path || "")}: ${e.message}`, deleted });
  }
  // Remove folders the model leaves empty, up to (not including) the models folder.
  for (let d = path.dirname(m.model); insideFolder(root, d); d = path.dirname(d)) { try { fs.rmdirSync(d); } catch { break; } }
  console.log(`[models] deleted ${m.name}: ${deleted.length} file(s), ${(size / 1e9).toFixed(2)} GB`);
  loadouts.removeForModel(m.name); // its loadouts go with it
  const { restarted } = await regenPresets();
  sendJson(res, 200, { deleted, size, restarted });
}

// ---- Hugging Face search / download ----
async function handleHf(req, res) {
  const u = new URL(req.url, "http://x");
  try {
    // Strata tags: repos its catalog downloads from, and the file sets it lists (exact paths and sizes, from strata_catalog.py).
    if (req.method === "GET" && u.pathname === "/api/hf/search") {
      strataCatalogNow();
      return sendJson(res, 200, { models: (await hf.search(u.searchParams.get("q"))).map((m) => (loadouts.strataRepo(m.id) ? { ...m, strata: true } : m)) });
    }
    if (req.method === "GET" && u.pathname === "/api/hf/files") {
      const repo = u.searchParams.get("repo");
      return sendJson(res, 200, { files: (await hf.files(repo, u.searchParams.get("folder"))).map((g) => { const t = loadouts.strataFiles(repo, g); delete g.sizes; return t ? { ...g, strata: t } : g; }) });
    }
    if (req.method === "GET" && u.pathname === "/api/hf/downloads") return sendJson(res, 200, { jobs: hf.list() });
    if (req.method === "POST" && u.pathname === "/api/hf/download") return sendJson(res, 200, { ids: hf.startDownload(JSON.parse(await readBody(req))) });
    if (req.method === "POST" && u.pathname === "/api/hf/cancel") { hf.cancel(JSON.parse(await readBody(req)).id); return sendJson(res, 200, { ok: true }); }
    if (req.method === "POST" && u.pathname === "/api/hf/clear") { hf.clearFinished(); return sendJson(res, 200, { ok: true }); }
    if (req.method === "GET" && u.pathname === "/api/hf/presets") return sendJson(res, 200, presets.info(u.searchParams.get("folder")));
    if (req.method === "POST" && u.pathname === "/api/hf/presets") {
      JSON.parse((await readBody(req)) || "{}");
      return sendJson(res, 200, { ...presets.info(getConfig().modelsFolder), ...(await regenPresets()) });
    }
    sendJson(res, 404, { error: "Not found" });
  } catch (e) {
    sendJson(res, 400, { error: e.message });
  }
}

// ---- the loadout process (older routes; Settings uses /api/loadouts and /api/engines) ----
async function handleLlama(req, res) {
  const u = new URL(req.url, "http://x");
  try {
    if (req.method === "GET" && u.pathname === "/api/llama/status") return sendJson(res, 200, await llama.status());
    if (req.method === "GET" && u.pathname === "/api/llama/log") { res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }); return res.end(llama.log()); }
    if (req.method === "POST" && u.pathname === "/api/llama/stop") { await unloadLoadout(null); return sendJson(res, 200, await llama.status()); }
    sendJson(res, 404, { error: "Not found" });
  } catch (e) {
    sendJson(res, e.status || 500, { error: e.message });
  }
}

async function handleChat(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "Invalid JSON" });
  }
  const controller = new AbortController();
  res.on("close", () => controller.abort()); // stop generation if browser disconnects / Stop pressed

  let upstream;
  try {
    upstream = await fetch(`${llama.url()}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, stream: true }),
      signal: controller.signal,
    });
  } catch (e) {
    if (controller.signal.aborted) return;
    return sendJson(res, 502, { error: `Cannot reach llama-server: ${e.message}` });
  }

  if (!upstream.ok) {
    const text = await upstream.text();
    return sendJson(res, upstream.status, { error: text });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  try {
    for await (const chunk of upstream.body) res.write(chunk);
  } catch (e) {
    if (!controller.signal.aborted) console.error("stream error:", e.message);
  }
  res.end();
}

function serveStatic(req, res) {
  const urlPath = req.url.split("?")[0];
  const file = path.normalize(path.join(PUBLIC, urlPath === "/" ? "index.html" : urlPath));
  if (!file.startsWith(PUBLIC)) return sendJson(res, 403, { error: "Forbidden" });
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: "Not found" });
    const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".ico": "image/x-icon", ".svg": "image/svg+xml", ".json": "application/json" };
    const ext = path.extname(file).toLowerCase();
    if (HOT && ext === ".html") data = Buffer.from(data.toString("utf8").replace(/<\/body>/i, RELOAD_SNIPPET + "</body>"));
    res.writeHead(200, {
      "Content-Type": (types[ext] || "application/octet-stream") + (/^(text|application\/json)/.test(types[ext] || "") ? "; charset=utf-8" : ""),
      ...(HOT ? { "Cache-Control": "no-store" } : {}),
    });
    res.end(data);
  });
}

// ---- Request guard ----
// Blocks other websites from driving this API (cross-site POSTs) and DNS-rebinding attacks.
const exposed = () => HOST !== "127.0.0.1" && HOST !== "localhost";
const isLoopback = (a) => /^(127\.|::1$|::ffff:127\.)/.test(a || "");
// Host header check against DNS rebinding: localhost always; when exposed, also IP literals and this PC's name.
function hostOk(host) {
  const h = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  if (/^(localhost|127\.0\.0\.1|::1)$/.test(h)) return true;
  if (!exposed()) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":")) return true;
  const name = os.hostname().toLowerCase();
  return h === name || h === name + ".local" || h === name + ".lan" || h === name + ".home" || !!process.env.HOST;
}
function allowedRequest(req) {
  const host = (req.headers.host || "").toLowerCase();
  if (!hostOk(host)) return false;
  if (req.method === "GET" || req.method === "HEAD") return true;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients (curl) on this machine
  try { return new URL(origin).host.toLowerCase() === host; } catch { return false; }
}

// ---- Local network access ----
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces()))
    for (const a of list || []) if ((a.family === "IPv4" || a.family === 4) && !a.internal && !a.address.startsWith("169.254.")) out.push({ name, ip: a.address });
  return out;
}
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const LOCKED_HTML = `<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>qqstudio</title>
<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0f1115;color:#e6e8ee;font:15px/1.5 system-ui,sans-serif;text-align:center;padding:20px">
<div><h2 style="font-weight:600">qqstudio needs an access key</h2><p style="color:#8a91a3">On the computer running qqstudio, open <b>Settings → Server</b><br>and use the link shown there (it includes the key).</p></div></body>`;
// Requests from other devices need the access key: once via ?key=… (sets a cookie), then the cookie.
// Returns true when it has answered the request itself.
function remoteGate(req, res) {
  const local = isLoopback(req.socket.remoteAddress);
  if (local && !req.url.includes("key=")) return false;
  const { key } = lanCfg();
  const u = new URL(req.url, "http://x"), given = u.searchParams.get("key");
  if (given != null && req.method === "GET" && (local || safeEq(given, key))) { // the link also works on this computer
    u.searchParams.delete("key");
    const h = { Location: u.pathname + u.search, "Cache-Control": "no-store" };
    if (safeEq(given, key)) h["Set-Cookie"] = `qq_key=${encodeURIComponent(key)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`;
    res.writeHead(302, h); res.end(); return true;
  }
  if (local) return false;
  const ck = (req.headers.cookie || "").match(/(?:^|;\s*)qq_key=([^;]*)/);
  if (ck && safeEq(decodeURIComponent(ck[1]), key)) return false;
  console.log(`[lan] refused ${req.socket.remoteAddress} ${req.method} ${u.pathname} (no or wrong key)`);
  if (u.pathname.startsWith("/api/") || u.pathname === "/__reload") sendJson(res, 401, { error: "Access key required" });
  else { res.writeHead(401, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); res.end(LOCKED_HTML); }
  return true;
}
function serverInfo(local) {
  const { enabled, key } = lanCfg();
  const info = { lan: enabled, host: HOST, port: PORT, listening: !!server.listening, envHost: process.env.HOST || null, exposed: exposed(), local, hostname: os.hostname() };
  if (local) {
    info.key = key;
    info.addresses = exposed() ? lanAddresses().map((a) => ({ ...a, url: `http://${a.ip}:${PORT}/` })) : [];
  }
  return info;
}
async function handleServer(req, res) {
  const local = isLoopback(req.socket.remoteAddress);
  if (req.method === "GET") return sendJson(res, 200, serverInfo(local));
  if (req.method !== "PUT") return sendJson(res, 405, { error: "Method not allowed" });
  if (!local) return sendJson(res, 403, { error: "Server settings can only be changed on the computer running qqstudio." });
  let patch;
  try { patch = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: "Invalid JSON" }); }
  const cur = DATA.readJson(DATA.config, {});
  if (typeof patch.lan === "boolean") cur.lanAccess = patch.lan;
  if (patch.newKey) cur.lanKey = crypto.randomBytes(12).toString("base64url");
  DATA.writeJson(DATA.config, cur);
  const next = wantHost(), rebinding = next !== HOST;
  sendJson(res, 200, { ...serverInfo(true), rebinding });
  if (rebinding) setTimeout(() => rebind(next), 150);
}

async function handleTool(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: "Invalid JSON" }); }
  const t0 = Date.now();
  if (!isEnabled(body.name)) return sendJson(res, 200, { result: `ERROR: the tool "${body.name}" is disabled in Settings > Tools.`, images: [] });
  // Server-side approval check: tools marked "Ask first" need explicit approval unless the chat is in Auto mode.
  const spec = toolList().find((t) => t.name === body.name);
  if (spec && spec.approval && body.approved !== true) {
    let mode = "manual";
    const f = chatFile(body.chatId);
    if (f) try { mode = JSON.parse(fs.readFileSync(f, "utf8")).mode || "manual"; } catch {}
    if (mode !== "auto") return sendJson(res, 200, { result: `ERROR: "${body.name}" needs the user's approval.`, images: [] });
  }
  const out = await runToolSeen(body.name, body.args, { base: ws.filesDir((body.chatId && ws.workspaceOf(body.chatId)) || ws.DEFAULT) });
  console.log(`[tool] ${body.name} ${JSON.stringify(body.args).slice(0, 200)} (${Date.now() - t0}ms)`);
  sendJson(res, 200, { result: out.text, images: out.images || [] });
}

// Serve local image files (inside allowed roots only) so the chat can display them.
function handleFile(req, res) {
  const p = new URL(req.url, "http://x").searchParams.get("path");
  let file;
  try { file = servable(p); } catch (e) { return sendJson(res, 403, { error: e.message }); }
  if (!IMAGE_EXT.test(file)) return sendJson(res, 415, { error: "Only image files can be served" });
  const types = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
    ".bmp": "image/bmp", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
  const stream = fs.createReadStream(file);
  stream.on("error", () => sendJson(res, 404, { error: "Not found" }));
  stream.on("open", () => {
    res.writeHead(200, { "Content-Type": types[path.extname(file).toLowerCase()], "Cache-Control": "no-store" });
    stream.pipe(res);
  });
}

// ---- The app's own routes (bin/app.js, the tray icon) ----
// GET /api/ping: "is qqstudio running here?" for `qqstudio --app` / `--stop` and the installers (dir = the app folder,
// so an installer only stops its own copy). POST /api/stop and /api/tray/open: this computer only, and only with the
// X-QQStudio header, which a web page can't send cross-site without a CORS preflight (never allowed here).
// /api/stop exits qqstudio like Ctrl+C does: MCP servers and background commands stop with it, a loaded loadout keeps
// running and is picked up on the next start.
function handleApp(req, res) {
  if (req.url === "/api/ping" && req.method === "GET")
    return sendJson(res, 200, { app: "qqstudio", version: require("./package.json").version, pid: process.pid, port: PORT, dir: __dirname }), true;
  const u = new URL(req.url, "http://x");
  const what = u.pathname === "/api/stop" ? "stop" : u.pathname === "/api/tray/open" ? "open" : null;
  if (!what || req.method !== "POST") return false;
  if (!isLoopback(req.socket.remoteAddress) || req.headers["x-qqstudio"] !== what) return sendJson(res, 403, { error: "Only allowed from this computer" }), true;
  if (what === "stop") {
    // ?eject=1 (the uninstallers): unload the running loadout first, so no engine is left behind holding VRAM.
    (async () => {
      let ejected = null;
      if (u.searchParams.get("eject") === "1") {
        try { const st = await llama.status(); if (st && st.loadout && st.state !== "stopped") { await unloadLoadout(st.loadout); ejected = st.name || st.loadout; } }
        catch (e) { console.error("[server] eject before stop:", e.message); }
      }
      console.log(`[server] stop requested${ejected ? ` (ejected ${ejected})` : ""} - exiting`);
      sendJson(res, 200, { ok: true, ejected });
      setTimeout(() => process.exit(0), 150);
    })();
  } else {
    const via = require("./bin/app").openWindow(`http://localhost:${PORT}/`);
    console.log(`[server] tray opened qqstudio in ${via}`);
    sendJson(res, 200, { ok: true, via });
  }
  return true;
}

const server = http.createServer((req, res) => {
    if (!allowedRequest(req)) return sendJson(res, 403, { error: "Forbidden (cross-site request)" });
    if (remoteGate(req, res)) return;
    if (handleApp(req, res)) return;
    if (req.url === "/api/server") return handleServer(req, res);
    if (HOT && req.method === "GET" && req.url === "/__reload") return handleReloadStream(req, res);
    if (req.method === "GET" && req.url === "/api/models") return handleModels(res);
    if (req.method === "GET" && req.url === "/api/tools")
      return sendJson(res, 200, { enabled: toolSettings().enabled, tools: toolList(), roots: ROOTS, platform: process.platform, cwd: ws.filesDir(ws.DEFAULT), ...lazyInfo() });
    if (req.method === "GET" && req.url === "/api/tools/settings") return sendJson(res, 200, { ...toolSettings(), ...lazyInfo() });
    if (req.method === "PUT" && req.url === "/api/tools/settings")
      return readBody(req).then((b) => sendJson(res, 200, { ...saveToolSettings(JSON.parse(b)), ...lazyInfo() })).catch((e) => sendJson(res, 400, { error: e.message }));
    if (req.method === "POST" && req.url === "/api/tool") return handleTool(req, res);
    if (req.url === "/api/chats" || req.url.startsWith("/api/chats/")) return handleChats(req, res);
    if (req.url === "/api/config") return handleConfig(req, res);
    if (req.url.startsWith("/api/skills")) return handleSkills(req, res);
    if (req.url === "/api/workspaces" || req.url.startsWith("/api/workspaces/") || req.url.startsWith("/api/workspaces?")) return handleWorkspaces(req, res);
    if (req.url.startsWith("/api/mcp")) return handleMcp(req, res);
    if (req.url.startsWith("/api/ctx")) return handleCtx(req, res);
    if (req.url.startsWith("/api/hf/")) return handleHf(req, res);
    if (req.url.startsWith("/api/llama/")) return handleLlama(req, res);
    if (req.url === "/api/engines" || req.url.startsWith("/api/engines/")) return handleEngines(req, res);
    if (req.url === "/api/loadouts" || req.url.startsWith("/api/loadouts/")) return handleLoadouts(req, res);
    if (req.method === "GET" && req.url.startsWith("/api/file?")) return handleFile(req, res);
    if (req.method === "GET" && req.url === "/api/router/models") return handleRouterModels(res);
    if (req.url === "/api/models/local" || req.url === "/api/models/delete" || req.url === "/api/models/vision") return handleLocalModels(req, res);
    if (req.url === "/api/uploads" || req.url.startsWith("/api/uploads/") || req.url.startsWith("/api/uploads?")) return handleUploads(req, res);
    if (req.method === "POST" && req.url === "/api/router/unload") return handleRouterAction(req, res, "unload");
    if (req.method === "POST" && req.url === "/api/router/load") return handleRouterAction(req, res, "load");
    if (req.method === "GET" && (req.url === "/settings" || req.url === "/models")) { req.url = "/models.html"; return serveStatic(req, res); }
    if (req.method === "POST" && req.url === "/api/chat") return handleChat(req, res);
    if (req.url === "/api/runs" || req.url.startsWith("/api/runs/")) return runs.handle(req, res, { readBody, sendJson });
    if (req.method === "GET") return serveStatic(req, res);
    sendJson(res, 405, { error: "Method not allowed" });
  });

// Track sockets so a rebind (local network on/off) can drop keep-alive and event-stream connections right away.
const sockets = new Set();
server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
const banner = () => {
  console.log(`qqstudio:     http://localhost:${PORT}  (listening on ${HOST})`);
  if (exposed()) for (const a of lanAddresses()) console.log(`  network:    http://${a.ip}:${PORT}/  (${a.name}; other devices need the access key from Settings > Server)`);
};
function rebind(host) {
  server.close(() => {
    HOST = host;
    server.once("error", (e) => {
      console.error(`[server] could not listen on ${host}:${PORT}: ${e.message}; falling back to 127.0.0.1`);
      HOST = "127.0.0.1"; server.listen(PORT, HOST, banner);
    });
    server.listen(PORT, HOST, () => { server.removeAllListeners("error"); banner(); });
  });
  for (const s of sockets) s.destroy();
}
server.listen(PORT, HOST, () => {
    banner();
    console.log(`llama-server: ${llama.url()}`);
    try { loadouts.load(); } catch (e) { console.error("[loadouts] init:", e.message); }
    llama.init().then(async (pickedUp) => { // autostart: load the loadout used last
      const { autostart, last } = llama.settings();
      if (!pickedUp && autostart && last && loadouts.get(last) && !process.env.LLAMA_URL) { console.log(`[loadouts] loading ${loadouts.get(last).name} (used last)`); await preload(last); }
    }).catch((e) => console.error("[llama] init:", e.message));
    mcp.init().then(() => { const s = mcp.status(); if (s.length) console.log(`[mcp] ${s.map((x) => `${x.name}: ${x.status}`).join(", ")}`); });
    console.log(`File tools:   any path, with approval; relative paths in the session's workspace folder`);
    console.log(`Hot reload:   ${HOT ? "on" : "off"}`);
    console.log(`User data:    ${DATA.home}`);
    // The Windows tray icon (Open qqstudio / Quit qqstudio) belongs to this process: it shows however qqstudio was
    // started and goes away when this process ends. QQSTUDIO_TRAY=0 turns it off (CI, test copies).
    require("./tray").start({ port: PORT, version: require("./package.json").version });
    if (process.env.QQSTUDIO_OPEN === "1") require("./bin/open")(`http://localhost:${PORT}/`);
  });
