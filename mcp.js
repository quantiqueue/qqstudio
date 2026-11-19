// Minimal MCP client (no dependencies): stdio and Streamable HTTP transports.
// Config: %USERPROFILE%\.qqstudio\mcp.json in Claude Desktop format:
//   { "mcpServers": {
//       "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\data"], "env": {} },
//       "remote":     { "url": "https://host/mcp", "headers": { "Authorization": "Bearer ..." } },
//       "off":        { "command": "...", "disabled": true } } }
// qqstudio's own key per server: "relativePaths": "workspace" | "as-given" (see pathsMode).
// Tools are exposed to the model as "<server>__<tool>".
const fs = require("fs");
const { spawn, execFile } = require("child_process");
const P = require("./paths");

const PROTOCOL = "2025-06-18";
const MAX_OUT = 20000;
const conns = new Map(); // server name -> Conn

const EXAMPLE = {
  mcpServers: {
    filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "C:\\claude-tools"] },
    "remote-example": { url: "https://example.com/mcp", headers: { Authorization: "Bearer YOUR_TOKEN" }, disabled: true },
  },
};

function rawConfig() {
  try { return fs.readFileSync(P.mcp, "utf8"); } catch { return JSON.stringify({ mcpServers: {} }, null, 2); }
}
function readConfig() {
  try { const j = JSON.parse(rawConfig()); return j && typeof j.mcpServers === "object" ? j : { mcpServers: {} }; } catch { return { mcpServers: {} }; }
}
function quoteWin(a) { return /[\s"&|<>^()]/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : String(a); }
const safeName = (server, tool) => `${server}__${tool}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);

class Conn {
  constructor(name, cfg) {
    Object.assign(this, { name, cfg, status: "stopped", error: null, tools: [], logLines: [], nextId: 1, pending: new Map(),
      sessionId: null, protocol: null, proc: null, serverInfo: null });
    this.transport = cfg.url || /http/i.test(cfg.type || "") ? "http" : "stdio";
  }
  log(line) {
    for (const l of String(line).split(/\r?\n/)) if (l.trim()) this.logLines.push(`${new Date().toLocaleTimeString()}  ${l}`);
    if (this.logLines.length > 400) this.logLines.splice(0, this.logLines.length - 400);
  }

  async start() {
    this.status = "starting"; this.error = null; this.tools = []; this.sessionId = null; this.protocol = null;
    try {
      if (this.transport === "stdio") {
        if (!this.cfg.command) throw new Error('needs "command" (or "url" for a remote server)');
        this.spawnProc();
      } else if (!this.cfg.url) throw new Error('needs "url"');
      this.log(`connecting (${this.transport})…`);
      const init = await this.request("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "qqstudio", version: "0.1" } }, 60000);
      this.serverInfo = init.serverInfo || null;
      this.instructions = typeof init.instructions === "string" ? init.instructions : null;
      this.protocol = init.protocolVersion || PROTOCOL;
      this.notify("notifications/initialized");
      await this.refreshTools();
      this.status = "ready";
      this.log(`ready: ${this.tools.length} tool(s)${this.serverInfo ? ` from ${this.serverInfo.name} ${this.serverInfo.version || ""}` : ""}`);
    } catch (e) {
      this.status = "error"; this.error = e.message; this.log("error: " + e.message);
      this.kill();
    }
  }

  spawnProc() {
    let cmd = this.cfg.command, args = (this.cfg.args || []).map(String);
    const opts = { env: { ...process.env, ...(this.cfg.env || {}) }, cwd: this.cfg.cwd || P.home, stdio: ["pipe", "pipe", "pipe"], windowsHide: true };
    if (process.platform === "win32" && !/\.exe$/i.test(cmd)) { opts.shell = true; cmd = quoteWin(cmd); args = args.map(quoteWin); } // npx.cmd etc.
    const p = (this.proc = spawn(cmd, args, opts));
    let buf = "";
    p.stdout.on("data", (d) => {
      buf += d.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { this.log("stdout: " + line); continue; }
        this.handle(msg);
      }
    });
    p.stderr.on("data", (d) => this.log(d.toString("utf8")));
    p.stdin.on("error", () => {});
    p.on("error", (e) => { this.failAll(e.code === "ENOENT" ? new Error(`command not found: ${this.cfg.command}`) : e); });
    p.on("exit", (code) => {
      if (this.proc !== p) return;
      this.proc = null;
      this.log(`process exited (code ${code})`);
      this.failAll(new Error(`server process exited (code ${code})`));
      if (this.status === "ready" || this.status === "starting") { this.status = "error"; this.error = `process exited (code ${code}); see log`; }
    });
  }

  failAll(err) { for (const [, p] of this.pending) p.reject(err); this.pending.clear(); }

  send(msg) {
    if (this.transport === "http") return this.post(msg);
    if (!this.proc) throw new Error("not running");
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  request(method, params, timeout = 60000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out after ${timeout / 1000}s`)); }, timeout);
      this.pending.set(id, { resolve: (r) => { clearTimeout(t); resolve(r); }, reject: (e) => { clearTimeout(t); reject(e); } });
      try {
        const r = this.send({ jsonrpc: "2.0", id, method, params });
        if (r && r.catch) r.catch((e) => { const p = this.pending.get(id); if (p) { this.pending.delete(id); p.reject(e); } });
      } catch (e) { this.pending.delete(id); clearTimeout(t); reject(e); }
    });
  }

  notify(method, params) {
    try { const r = this.send({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }); if (r && r.catch) r.catch(() => {}); } catch {}
  }

  handle(m) {
    if (Array.isArray(m)) return m.forEach((x) => this.handle(x));
    if (m.id !== undefined && m.id !== null && (m.result !== undefined || m.error) && !m.method) {
      const p = this.pending.get(m.id);
      if (p) { this.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message || JSON.stringify(m.error))) : p.resolve(m.result); }
      return;
    }
    if (m.method && m.id !== undefined) { // request from server
      const reply = (body) => { try { const r = this.send({ jsonrpc: "2.0", id: m.id, ...body }); if (r && r.catch) r.catch(() => {}); } catch {} };
      if (m.method === "ping") return reply({ result: {} });
      if (m.method === "roots/list") return reply({ result: { roots: [] } });
      return reply({ error: { code: -32601, message: `Client does not support ${m.method}` } });
    }
    if (m.method === "notifications/tools/list_changed") this.refreshTools().catch(() => {});
    else if (m.method === "notifications/message") this.log(`[${m.params?.level || "log"}] ${typeof m.params?.data === "string" ? m.params.data : JSON.stringify(m.params?.data)}`);
  }

  async post(msg) {
    const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(this.cfg.headers || {}) };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    if (this.protocol) headers["MCP-Protocol-Version"] = this.protocol;
    const r = await fetch(this.cfg.url, { method: "POST", headers, body: JSON.stringify(msg), signal: AbortSignal.timeout(300000) });
    const sid = r.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (r.status === 202 || r.status === 204) return;
    if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`.trim());
    const ct = r.headers.get("content-type") || "";
    if (ct.includes("text/event-stream")) {
      const reader = r.body.getReader(), dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const ev = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = ev.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
          if (data) try { this.handle(JSON.parse(data)); } catch {}
        }
        if (msg.id !== undefined && !this.pending.has(msg.id)) { reader.cancel().catch(() => {}); break; } // got our answer
      }
    } else {
      const text = await r.text();
      if (text.trim()) this.handle(JSON.parse(text));
    }
  }

  async refreshTools() {
    const all = [];
    let cursor;
    do {
      const r = await this.request("tools/list", cursor ? { cursor } : {});
      all.push(...(r.tools || []));
      cursor = r.nextCursor;
    } while (cursor && all.length < 1000);
    this.tools = all;
  }

  async call(tool, args) {
    if (this.status !== "ready") throw new Error(`MCP server "${this.name}" is not connected (${this.status}${this.error ? ": " + this.error : ""})`);
    return this.request("tools/call", { name: tool, arguments: args || {} }, 300000);
  }

  kill() {
    this.failAll(new Error("server stopped"));
    const p = this.proc;
    this.proc = null;
    if (p && p.exitCode === null) {
      if (process.platform === "win32") execFile("taskkill", ["/PID", String(p.pid), "/T", "/F"], { windowsHide: true }, () => {});
      else try { p.kill(); } catch {}
    }
    if (this.transport === "http" && this.sessionId) {
      fetch(this.cfg.url, { method: "DELETE", headers: { "Mcp-Session-Id": this.sessionId, ...(this.cfg.headers || {}) } }).catch(() => {});
      this.sessionId = null;
    }
  }
  stop() { this.kill(); this.status = "stopped"; this.tools = []; }
}

async function reloadAll() {
  for (const c of conns.values()) c.stop();
  conns.clear();
  const cfg = readConfig().mcpServers;
  const starts = [];
  for (const [name, sc] of Object.entries(cfg)) {
    const c = new Conn(name, sc || {});
    conns.set(name, c);
    if (sc && sc.disabled) { c.status = "disabled"; continue; }
    starts.push(c.start());
  }
  await Promise.all(starts);
}

async function restart(name) {
  const c = conns.get(name);
  if (!c) throw new Error("no such server");
  c.stop();
  const sc = readConfig().mcpServers[name] || {};
  const n = new Conn(name, sc);
  n.logLines = c.logLines;
  conns.set(name, n);
  if (sc.disabled) { n.status = "disabled"; return; }
  await n.start();
}

function saveRaw(text) {
  const j = JSON.parse(text); // throws on bad JSON
  if (!j || typeof j.mcpServers !== "object" || Array.isArray(j.mcpServers)) throw new Error('Config must look like { "mcpServers": { ... } }');
  P.writeJson(P.mcp, j);
  return reloadAll();
}

// Relative file names in this server's tool arguments: "workspace" = made full paths in the session's workspace folder
// (runs.js workspacePaths), "as-given" = passed on unchanged. Default: workspace for local (stdio) servers, as given for
// remote (HTTP) ones, where a path on this PC means nothing.
function pathsMode(server) {
  const c = conns.get(server);
  if (!c) return "as-given";
  const v = c.cfg.relativePaths;
  return v === "workspace" || v === "as-given" ? v : c.transport === "http" ? "as-given" : "workspace";
}
function setPaths(name, mode) {
  if (mode !== "workspace" && mode !== "as-given") throw new Error("mode must be workspace or as-given");
  const j = readConfig();
  if (!j.mcpServers[name]) throw new Error("no such server");
  j.mcpServers[name].relativePaths = mode;
  P.writeJson(P.mcp, j);
  const c = conns.get(name);
  if (c) c.cfg.relativePaths = mode; // no reconnect needed
}

async function setEnabled(name, enabled) {
  const j = readConfig();
  if (!j.mcpServers[name]) throw new Error("no such server");
  if (enabled) delete j.mcpServers[name].disabled; else j.mcpServers[name].disabled = true;
  P.writeJson(P.mcp, j);
  await restart(name);
}

function status() {
  return [...conns.values()].map((c) => ({
    name: c.name, transport: c.transport, status: c.status, error: c.error, serverInfo: c.serverInfo,
    description: c.cfg.description || c.serverInfo?.title || (c.instructions || "").split(/\n|(?<=\.)\s/)[0].slice(0, 160) || "",
    summary: c.transport === "http" ? c.cfg.url : [c.cfg.command, ...(c.cfg.args || [])].join(" "),
    tools: c.tools.map((t) => ({ name: t.name, full: safeName(c.name, t.name), description: t.description || "" })),
    disabled: !!c.cfg.disabled,
    relativePaths: pathsMode(c.name),
  }));
}

function log(name) { return (conns.get(name)?.logLines || []).join("\n"); }

// Tools for tools.js
function tools() {
  const out = [];
  for (const c of conns.values()) {
    if (c.status !== "ready") continue;
    for (const t of c.tools) {
      const schema = t.inputSchema && typeof t.inputSchema === "object" ? { ...t.inputSchema } : {};
      if (schema.type !== "object") schema.type = "object";
      if (!schema.properties) schema.properties = {};
      out.push({ name: safeName(c.name, t.name), server: c.name, tool: t.name, label: t.title || t.annotations?.title || t.name,
        description: (t.description || `Tool ${t.name} from MCP server ${c.name}`).slice(0, 1000), parameters: schema,
        readOnly: !!t.annotations?.readOnlyHint });
    }
  }
  return out;
}

async function callTool(fullName, args) {
  const t = tools().find((x) => x.name === fullName);
  if (!t) throw new Error(`MCP tool ${fullName} is not available (server not connected?)`);
  const res = await conns.get(t.server).call(t.tool, args);
  const texts = [], images = [];
  for (const c of res.content || []) {
    if (c.type === "text") texts.push(c.text);
    else if (c.type === "image") { images.push({ src: `data:${c.mimeType};base64,${c.data}`, caption: `${t.server}: ${t.tool}` }); texts.push("[image returned, shown to the user]"); }
    else if (c.type === "resource") texts.push(c.resource?.text ?? `[resource ${c.resource?.uri || ""}]`);
    else if (c.type === "resource_link") texts.push(`[resource link: ${c.name || ""} ${c.uri}]`);
    else texts.push(`[${c.type} content]`);
  }
  if (!texts.length && res.structuredContent) texts.push(JSON.stringify(res.structuredContent, null, 2));
  let text = texts.join("\n") || "(no output)";
  if (text.length > MAX_OUT) text = text.slice(0, MAX_OUT) + `\n...[truncated, ${text.length - MAX_OUT} more chars]`;
  return { text: res.isError ? "ERROR: " + text : text, images };
}

// The folder a server runs in: where it puts files given by a relative name.
function cwdOf(server) { const c = conns.get(server); return (c && c.cfg && c.cfg.cwd) || P.home; }
function has(fullName) { return tools().some((t) => t.name === fullName); }
function knownServer(fullName) { return [...conns.keys()].some((s) => fullName.startsWith(s.replace(/[^A-Za-z0-9_-]/g, "_") + "__")); }

module.exports = { init: reloadAll, reloadAll, restart, saveRaw, setEnabled, status, log, tools, callTool, has, knownServer, cwdOf, pathsMode, setPaths, rawConfig, EXAMPLE, path: P.mcp };
