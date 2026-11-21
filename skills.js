// Skills: folders with a SKILL.md (Anthropic Agent Skills format):
//   ---
//   name: my-skill
//   description: What it does and when to use it.
//   ---
//   Instructions...
// Lives in %USERPROFILE%\.qqstudio\skills\<folder>\SKILL.md. Other files in the folder (scripts, templates)
// are listed for the model, which can read/run them with the normal file tools.
const fs = require("fs");
const path = require("path");
const P = require("./paths");

const SCRIPT_EXT = /\.(py|js|mjs|ts|ps1|sh|bat|cmd)$/i;

function parseFrontmatter(text) {
  const m = text.replace(/^\uFEFF/, "").match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) {
      key = kv[1];
      let v = kv[2].trim();
      if (v === ">" || v === "|" || v === ">-" || v === "|-") v = "";
      meta[key] = v.replace(/^(['"])(.*)\1$/, "$2");
    } else if (key && /^\s+\S/.test(line)) {
      meta[key] = (meta[key] ? meta[key] + " " : "") + line.trim(); // folded continuation
    }
  }
  return { meta, body: m[2] };
}

// skills.json changes only through setEnabled: read once. The folders are scanned when they change (dircache.js): every
// list() read each SKILL.md with blocking reads, and the pages and each reply ask for the list.
let cfgCache = null;
function cfg() { if (!cfgCache) cfgCache = { disabled: [], ...P.readJson(P.skillsCfg, {}) }; return { ...cfgCache, disabled: [...cfgCache.disabled] }; }

function walk(dir, base = dir, out = [], depth = 0) {
  if (depth > 3 || out.length >= 60) return out;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "__pycache__") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out, depth + 1);
    else if (!/^skill\.md$/i.test(e.name) || dir !== base) out.push(path.relative(base, full));
  }
  return out;
}

const scans = require("./dircache").dirCache(scan);
function list() {
  const disabled = new Set(cfg().disabled);
  return scans.get(P.skills).map((s) => ({ ...s, files: [...s.files], enabled: !disabled.has(s.name) }));
}
function scan() {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(P.skills, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch {}
  for (const d of dirs) {
    const dir = path.join(P.skills, d.name);
    const file = fs.readdirSync(dir).find((f) => /^skill\.md$/i.test(f));
    if (!file) continue;
    let meta = {};
    try { ({ meta } = parseFrontmatter(fs.readFileSync(path.join(dir, file), "utf8"))); } catch {}
    const name = (meta.name || d.name).trim();
    const files = walk(dir);
    out.push({
      name, folder: d.name, description: (meta.description || "").trim(), dir, file: path.join(dir, file),
      files, hasScripts: files.some((f) => SCRIPT_EXT.test(f)),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function get(name) {
  const s = list().find((x) => x.name === name || x.folder === name);
  if (!s) return null;
  const { body } = parseFrontmatter(fs.readFileSync(s.file, "utf8"));
  return { ...s, body: body.trim() };
}

function setEnabled(name, enabled) {
  const c = cfg();
  const set = new Set(c.disabled);
  enabled ? set.delete(name) : set.add(name);
  c.disabled = [...set];
  P.writeJson(P.skillsCfg, c);
  cfgCache = c;
}

function createExample() {
  const dir = path.join(P.skills, "folder-report");
  if (fs.existsSync(dir)) return dir;
  fs.mkdirSync(dir, { recursive: true });
  scans.invalidate();
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---
name: folder-report
description: Produce a short report about a folder - what it contains, file types, largest files and what the project appears to be. Use when the user asks to summarize, audit or describe a folder.
---

# Folder report

1. Call list_dir on the folder. For each subfolder that looks important (src, docs, app, etc.), list it too (at most 5 subfolders).
2. Read README or similar files if present (read_file, first 100 lines).
3. Write the report in this format:

## <folder name>
**What it is:** one or two sentences.
**Contents:** bullet list of the main subfolders/files and what each is for.
**File types:** counts by extension.
**Largest files:** top 5 with sizes.
**Notes:** anything unusual (very large files, secrets like .env, build output that could be cleaned up).

Keep it under 250 words. Don't modify anything.
`);
  scans.invalidate();
  return dir;
}

module.exports = { list, get, setEnabled, createExample, dir: P.skills };
