// Minimal harness: serves a chat UI and proxies to llama-server.
// No dependencies; needs Node 18+ (built-in fetch).
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 8003;
const llama = require("./llama");
const PUBLIC = path.join(__dirname, "public");
const DATA = require("./paths"); // must load first: migrates old data into %USERPROFILE%\.qqstudio
const { ROOTS, runTool, toolList, toolSettings, saveToolSettings, isEnabled, resolveSafe, IMAGE_EXT } = require("./tools");
const hf = require("./hf");
const presets = require("./presets");
const HOST = process.env.HOST || "127.0.0.1"; // local only: the API can run commands, don't expose it to the network

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
    const list = (body.data || body.models || []).map((m) => ({
      id: m.id || m.name || m.model,
      status: m.status && (m.status.value || m.status),
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

async function writeChat(file, obj) {
  const tmp = file + ".tmp";
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
          list.push({ id: c.id, title: c.title, updated: c.updated, model: c.model });
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
      const c = JSON.parse(await readBody(req));
      c.id = id;
      await writeChat(file, c);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "PATCH") {
      const patch = JSON.parse(await readBody(req));
      const c = JSON.parse(await fs.promises.readFile(file, "utf8"));
      if (typeof patch.title === "string") c.title = patch.title.slice(0, 200);
      if (patch.mode === "manual" || patch.mode === "auto") c.mode = patch.mode;
      if (typeof patch.model === "string") c.model = patch.model;
      for (const k of ["skills", "mcp", "cats"]) if (patch[k] && typeof patch[k] === "object") c[k] = patch[k];
      if (["default", "off", "low", "medium", "high", "max"].includes(patch.think)) c.think = patch.think;
      await writeChat(file, c);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "DELETE") {
      await fs.promises.unlink(file).catch(() => {});
      return sendJson(res, 200, { ok: true });
    }
    sendJson(res, 405, { error: "Method not allowed" });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
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
function allowedRequest(req) {
  const host = (req.headers.host || "").toLowerCase();
  const exposed = HOST !== "127.0.0.1" && HOST !== "localhost";
  if (!exposed && !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) return false;
  if (req.method === "GET" || req.method === "HEAD") return true;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients (curl) on this machine
  try { return new URL(origin).host.toLowerCase() === host; } catch { return false; }
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

http
  .createServer((req, res) => {
    if (!allowedRequest(req)) return sendJson(res, 403, { error: "Forbidden (cross-site request)" });
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
    if (req.method === "POST" && req.url === "/api/router/unload") return handleRouterAction(req, res, "unload");
    if (req.method === "POST" && req.url === "/api/router/load") return handleRouterAction(req, res, "load");
    if (req.method === "GET" && (req.url === "/settings" || req.url === "/models")) { req.url = "/models.html"; return serveStatic(req, res); }
    if (req.method === "POST" && req.url === "/api/chat") return handleChat(req, res);
    if (req.method === "GET") return serveStatic(req, res);
    sendJson(res, 405, { error: "Method not allowed" });
  })
  .listen(PORT, HOST, () => {
    console.log(`qqstudio:     http://localhost:${PORT}  (listening on ${HOST})`);
    console.log(`llama-server: ${llama.url()}`);
    llama.init().catch((e) => console.error("[llama] init:", e.message));
    mcp.init().then(() => { const s = mcp.status(); if (s.length) console.log(`[mcp] ${s.map((x) => `${x.name}: ${x.status}`).join(", ")}`); });
    console.log(`Tool roots:   ${ROOTS.join(", ")}`);
    console.log(`Hot reload:   ${HOT ? "on" : "off"}`);
    console.log(`User data:    ${DATA.home}`);
  });
