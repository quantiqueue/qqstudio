// Tool implementations + OpenAI-style schemas.
// Paths are restricted to ALLOWED_ROOTS (semicolon-separated). Default: C:\claude-tools
const fs = require("fs/promises");
const path = require("path");
const { exec, execFile } = require("child_process");
const web = require("./web");

const ROOTS = (process.env.ALLOWED_ROOTS || "C:\\claude-tools")
  .split(";").map((r) => r.trim()).filter(Boolean).map((r) => path.resolve(r));
const skills = require("./skills");
ROOTS.push(skills.dir); // skill folders are readable (scripts, templates)
const MAX_OUT = 20000; // chars returned to the model per tool call
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|ico)$/i;
const SKIP_DIRS = new Set(["node_modules", ".git", "__pycache__", ".venv"]);

const norm = (p) => (process.platform === "win32" ? p.toLowerCase() : p);

function resolveSafe(p) {
  if (!p || typeof p !== "string") throw new Error("path is required");
  const abs = path.resolve(ROOTS[0], p);
  const ok = ROOTS.some((r) => {
    const a = norm(abs), b = norm(r);
    return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
  });
  if (!ok) throw new Error(`Access denied: ${abs} is outside the allowed folders (${ROOTS.join(", ")})`);
  return abs;
}

function clip(s) {
  return s.length > MAX_OUT ? s.slice(0, MAX_OUT) + `\n...[truncated, ${s.length - MAX_OUT} more chars]` : s;
}

function fmtSize(n) {
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  return (n / 1048576).toFixed(1) + " MB";
}

const impl = {
  async load_skill({ name }) {
    if (!name) throw new Error("name is required");
    const s = skills.get(name);
    if (!s) throw new Error(`No skill named "${name}". Available: ${skills.list().filter((x) => x.enabled).map((x) => x.name).join(", ") || "none"}`);
    if (!s.enabled) throw new Error(`The skill "${name}" is disabled in Settings > Skills.`);
    const files = s.files.length ? `\n\nFiles in this skill (folder ${s.dir}):\n${s.files.map((f) => "- " + path.join(s.dir, f)).join("\n")}` : "";
    return `# Skill: ${s.name}\n\n${s.body}${files}`;
  },

  async list_dir({ path: p }) {
    const dir = resolveSafe(p);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
    const lines = [];
    for (const e of entries.slice(0, 500)) {
      if (e.isDirectory()) lines.push(`[DIR]  ${e.name}`);
      else {
        let size = "";
        try { size = fmtSize((await fs.stat(path.join(dir, e.name))).size); } catch {}
        lines.push(`[FILE] ${e.name}  (${size})`);
      }
    }
    if (entries.length > 500) lines.push(`...and ${entries.length - 500} more`);
    return `${dir}\n${lines.length ? lines.join("\n") : "(empty)"}`;
  },

  async read_file({ path: p, offset = 1, limit = 400 }) {
    const file = resolveSafe(p);
    const buf = await fs.readFile(file);
    if (buf.subarray(0, 8000).includes(0)) return `${file} looks like a binary file (${fmtSize(buf.length)}); not shown.`;
    const lines = buf.toString("utf8").split(/\r?\n/);
    const start = Math.max(1, Number(offset) || 1);
    const end = Math.min(lines.length, start + (Number(limit) || 400) - 1);
    const body = lines.slice(start - 1, end).map((l, i) => `${String(start + i).padStart(5)}  ${l}`).join("\n");
    const more = end < lines.length ? `\n[showing lines ${start}-${end} of ${lines.length}; use offset to read more]` : "";
    return clip(body + more);
  },

  async search_files({ path: p, pattern }) {
    const root = resolveSafe(p);
    if (!pattern) throw new Error("pattern is required");
    const rx = new RegExp(
      "^" + pattern.split("").map((c) => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.+^${}()|[\]\\]/g, "\\$&"))).join("") + "$",
      "i"
    );
    const substring = !/[*?]/.test(pattern);
    const results = [];
    async function walk(dir, depth) {
      if (depth > 8 || results.length >= 200) return;
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (results.length >= 200) return;
        const full = path.join(dir, e.name);
        const hit = substring ? e.name.toLowerCase().includes(pattern.toLowerCase()) : rx.test(e.name);
        if (hit) results.push((e.isDirectory() ? "[DIR]  " : "[FILE] ") + full);
        if (e.isDirectory() && !SKIP_DIRS.has(e.name)) await walk(full, depth + 1);
      }
    }
    await walk(root, 0);
    return results.length ? results.join("\n") + (results.length >= 200 ? "\n...(limit 200 reached)" : "") : "No matches.";
  },

  async write_file({ path: p, content }) {
    const file = resolveSafe(p);
    if (typeof content !== "string") throw new Error("content (string) is required");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, "utf8");
    return `Wrote ${fmtSize(Buffer.byteLength(content))} to ${file}`;
  },

  async delete_file({ path: p }) {
    const target = resolveSafe(p);
    if (ROOTS.some((r) => norm(r) === norm(target))) throw new Error("Refusing to delete an allowed root folder itself.");
    const st = await fs.stat(target); // throws if missing
    if (process.platform === "win32") {
      // Send to Recycle Bin (undoable). Path passed via env var, so no quoting/injection issues.
      const ps = `Add-Type -AssemblyName Microsoft.VisualBasic; ` +
        (st.isDirectory()
          ? `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:HARNESS_TARGET,'OnlyErrorDialogs','SendToRecycleBin')`
          : `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($env:HARNESS_TARGET,'OnlyErrorDialogs','SendToRecycleBin')`);
      await new Promise((resolve, reject) =>
        execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps],
          { env: { ...process.env, HARNESS_TARGET: target }, timeout: 30000, windowsHide: true },
          (err, _o, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve())));
      return `Moved ${st.isDirectory() ? "folder" : "file"} to Recycle Bin: ${target}`;
    }
    await fs.rm(target, { recursive: true });
    return `Deleted ${target}`;
  },

  async move_file({ from, to }) {
    const src = resolveSafe(from), dst = resolveSafe(to);
    await fs.stat(src);
    let finalDst = dst;
    try { if ((await fs.stat(dst)).isDirectory()) finalDst = path.join(dst, path.basename(src)); } catch {}
    try { await fs.stat(finalDst); throw new Error(`Destination already exists: ${finalDst}`); }
    catch (e) { if (e.code !== "ENOENT") throw e; }
    await fs.mkdir(path.dirname(finalDst), { recursive: true });
    await fs.rename(src, finalDst);
    return `Moved ${src} -> ${finalDst}`;
  },

  web_search: (a) => web.web_search(a),
  image_search: (a) => web.image_search(a),

  async show_image({ source, caption }) {
    if (!source) throw new Error("source (URL or file path) is required");
    if (/^https?:\/\//i.test(source)) {
      return { text: `The image is now displayed to the user (${source}). Reply with a short sentence about it; do not repeat the URL.`, images: [{ src: source, full: source, caption, big: true }] };
    }
    const file = resolveSafe(source);
    if (!IMAGE_EXT.test(file)) throw new Error("Not an image file (supported: png, jpg, jpeg, gif, webp, bmp, svg, ico)");
    await fs.stat(file);
    const src = "/api/file?path=" + encodeURIComponent(file);
    return { text: `The image ${file} is now displayed to the user. Reply with a short sentence about it.`, images: [{ src, full: src, caption: caption || path.basename(file), big: true }] };
  },
  fetch_url: (a) => web.fetch_url(a),
  download_file: (a) => web.download_file(a, resolveSafe),

  run_command({ command, cwd }) {
    if (!command) throw new Error("command is required");
    const dir = cwd ? resolveSafe(cwd) : ROOTS[0];
    return new Promise((resolve) => {
      exec(command, { cwd: dir, timeout: 60000, maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        const code = err ? (err.killed ? "killed (timeout 60s)" : err.code) : 0;
        resolve(clip(`exit code: ${code}\n--- stdout ---\n${stdout || "(none)"}\n--- stderr ---\n${stderr || "(none)"}`));
      });
    });
  },
};

const schemas = [
  { name: "load_skill", approval: false,
    description: "Load the full instructions of a skill by name. Call this before doing a task that matches one of the available skills, then follow the instructions.",
    parameters: { type: "object", properties: { name: { type: "string", description: "Skill name" } }, required: ["name"] } },
  { name: "list_dir", approval: false,
    description: "List the files and subfolders in a folder on the user's computer.",
    parameters: { type: "object", properties: { path: { type: "string", description: "Absolute folder path, e.g. C:\\claude-tools" } }, required: ["path"] } },
  { name: "read_file", approval: false,
    description: "Read a text file. Returns numbered lines. Use offset/limit for long files.",
    parameters: { type: "object", properties: {
      path: { type: "string", description: "Absolute file path" },
      offset: { type: "integer", description: "First line to read (1-based). Default 1." },
      limit: { type: "integer", description: "Max lines to read. Default 400." } }, required: ["path"] } },
  { name: "search_files", approval: false,
    description: "Recursively find files/folders by name under a folder. pattern is a substring or a wildcard like *.md",
    parameters: { type: "object", properties: {
      path: { type: "string", description: "Folder to search in" },
      pattern: { type: "string", description: "Name substring or wildcard, e.g. report or *.py" } }, required: ["path", "pattern"] } },
  { name: "write_file", approval: true,
    description: "Create or overwrite a text file with the given content. The user must approve.",
    parameters: { type: "object", properties: {
      path: { type: "string", description: "Absolute file path" },
      content: { type: "string", description: "Full file content" } }, required: ["path", "content"] } },
  { name: "delete_file", approval: true,
    description: "Delete a file or folder (sent to the Recycle Bin). The user must approve.",
    parameters: { type: "object", properties: { path: { type: "string", description: "Absolute path of the file or folder to delete" } }, required: ["path"] } },
  { name: "move_file", approval: true,
    description: "Move or rename a file or folder. If 'to' is an existing folder, the item is moved into it. The user must approve.",
    parameters: { type: "object", properties: {
      from: { type: "string", description: "Current absolute path" },
      to: { type: "string", description: "New absolute path, or destination folder" } }, required: ["from", "to"] } },
  { name: "web_search", approval: false,
    description: "Search the web (DuckDuckGo). Returns titles, URLs and snippets. Use fetch_url to read a result.",
    parameters: { type: "object", properties: {
      query: { type: "string", description: "Search query" },
      max_results: { type: "integer", description: "Number of results (default 8, max 20)" } }, required: ["query"] } },
  { name: "image_search", approval: false,
    description: "Search the web for images. The results are shown to the user as thumbnails automatically.",
    parameters: { type: "object", properties: {
      query: { type: "string", description: "What to find images of" },
      max_results: { type: "integer", description: "Number of images (default 8, max 24)" } }, required: ["query"] } },
  { name: "show_image", approval: false,
    description: "Display an image to the user in the chat. source is an image URL or a local image file path.",
    parameters: { type: "object", properties: {
      source: { type: "string", description: "Image URL (http/https) or absolute path to a local image file" },
      caption: { type: "string", description: "Optional caption" } }, required: ["source"] } },
  { name: "fetch_url", approval: false,
    description: "Open a web page and return its readable text plus a numbered list of links on the page. For long pages, call again with offset to read further.",
    parameters: { type: "object", properties: {
      url: { type: "string", description: "Full http(s) URL" },
      offset: { type: "integer", description: "Character offset to continue reading from (default 0)" } }, required: ["url"] } },
  { name: "download_file", approval: true,
    description: "Download a file from a URL and save it to disk. path may be a full file path or an existing folder. The user must approve.",
    parameters: { type: "object", properties: {
      url: { type: "string", description: "Full http(s) URL of the file" },
      path: { type: "string", description: "Destination file path or folder" } }, required: ["url", "path"] } },
  { name: "run_command", approval: true,
    description: "Run a shell command (cmd.exe on Windows) and return its output. 60s timeout. The user must approve.",
    parameters: { type: "object", properties: {
      command: { type: "string", description: "The command line to run" },
      cwd: { type: "string", description: "Working folder (optional)" } }, required: ["command"] } },
];

// Returns { text, images? }. Tools may return a string or { text, images }.
const mcp = require("./mcp");

async function runTool(name, args) {
  const fn = impl[name] || (mcp.has(name) ? (a) => mcp.callTool(name, a) : null);
  if (!fn) return { text: `ERROR: unknown tool "${name}". Available: ${Object.keys(impl).join(", ")}` };
  try {
    const out = await fn(args || {});
    return out && typeof out === "object" && "text" in out ? out : { text: String(out) };
  } catch (e) { return { text: `ERROR: ${e.message}` }; }
}

// ---- Tool settings (enable / ask-first per tool), stored in tools.cfg ----
const META = {
  load_skill: ["Skills", "Load skills"],
  list_dir: ["File Access", "List folders"],
  read_file: ["File Access", "Read files"],
  search_files: ["File Access", "Search files"],
  write_file: ["File Access", "Write files"],
  move_file: ["File Access", "Move & rename"],
  delete_file: ["File Access", "Delete files"],
  web_search: ["Web", "Web search"],
  fetch_url: ["Web", "Read web pages"],
  download_file: ["Web", "Download files"],
  image_search: ["Images", "Image search"],
  show_image: ["Images", "Show images"],
  run_command: ["System", "Run commands"],
};
const CATEGORIES = ["File Access", "Web", "Images", "System", "Skills"];
const CFG_FILE = require("./paths").tools;
const fsSync = require("fs");

function loadCfg() {
  try { return { enabled: true, tools: {}, ...JSON.parse(fsSync.readFileSync(CFG_FILE, "utf8")) }; }
  catch { return { enabled: true, tools: {} }; }
}

function toolList() {
  const cfg = loadCfg();
  const builtin = schemas.map((s) => {
    const t = cfg.tools[s.name] || {};
    const [category, label] = META[s.name] || ["Other", s.name];
    return {
      name: s.name, label, category, description: s.description,
      enabled: t.enabled !== false,
      approval: typeof t.approval === "boolean" ? t.approval : s.approval,
      defaultApproval: s.approval,
      spec: { type: "function", function: { name: s.name, description: s.description, parameters: s.parameters } },
    };
  });
  // MCP tools: category per server, "Ask first" on by default unless the server marks the tool read-only.
  const fromMcp = mcp.tools().map((m) => {
    const t = cfg.tools[m.name] || {};
    const def = !m.readOnly;
    return {
      name: m.name, label: m.label, category: "MCP: " + m.server, server: m.server, description: m.description,
      enabled: t.enabled !== false,
      approval: typeof t.approval === "boolean" ? t.approval : def,
      defaultApproval: def,
      spec: { type: "function", function: { name: m.name, description: m.description, parameters: m.parameters } },
    };
  });
  return builtin.concat(fromMcp);
}

function toolSettings() {
  const list = toolList();
  const cats = CATEGORIES.concat([...new Set(list.filter((t) => t.server).map((t) => t.category))]);
  return { enabled: loadCfg().enabled !== false, categories: cats, tools: list.map(({ spec, ...t }) => t) };
}

function saveToolSettings(patch) {
  const cfg = loadCfg();
  if (typeof patch.enabled === "boolean") cfg.enabled = patch.enabled;
  for (const [name, t] of Object.entries(patch.tools || {})) {
    if (!META[name] && !mcp.has(name) && !mcp.knownServer(name)) continue;
    cfg.tools[name] = { ...(cfg.tools[name] || {}) };
    if (typeof t.enabled === "boolean") cfg.tools[name].enabled = t.enabled;
    if (typeof t.approval === "boolean") cfg.tools[name].approval = t.approval;
  }
  require("./paths").writeJson(CFG_FILE, cfg);
  return toolSettings();
}

function isEnabled(name) {
  const cfg = loadCfg();
  return cfg.enabled !== false && (cfg.tools[name] || {}).enabled !== false;
}

module.exports = { ROOTS, resolveSafe, IMAGE_EXT, runTool, toolList, toolSettings, saveToolSettings, isEnabled };
