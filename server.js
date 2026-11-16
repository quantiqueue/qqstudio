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
const { ROOTS, runTool, toolList, toolSettings, saveToolSettings, isEnabled, resolveSafe, IMAGE_EXT } = require("./tools");
const hf = require("./hf");
const presets = require("./presets");
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
const visionOf = (model) => !!visionMap().get(model);
const UPLOADS = DATA.uploads;
// The file on disk behind a pasted image's /api/uploads/<name> link (null for other image refs).
const uploadPath = (src) => (typeof src === "string" && src.startsWith("/api/uploads/") ? path.join(UPLOADS, path.basename(decodeURIComponent(src.slice(13)))) : null);
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
    } else if (src.startsWith("/api/uploads/")) {
      const name = path.basename(decodeURIComponent(src.slice(13)));
      buf = await fs.promises.readFile(path.join(UPLOADS, name));
      mime = IMG_MIME[path.extname(name).slice(1).toLowerCase()];
    } else if (src.startsWith("/api/file?")) {
      const file = resolveSafe(new URL(src, "http://x").searchParams.get("path"));
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
// Image files named in a tool's text result (e.g. an MCP tool that exported a PNG), inside the allowed folders.
function imagePathsIn(text) {
  const out = [];
  const rx = /(?:[A-Za-z]:[\\/]|\/)[^\s"'<>|*?\r\n]*?\.(?:png|jpe?g|gif|bmp|webp)\b/gi;
  for (const m of String(text || "").matchAll(rx)) {
    try { const f = resolveSafe(m[0]); if (fs.statSync(f).isFile() && !out.includes(f)) out.push(f); } catch {}
    if (out.length >= 4) break;
  }
  return out.map((f) => ({ src: "/api/file?path=" + encodeURIComponent(f), full: "/api/file?path=" + encodeURIComponent(f), caption: path.basename(f) }));
}
async function handleUploads(req, res) {
  const name = path.basename(decodeURIComponent(req.url.split("?")[0].slice("/api/uploads".length).replace(/^\//, "")));
  if (req.method === "POST" && !name) {
    const ext = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp" }[(req.headers["content-type"] || "").split(";")[0].trim()];
    if (!ext) return sendJson(res, 415, { error: "Only PNG, JPEG, GIF, WebP or BMP images" });
    let buf;
    try { buf = await readRaw(req, 25 * 1024 * 1024); } catch (e) { return sendJson(res, e.status || 400, { error: e.status === 413 ? "Image is larger than 25 MB" : e.message }); }
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
  try {
    const r = await fetch(`${llama.url()}/v1/models`);
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

// ---- Model management (llama-server router mode: GET /models, POST /models/load|unload) ----
function statusOf(m) {
  const s = m.status;
  if (!s) return null;
  return typeof s === "string" ? s : s.value || null;
}

async function handleRouterModels(res) {
  try {
    let r = await fetch(`${llama.url()}/models`);
    let router = r.ok;
    if (!r.ok) r = await fetch(`${llama.url()}/v1/models`); // single-model mode
    const body = await r.json();
    const list = (body.data || body.models || []).map((m) => {
      const st = statusOf(m);
      if (st === null) router = false;
      return {
        id: m.id || m.name || m.model,
        status: st || "loaded",
        failed: !!(m.status && m.status.failed),
        args: (m.status && m.status.args) || null,
        path: m.path || (m.meta && m.meta.path) || null,
      };
    });
    sendJson(res, 200, { router, models: list });
  } catch (e) {
    sendJson(res, 502, { error: `Cannot reach llama-server at ${llama.url()}: ${e.message}` });
  }
}

async function handleRouterAction(req, res, action) {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: "Invalid JSON" }); }
  if (!body.model) return sendJson(res, 400, { error: "model is required" });
  try {
    const r = await fetch(`${llama.url()}/models/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: body.model }),
    });
    const text = await r.text();
    console.log(`[models] ${action} ${body.model} -> ${r.status}`);
    if (!r.ok) return sendJson(res, r.status, { error: text || r.statusText });
    sendJson(res, 200, { ok: true, response: text });
  } catch (e) {
    sendJson(res, 502, { error: e.message });
  }
}

// ---- Chat history: one JSON file per chat in ./chats ----
const CHATS = DATA.chats;
const chatFile = (id) => (/^[a-z0-9]{6,40}$/.test(id || "") ? path.join(CHATS, id + ".json") : null);

// All chat-file writes go through one queue per file, so a run's saves and the page's edits (title, mode, ...)
// never read-modify-write over each other.
const chatQueues = new Map();
function updateChat(file, fn) {
  const next = (chatQueues.get(file) || Promise.resolve()).then(async () => {
    let cur = null;
    try { cur = JSON.parse(await fs.promises.readFile(file, "utf8")); } catch {}
    const out = await fn(cur);
    if (out) await writeChat(file, out);
    return out;
  });
  const tail = next.catch(() => {});
  chatQueues.set(file, tail);
  tail.then(() => { if (chatQueues.get(file) === tail) chatQueues.delete(file); });
  return next;
}
const runs = createRuns({ llama, runTool, toolList, isEnabled, chatFile, updateChat, statusOf, visionOf, loadImage, imagePathsIn, uploadPath });

async function writeChat(file, obj) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`; // unique: runs and the page can save at once
  await fs.promises.writeFile(tmp, JSON.stringify(obj, null, 1), "utf8");
  await fs.promises.rename(tmp, file); // atomic replace
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
      openFolder(target);
      return sendJson(res, 200, { ok: true });
    }
    sendJson(res, 404, { error: "Not found" });
  } catch (e) { sendJson(res, 400, { error: e.message }); }
}
function openFolder(dir) {
  const { spawn } = require("child_process");
  const cmd = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  try { spawn(cmd, [dir], { detached: true, stdio: "ignore" }).unref(); } catch {}
}

// ---- Context size of a loaded model (best effort; never triggers a load) ----
async function handleCtx(req, res) {
  const model = new URL(req.url, "http://x").searchParams.get("model") || "";
  for (const u of [`${llama.url()}/props?model=${encodeURIComponent(model)}&autoload=false`, `${llama.url()}/props`]) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(2000) });
      if (!r.ok) continue;
      const j = await r.json();
      const n = j.default_generation_settings?.n_ctx || j.n_ctx || j.default_generation_settings?.params?.n_ctx;
      if (n) return sendJson(res, 200, { n_ctx: n });
    } catch {}
  }
  sendJson(res, 200, { n_ctx: null });
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
    if (req.method === "PUT" && u.pathname === "/api/mcp/enabled") {
      const b = JSON.parse(await readBody(req));
      await mcp.setEnabled(b.name, !!b.enabled);
      return sendJson(res, 200, { servers: mcp.status() });
    }
    sendJson(res, 404, { error: "Not found" });
  } catch (e) { sendJson(res, 400, { error: e.message }); }
}

// ---- General user config (config.json) ----
const THINK_DEFAULTS = { budgets: { low: 1024, medium: 4096, high: 16384 }, message: "" };
const CONFIG_DEFAULTS = { modelsFolder: DATA.models };
function getConfig() {
  const c = DATA.readJson(DATA.config, {});
  const t = c.thinking || {};
  delete c.lanAccess; delete c.lanKey; // served by /api/server (local requests only)
  return { ...CONFIG_DEFAULTS, ...c, thinking: { budgets: { ...THINK_DEFAULTS.budgets, ...(t.budgets || {}) }, message: t.message ?? THINK_DEFAULTS.message }, dataDir: DATA.home };
}
async function handleConfig(req, res) {
  if (req.method === "GET") return sendJson(res, 200, getConfig());
  if (req.method === "PUT") {
    let patch;
    try { patch = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: "Invalid JSON" }); }
    const cur = DATA.readJson(DATA.config, {});
    if (typeof patch.modelsFolder === "string") cur.modelsFolder = patch.modelsFolder.trim();
    if (patch.thinking && typeof patch.thinking === "object") {
      const t = cur.thinking || {};
      const b = { ...(t.budgets || {}) };
      for (const k of ["low", "medium", "high"]) {
        const v = Math.round(Number(patch.thinking.budgets?.[k]));
        if (Number.isFinite(v) && v > 0) b[k] = v;
      }
      cur.thinking = { budgets: b, message: typeof patch.thinking.message === "string" ? patch.thinking.message : t.message || "" };
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
      for (const f of await fs.promises.readdir(CHATS)) {
        if (!f.endsWith(".json")) continue;
        try {
          const c = JSON.parse(await fs.promises.readFile(path.join(CHATS, f), "utf8"));
          list.push({ id: c.id, title: c.title, updated: c.updated, model: c.model, running: runs.has(c.id), waiting: runs.waiting(c.id), unread: !!c.unread });
        } catch {}
      }
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
      await updateChat(file, () => c);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "PATCH") {
      const patch = JSON.parse(await readBody(req));
      const done = await updateChat(file, (c) => {
        if (!c) return null;
        if (typeof patch.title === "string") c.title = patch.title.slice(0, 200);
        if (patch.unread === false) delete c.unread;
        if (patch.mode === "manual" || patch.mode === "auto") c.mode = patch.mode;
        if (typeof patch.model === "string") c.model = patch.model;
        for (const k of ["skills", "mcp", "cats"]) if (patch[k] && typeof patch[k] === "object") c[k] = patch[k];
        if (["default", "off", "low", "medium", "high", "max"].includes(patch.think)) c.think = patch.think;
        return c;
      });
      if (!done) return sendJson(res, 404, { error: "Chat not found" });
      if (patch.mode) runs.modeChanged(id, patch.mode); // after saving, so a waiting approval sees the new mode
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "DELETE") {
      runs.deleted(id);
      await updateChat(file, async () => { await fs.promises.unlink(file).catch(() => {}); return null; }); // queued behind any save in flight
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
async function engineHas(id) {
  try { const j = await (await fetch(`${llama.url()}/models`)).json(); const m = (j.data || j.models || []).find((x) => (x.id || x.name) === id); return m ? statusOf(m) : null; } catch { return null; }
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
    const out = presets.generate(root);
    let restarted = false;
    if (out.changed && (await llama.status()).pid) { await llama.restart(); restarted = true; } // the router only reads presets at start
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
  // Unload first so Windows lets go of the file, then wait for it to leave memory.
  if (["loaded", "loading"].includes(await engineHas(m.name))) {
    try { await fetch(`${llama.url()}/models/unload`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: m.name }) }); } catch {}
    for (let i = 0; i < 20 && ["loaded", "loading", "unloading"].includes(await engineHas(m.name)); i++) await new Promise((r) => setTimeout(r, 500));
  }
  const deleted = [];
  try {
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
  const out = presets.generate(root);
  let restarted = false;
  if (out.changed && llama.settings().restartOnModelsChange && (await llama.status()).pid) { await llama.restart(); restarted = true; }
  sendJson(res, 200, { deleted, size, restarted });
}

// ---- Hugging Face search / download ----
async function handleHf(req, res) {
  const u = new URL(req.url, "http://x");
  try {
    if (req.method === "GET" && u.pathname === "/api/hf/search") return sendJson(res, 200, { models: await hf.search(u.searchParams.get("q")) });
    if (req.method === "GET" && u.pathname === "/api/hf/files")
      return sendJson(res, 200, { files: await hf.files(u.searchParams.get("repo"), u.searchParams.get("folder")) });
    if (req.method === "GET" && u.pathname === "/api/hf/downloads") return sendJson(res, 200, { jobs: hf.list() });
    if (req.method === "POST" && u.pathname === "/api/hf/download") return sendJson(res, 200, { ids: hf.startDownload(JSON.parse(await readBody(req))) });
    if (req.method === "POST" && u.pathname === "/api/hf/cancel") { hf.cancel(JSON.parse(await readBody(req)).id); return sendJson(res, 200, { ok: true }); }
    if (req.method === "POST" && u.pathname === "/api/hf/clear") { hf.clearFinished(); return sendJson(res, 200, { ok: true }); }
    if (req.method === "GET" && u.pathname === "/api/hf/presets") return sendJson(res, 200, presets.info(u.searchParams.get("folder")));
    if (req.method === "POST" && u.pathname === "/api/hf/presets") {
      const out = presets.generate(JSON.parse(await readBody(req)).folder);
      out.restarted = false;
      if (out.changed && llama.settings().restartOnModelsChange && (await llama.status()).pid) {
        console.log("[llama] models.ini changed -> restarting llama-server");
        await llama.restart();
        out.restarted = true;
      }
      return sendJson(res, 200, out);
    }
    sendJson(res, 404, { error: "Not found" });
  } catch (e) {
    sendJson(res, 400, { error: e.message });
  }
}

// ---- llama-server process management ----
async function handleLlama(req, res) {
  const u = new URL(req.url, "http://x");
  try {
    if (req.method === "GET" && u.pathname === "/api/llama/status") return sendJson(res, 200, await llama.status());
    if (req.method === "GET" && u.pathname === "/api/llama/log") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end(llama.log());
    }
    if (req.method === "GET" && u.pathname === "/api/llama/settings") return sendJson(res, 200, llama.getSettings());
    if (req.method === "PUT" && u.pathname === "/api/llama/settings") return sendJson(res, 200, llama.saveSettings(JSON.parse(await readBody(req))));
    if (req.method === "POST" && ["/api/llama/start", "/api/llama/stop", "/api/llama/restart"].includes(u.pathname)) {
      await llama[u.pathname.split("/").pop()]();
      return sendJson(res, 200, await llama.status());
    }
    sendJson(res, 404, { error: "Not found" });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
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
  const out = await runTool(body.name, body.args);
  console.log(`[tool] ${body.name} ${JSON.stringify(body.args).slice(0, 200)} (${Date.now() - t0}ms)`);
  sendJson(res, 200, { result: out.text, images: out.images || [] });
}

// Serve local image files (inside allowed roots only) so the chat can display them.
function handleFile(req, res) {
  const p = new URL(req.url, "http://x").searchParams.get("path");
  let file;
  try { file = resolveSafe(p); } catch (e) { return sendJson(res, 403, { error: e.message }); }
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

const server = http.createServer((req, res) => {
    if (!allowedRequest(req)) return sendJson(res, 403, { error: "Forbidden (cross-site request)" });
    if (remoteGate(req, res)) return;
    if (req.url === "/api/server") return handleServer(req, res);
    if (HOT && req.method === "GET" && req.url === "/__reload") return handleReloadStream(req, res);
    if (req.method === "GET" && req.url === "/api/models") return handleModels(res);
    if (req.method === "GET" && req.url === "/api/tools")
      return sendJson(res, 200, { enabled: toolSettings().enabled, tools: toolList(), roots: ROOTS, platform: process.platform, cwd: ROOTS[0] });
    if (req.method === "GET" && req.url === "/api/tools/settings") return sendJson(res, 200, toolSettings());
    if (req.method === "PUT" && req.url === "/api/tools/settings")
      return readBody(req).then((b) => sendJson(res, 200, saveToolSettings(JSON.parse(b)))).catch((e) => sendJson(res, 400, { error: e.message }));
    if (req.method === "POST" && req.url === "/api/tool") return handleTool(req, res);
    if (req.url === "/api/chats" || req.url.startsWith("/api/chats/")) return handleChats(req, res);
    if (req.url === "/api/config") return handleConfig(req, res);
    if (req.url.startsWith("/api/skills")) return handleSkills(req, res);
    if (req.url.startsWith("/api/mcp")) return handleMcp(req, res);
    if (req.url.startsWith("/api/ctx")) return handleCtx(req, res);
    if (req.url.startsWith("/api/hf/")) return handleHf(req, res);
    if (req.url.startsWith("/api/llama/")) return handleLlama(req, res);
    if (req.method === "GET" && req.url.startsWith("/api/file?")) return handleFile(req, res);
    if (req.method === "GET" && req.url === "/api/router/models") return handleRouterModels(res);
    if (req.url === "/api/models/local" || req.url === "/api/models/delete" || req.url === "/api/models/vision") return handleLocalModels(req, res);
    if (req.url === "/api/uploads" || req.url.startsWith("/api/uploads/")) return handleUploads(req, res);
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
    llama.init().catch((e) => console.error("[llama] init:", e.message));
    mcp.init().then(() => { const s = mcp.status(); if (s.length) console.log(`[mcp] ${s.map((x) => `${x.name}: ${x.status}`).join(", ")}`); });
    console.log(`Tool roots:   ${ROOTS.join(", ")}`);
    console.log(`Hot reload:   ${HOT ? "on" : "off"}`);
    console.log(`User data:    ${DATA.home}`);
  });
