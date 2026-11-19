// Tool implementations + OpenAI-style schemas.
// Paths are restricted to ALLOWED_ROOTS (semicolon-separated). Default: C:\claude-tools
const fs = require("fs/promises");
const path = require("path");
const { exec, execFile } = require("child_process");
const os = require("os");
const web = require("./web");
const docs = require("./docs");
const background = require("./background");

const ROOTS = (process.env.ALLOWED_ROOTS || "C:\\claude-tools")
  .split(";").map((r) => r.trim()).filter(Boolean).map((r) => path.resolve(r));
const skills = require("./skills");
ROOTS.push(skills.dir); // skill folders are readable (scripts, templates)
ROOTS.push(require("./paths").uploads); // pasted images, so tools can open the files the model is told about
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
    let text;
    if (docs.DOC_EXT.test(file)) text = await docs.extract(file); // PDF, Word, Excel, PowerPoint, OpenDocument: their text
    else {
      const buf = await fs.readFile(file);
      if (buf.subarray(0, 8000).includes(0)) return `${file} looks like a binary file (${fmtSize(buf.length)}); not shown.`;
      text = buf.toString("utf8");
    }
    const lines = text.split(/\r?\n/);
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

  // Replaces exact text in a file (the file's own line endings are kept). It fails loudly when the text isn't there
  // exactly once, so a small model can't silently garble a file the way a full rewrite can.
  async edit_file({ path: p, old_text, new_text, replace_all = false }) {
    const file = resolveSafe(p);
    if (typeof old_text !== "string" || !old_text) throw new Error("old_text (the exact text to replace) is required");
    if (typeof new_text !== "string") throw new Error('new_text is required (use "" to delete old_text)');
    const raw = await fs.readFile(file, "utf8");
    const crlf = raw.includes("\r\n"), eol = (s) => (crlf ? s.replace(/\r?\n/g, "\r\n") : s.replace(/\r\n/g, "\n"));
    const find = eol(old_text), repl = eol(new_text);
    const count = raw.split(find).length - 1;
    if (!count) {
      const first = old_text.split(/\r?\n/).find((l) => l.trim());
      const near = raw.split(/\r?\n/).map((l, i) => (first && l.trim() === first.trim() ? i + 1 : 0)).filter(Boolean).slice(0, 5);
      throw new Error(`old_text was not found in ${file}. It must match exactly, including spaces, indentation and line breaks.` +
        (near.length ? ` A line like its first line is at line ${near.join(", ")}: read the file there and copy the text exactly.` : " Read the file again and copy the text exactly."));
    }
    if (count > 1 && !replace_all) throw new Error(`old_text appears ${count} times in ${file}. Include more surrounding lines so it is unique, or set replace_all to true.`);
    const at = raw.indexOf(find), out = replace_all ? raw.split(find).join(repl) : raw.slice(0, at) + repl + raw.slice(at + find.length);
    await fs.writeFile(file, out, "utf8");
    const line = raw.slice(0, at).split("\n").length, lines = out.split(/\r?\n/);
    const from = Math.max(1, line - 2), to = Math.min(lines.length, line + repl.split("\n").length + 1);
    return `Edited ${file}: replaced ${replace_all && count > 1 ? count + " occurrences" : "1 occurrence"} at line ${line}.\n` +
      lines.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(5)}  ${l}`).join("\n");
  },

  // Finds text (or a regular expression) inside files: path:line: text.
  async search_text({ path: p, pattern, regex = false, case_sensitive = false, glob, max_results = 100 }) {
    const root = resolveSafe(p);
    if (!pattern) throw new Error("pattern is required");
    let rx;
    try { rx = new RegExp(regex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), case_sensitive ? "" : "i"); }
    catch (e) { throw new Error(`invalid regular expression: ${e.message}`); }
    const nameRx = glob ? new RegExp("^" + glob.split("").map((c) => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.+^${}()|[\]\\]/g, "\\$&"))).join("") + "$", "i") : null;
    const max = Math.min(Number(max_results) || 100, 500), hits = [];
    let files = 0, skipped = 0;
    async function scan(file) {
      if (docs.DOC_EXT.test(file) || IMAGE_EXT.test(file)) return;
      let st; try { st = await fs.stat(file); } catch { return; }
      if (st.size > 2 * 1024 * 1024) { skipped++; return; }
      let buf; try { buf = await fs.readFile(file); } catch { return; }
      if (buf.subarray(0, 8000).includes(0)) return; // binary
      files++;
      const lines = buf.toString("utf8").split(/\r?\n/);
      for (let i = 0; i < lines.length && hits.length < max; i++)
        if (rx.test(lines[i])) hits.push(`${file}:${i + 1}: ${lines[i].trim().slice(0, 300)}`);
    }
    async function walk(dir, depth) {
      if (depth > 12 || hits.length >= max) return;
      let entries; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (hits.length >= max) return;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) await walk(full, depth + 1); }
        else if (!nameRx || nameRx.test(e.name)) await scan(full);
      }
    }
    if ((await fs.stat(root)).isFile()) await scan(root); else await walk(root, 0);
    const note = (hits.length >= max ? `\n...(limit of ${max} matches reached; narrow the search)` : "") + (skipped ? `\n(${skipped} file${skipped > 1 ? "s" : ""} over 2 MB skipped)` : "");
    return hits.length ? clip(hits.join("\n") + note) : `No matches in ${files} file${files === 1 ? "" : "s"}.${note}`;
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
    const st = await fs.stat(file);
    // &v=<modified time>: a file re-saved under the same name gets a new link, so neither the page nor the run's image cache shows the old one
    const src = "/api/file?path=" + encodeURIComponent(file) + "&v=" + Math.round(st.mtimeMs);
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

  // Runs a script given as text: saved to a temp file and run with its interpreter, so there's no shell quoting.
  async run_script({ language = "python", code, cwd, timeout = 120 }) {
    if (typeof code !== "string" || !code.trim()) throw new Error("code is required");
    const win = process.platform === "win32", lang = String(language).toLowerCase();
    const kinds = {
      python: { ext: "py", run: (f) => (win ? [["py", ["-3", f]], ["python", [f]]] : [["python3", [f]], ["python", [f]]]) },
      powershell: { ext: "ps1", run: (f) => [[win ? "powershell.exe" : "pwsh", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", f]]] },
      node: { ext: "js", run: (f) => [[process.execPath, [f]]] },
      ...(win ? { cmd: { ext: "bat", run: (f) => [["cmd.exe", ["/d", "/c", f]]] } } : { bash: { ext: "sh", run: (f) => [["bash", [f]]] } }),
    };
    const k = kinds[lang === "javascript" || lang === "js" ? "node" : lang === "ps" || lang === "pwsh" ? "powershell" : lang === "py" ? "python" : lang === "batch" ? "cmd" : lang === "sh" ? "bash" : lang];
    if (!k) throw new Error(`language must be one of: ${Object.keys(kinds).join(", ")}`);
    const dir = path.join(os.tmpdir(), "qqstudio-scripts");
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `script-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${k.ext}`);
    await fs.writeFile(file, k.ext === "ps1" ? "\ufeff" + code : code, "utf8"); // BOM: Windows PowerShell reads the file as UTF-8
    const ms = Math.min(Math.max(Number(timeout) || 120, 1), 600) * 1000;
    const workDir = cwd ? resolveSafe(cwd) : ROOTS[0];
    const env = { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" };
    try {
      for (const [cmd, args] of k.run(file)) {
        const r = await new Promise((resolve) => execFile(cmd, args, { cwd: workDir, timeout: ms, maxBuffer: 10 * 1024 * 1024, windowsHide: true, env },
          (err, stdout, stderr) => resolve({ err, stdout, stderr })));
        if (r.err && r.err.code === "ENOENT") continue; // interpreter not installed under this name: try the next
        const codeOut = r.err ? (r.err.killed ? `killed (timeout ${ms / 1000}s)` : r.err.code) : 0;
        return clip(`exit code: ${codeOut}\n--- stdout ---\n${r.stdout || "(none)"}\n--- stderr ---\n${r.stderr || "(none)"}`);
      }
      return `ERROR: no ${lang} interpreter found on this computer.`;
    } finally { fs.unlink(file).catch(() => {}); }
  },

  async run_background({ command, cwd }) {
    if (!command) throw new Error("command is required");
    const p = background.start(command, cwd ? resolveSafe(cwd) : ROOTS[0]);
    await new Promise((r) => setTimeout(r, 1500)); // early output (or an immediate failure) comes back with the start
    return `Started ${p.id} in the background.\n` + background.check(p.id) + `\n\nCheck it later with check_background {"id": "${p.id}"}; stop it with stop_background.`;
  },
  check_background({ id, tail }) { return id ? background.check(id, tail) : background.list(); },
  stop_background({ id }) { if (!id) throw new Error("id is required"); return background.stop(id); },

  http_request: (a) => web.http_request(a),
};

const schemas = [
  { name: "load_skill", approval: false,
    description: "Load the full instructions of a skill by name. Call this before doing a task that matches one of the available skills, then follow the instructions.",
    parameters: { type: "object", properties: { name: { type: "string", description: "Skill name" } }, required: ["name"] } },
  { name: "list_dir", approval: false,
    description: "List the files and subfolders in a folder on the user's computer.",
    parameters: { type: "object", properties: { path: { type: "string", description: "Absolute folder path, e.g. C:\\claude-tools" } }, required: ["path"] } },
  { name: "read_file", approval: false,
    description: "Read a text file, or the text of a document (PDF, Word .docx, Excel .xlsx, PowerPoint .pptx, OpenDocument). Returns numbered lines. Use offset/limit for long files.",
    parameters: { type: "object", properties: {
      path: { type: "string", description: "Absolute file path" },
      offset: { type: "integer", description: "First line to read (1-based). Default 1." },
      limit: { type: "integer", description: "Max lines to read. Default 400." } }, required: ["path"] } },
  { name: "search_files", approval: false,
    description: "Recursively find files/folders by name under a folder. pattern is a substring or a wildcard like *.md",
    parameters: { type: "object", properties: {
      path: { type: "string", description: "Folder to search in" },
      pattern: { type: "string", description: "Name substring or wildcard, e.g. report or *.py" } }, required: ["path", "pattern"] } },
  { name: "edit_file", approval: true,
    description: "Change part of a text file: replaces old_text with new_text. old_text must match the file exactly (spaces, indentation, line breaks) and appear once; include a few surrounding lines to make it unique. Use this instead of rewriting a whole file with write_file. The user must approve.",
    parameters: { type: "object", properties: {
      path: { type: "string", description: "Absolute file path" },
      old_text: { type: "string", description: "The exact text to replace, copied from the file" },
      new_text: { type: "string", description: "The text to put in its place (\"\" deletes old_text)" },
      replace_all: { type: "boolean", description: "Replace every occurrence instead of exactly one (default false)" } }, required: ["path", "old_text", "new_text"] } },
  { name: "search_text", approval: false,
    description: "Search inside files for text or a regular expression. Returns path:line: matching line. path can be a folder (searched recursively) or one file.",
    parameters: { type: "object", properties: {
      path: { type: "string", description: "Absolute folder or file path" },
      pattern: { type: "string", description: "Text to find (or a regular expression when regex is true)" },
      regex: { type: "boolean", description: "Treat pattern as a regular expression (default false)" },
      case_sensitive: { type: "boolean", description: "Match letter case (default false)" },
      glob: { type: "string", description: "Only files whose name matches, e.g. *.js" },
      max_results: { type: "integer", description: "Most matches to return (default 100, max 500)" } }, required: ["path", "pattern"] } },
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
  { name: "web_search", approval: true,
    description: "Search the web (DuckDuckGo). Returns titles, URLs and snippets. Use fetch_url to read a result.",
    parameters: { type: "object", properties: {
      query: { type: "string", description: "Search query" },
      max_results: { type: "integer", description: "Number of results (default 8, max 20)" } }, required: ["query"] } },
  { name: "image_search", approval: true,
    description: "Search the web for images. The results are shown to the user as thumbnails automatically.",
    parameters: { type: "object", properties: {
      query: { type: "string", description: "What to find images of" },
      max_results: { type: "integer", description: "Number of images (default 8, max 24)" } }, required: ["query"] } },
  { name: "show_image", approval: false,
    description: "Display an image to the user in the chat. source is an image URL or a local image file path.",
    parameters: { type: "object", properties: {
      source: { type: "string", description: "Image URL (http/https) or absolute path to a local image file" },
      caption: { type: "string", description: "Optional caption" } }, required: ["source"] } },
  { name: "fetch_url", approval: true,
    description: "Open a web page and return its readable text plus a numbered list of links on the page. For long pages, call again with offset to read further.",
    parameters: { type: "object", properties: {
      url: { type: "string", description: "Full http(s) URL" },
      offset: { type: "integer", description: "Character offset to continue reading from (default 0)" } }, required: ["url"] } },
  { name: "download_file", approval: true,
    description: "Download a file from a URL and save it to disk. path may be a full file path or an existing folder. The user must approve.",
    parameters: { type: "object", properties: {
      url: { type: "string", description: "Full http(s) URL of the file" },
      path: { type: "string", description: "Destination file path or folder" } }, required: ["url", "path"] } },
  { name: "http_request", approval: true,
    description: "Call a web API: send an HTTP request and get the status, main headers and body (JSON is pretty-printed). For reading web pages use fetch_url; for saving files use download_file. The user must approve.",
    parameters: { type: "object", properties: {
      url: { type: "string", description: "Full http(s) URL" },
      method: { type: "string", description: "GET (default), POST, PUT, PATCH, DELETE or HEAD" },
      headers: { type: "object", description: "Request headers, e.g. {\"Authorization\": \"Bearer …\"}" },
      json: { description: "A JSON body (sent with Content-Type: application/json)" },
      body: { type: "string", description: "A raw text body, when not sending json" },
      timeout: { type: "integer", description: "Seconds to wait (default 30, max 120)" } }, required: ["url"] } },
  // Handled by runs.js (sub-agents are separate runs with their own sessions); listed here for settings and a category.
  { name: "run_agent", approval: false,
    description: "Hand a separate piece of work to a sub-agent: it works in the background with its own context and the same tools (but can't ask the user anything), then its report arrives in this conversation by itself. Good for self-contained work such as one file of many, or a research question. The sub-agent doesn't see this conversation: put everything it needs in task. After the step that starts it, this reply waits for its report (to run several in parallel, start them in the same step).",
    parameters: { type: "object", properties: {
      title: { type: "string", description: "A few words naming the work, shown to the user, e.g. \"Update file 23\"" },
      task: { type: "string", description: "Complete instructions: the goal, the files or facts involved, and what to report back" } }, required: ["title", "task"] } },
  { name: "message_agent", approval: false,
    description: "Send a message to a running sub-agent (e.g. a correction or an extra detail); it sees it after its current step.",
    parameters: { type: "object", properties: {
      id: { type: "string", description: "The sub-agent, e.g. a1" },
      text: { type: "string", description: "The message" } }, required: ["id", "text"] } },
  { name: "stop_agent", approval: false,
    description: "Stop a running sub-agent; its report with what it had done so far arrives here.",
    parameters: { type: "object", properties: { id: { type: "string", description: "The sub-agent, e.g. a1" } }, required: ["id"] } },
  { name: "check_agent", approval: false,
    description: "See a sub-agent's status and latest message. Not needed to get its result: the report arrives by itself.",
    parameters: { type: "object", properties: { id: { type: "string", description: "The sub-agent, e.g. a1" } }, required: ["id"] } },
  // Handled by runs.js (the session's task list is shown above the message box); listed here for settings and a category.
  { name: "todo", approval: false,
    description: "Keep a short task list for a task with several steps; the user sees it. Send the whole list each time, each item with status pending, in_progress or done. Mark several in_progress at once when they run in parallel (e.g. one per sub-agent). Create it when a task has 3 or more steps and update it as you finish each one. Don't use it for small tasks.",
    parameters: { type: "object", properties: {
      items: { type: "array", description: "The whole list, in order", items: { type: "object", properties: {
        text: { type: "string", description: "The step, a few words" },
        status: { type: "string", enum: ["pending", "in_progress", "done"] } }, required: ["text", "status"] } } }, required: ["items"] } },
  // Handled by runs.js (the reply waits for the answers); listed here so it has settings and a category.
  { name: "ask_user", approval: false,
    description: "Ask the user 1-4 multiple-choice questions and wait for the answers. Use it only for a big task where the request leaves real choices open and a wrong guess would be costly to redo: ask everything at once, before you start. Don't ask about things you can find out with your other tools, and don't use it for small tasks. Put the option you recommend first and mark it recommended. The user can also answer in their own words.",
    parameters: { type: "object", properties: {
      questions: { type: "array", description: "1 to 4 questions", items: { type: "object", properties: {
        question: { type: "string", description: "The question, ending with a question mark" },
        header: { type: "string", description: "Very short label for the question (max 12 characters), e.g. \"Style\"" },
        options: { type: "array", description: "2 to 4 choices", items: { type: "object", properties: {
          label: { type: "string", description: "The choice, 1-5 words" },
          description: { type: "string", description: "What choosing it means, one short line" },
          recommended: { type: "boolean", description: "true for the option you recommend (at most one)" } }, required: ["label"] } },
        multiple: { type: "boolean", description: "true if the user may pick several options" } }, required: ["question", "options"] } } },
      required: ["questions"] } },
  { name: "run_script", approval: true,
    description: "Run a script given as text, saved to a temp file and run with its interpreter (no shell quoting to worry about). Use it for anything that needs code: calculations, data, images, file conversions. Returns the exit code, stdout and stderr. The user must approve.",
    parameters: { type: "object", properties: {
      language: { type: "string", enum: process.platform === "win32" ? ["python", "powershell", "node", "cmd"] : ["python", "powershell", "node", "bash"], description: "Default python" },
      code: { type: "string", description: "The whole script" },
      cwd: { type: "string", description: "Working folder (optional)" },
      timeout: { type: "integer", description: "Seconds before it is stopped (default 120, max 600)" } }, required: ["code"] } },
  { name: "run_background", approval: true,
    description: "Start a long-running command in the background (a build, a dev server, a big download) and return right away with an id and its first output. Use check_background to see new output and stop_background to stop it. The user must approve.",
    parameters: { type: "object", properties: {
      command: { type: "string", description: "The command line to run" },
      cwd: { type: "string", description: "Working folder (optional)" } }, required: ["command"] } },
  { name: "check_background", approval: false,
    description: "Show what a background command printed since you last checked, and whether it is still running. Without an id, lists the background commands.",
    parameters: { type: "object", properties: {
      id: { type: "string", description: "The id run_background returned, e.g. bg1" },
      tail: { type: "integer", description: "Instead of new output, the last N characters of output" } } } },
  { name: "stop_background", approval: false,
    description: "Stop a background command (and anything it started).",
    parameters: { type: "object", properties: { id: { type: "string", description: "The id run_background returned" } }, required: ["id"] } },
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
  run_script: ["System", "Run scripts"],
  run_background: ["System", "Start background commands"],
  check_background: ["System", "Check background commands"],
  stop_background: ["System", "Stop background commands"],
  edit_file: ["File Access", "Edit files"],
  search_text: ["File Access", "Search inside files"],
  http_request: ["Web", "Call web APIs"],
  ask_user: ["Questions", "Ask questions"],
  todo: ["Tasks", "Task list"],
  run_agent: ["Agents", "Start sub-agents"],
  message_agent: ["Agents", "Message sub-agents"],
  stop_agent: ["Agents", "Stop sub-agents"],
  check_agent: ["Agents", "Check sub-agents"],
};
const CATEGORIES = ["File Access", "Web", "Images", "System", "Questions", "Tasks", "Agents", "Skills"];
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

// Workspace files folders are added (and removed) while the server runs.
const addRoot = (dir) => { const r = path.resolve(dir); if (!ROOTS.some((x) => norm(x) === norm(r))) ROOTS.push(r); };
const removeRoot = (dir) => { const i = ROOTS.findIndex((x) => norm(x) === norm(path.resolve(dir))); if (i > 0) ROOTS.splice(i, 1); };
module.exports = { ROOTS, addRoot, removeRoot, resolveSafe, IMAGE_EXT, runTool, toolList, toolSettings, saveToolSettings, isEnabled };
