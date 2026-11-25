// Generates a llama-server --models-preset INI from a nested models folder
// (e.g. LM Studio layout <root>\<vendor>\<model>\<file>.gguf), since --models-dir only scans one level.
// Extra keys you add to a section by hand (ctx-size, temp, ...) are kept when regenerating.
const fs = require("fs");
const path = require("path");

const PRESET_FILE = require("./paths").presets;
// Models whose mmproj (vision projector) is switched off in Settings > Models: {"disabled": [model names]}.
const VISION_FILE = path.join(require("./paths").home, "vision.json");
function visionOff() { try { return new Set(JSON.parse(fs.readFileSync(VISION_FILE, "utf8")).disabled || []); } catch { return new Set(); } }
function setVision(name, on) {
  const off = visionOff();
  if (on) off.delete(name); else off.add(name);
  fs.writeFileSync(VISION_FILE, JSON.stringify({ disabled: [...off] }, null, 1));
}
const SHARD = /-(\d{5})-of-(\d{5})\.gguf$/i;

function scan(root, depth = 0, out = []) {
  if (depth > 6) return out;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  const ggufs = entries.filter((e) => e.isFile() && /\.gguf$/i.test(e.name)).map((e) => e.name);
  if (ggufs.length) {
    const mmprojs = ggufs.filter((n) => /mmproj/i.test(n));
    const mmproj = mmprojs.find((n) => /f16/i.test(n) && !/bf16/i.test(n)) || mmprojs.find((n) => /bf16/i.test(n)) || mmprojs[0];
    for (const n of ggufs) {
      if (/mmproj/i.test(n)) continue;
      const shard = n.match(SHARD);
      if (shard && shard[1] !== "00001") continue; // llama.cpp loads the rest from the first shard
      out.push({
        base: n.replace(SHARD, ".gguf").replace(/\.gguf$/i, ""),
        model: path.join(root, n),
        mmproj: mmproj ? path.join(root, mmproj) : null,
        size: (() => { try { return fs.statSync(path.join(root, n)).size; } catch { return 0; } })(),
      });
    }
  }
  // Strata's own .strata builds (Inkling-2-Mini's SQ sizes): models only Strata runs (strata: true), with the Vision shard
  // beside them as their picture reader. Never in the llama-server preset.
  const stratas = entries.filter((e) => e.isFile() && /\.strata$/i.test(e.name)).map((e) => e.name);
  if (stratas.length) {
    const vision = stratas.find((n) => /vision/i.test(n));
    for (const n of stratas) {
      if (/vision|engram/i.test(n)) continue;
      out.push({
        base: n.replace(/\.strata$/i, ""),
        model: path.join(root, n),
        mmproj: vision ? path.join(root, vision) : null,
        size: (() => { try { return fs.statSync(path.join(root, n)).size; } catch { return 0; } })(),
        strata: true,
      });
    }
  }
  for (const e of entries) if (e.isDirectory() && !e.name.startsWith(".")) scan(path.join(root, e.name), depth + 1, out);
  return out;
}

// The walk (a readdir per folder, a stat per model) ran on every models request and every Settings poll: kept until
// the folder changes (dircache.js). invalidate() is for qqstudio's own changes (downloads, deletes).
const scans = require("./dircache").dirCache(listNow);
const invalidate = () => scans.invalidate();
function list(folder) {
  return scans.get(path.resolve(folder)).map((m) => ({ ...m })); // callers may change their copies
}
// A size's name inside its file name (Qwen3.6-35B-A3B-UD-Q4_K_XL -> UD-Q4_K_XL), to tell apart two files of one repo folder.
const QUANT = /[-_.]((?:UD-)?(?:I?Q\d\w*|TQ\d\w*|MXFP4\w*|BF16|F16|F32|SQ-\d+))$/i;
function listNow(root) {
  const found = scan(root);
  const byBase = new Map(), byDir = new Map();
  for (const m of found) {
    const rel = path.relative(root, path.dirname(m.model)).split(path.sep).filter(Boolean);
    m.vendor = rel[0] || "";
    m.dir = rel.join("/");
    m.name = m.base;
    if (!byBase.has(m.base)) byBase.set(m.base, []);
    byBase.get(m.base).push(m);
    if (!byDir.has(m.dir)) byDir.set(m.dir, []);
    byDir.get(m.dir).push(m);
  }
  // The name is what a loadout stores, so it stays the file's own name; the same file name in two places gets its vendor in front,
  // or its whole folder when one vendor has it twice (unsloth's Qwen3.6-35B-A3B-GGUF and Qwen3.6-35B-A3B-MTP-GGUF).
  for (const same of byBase.values()) {
    if (same.length < 2) continue;
    const byVendor = new Set(same.map((m) => m.vendor)).size === same.length;
    for (const m of same) m.name = (byVendor ? m.vendor : m.dir) ? (byVendor ? m.vendor : m.dir) + "/" + m.base : m.base;
  }
  // What the pickers show: vendor/model (the models folder's own layout, as LM Studio shows it), with the size when that folder
  // holds more than one model.
  for (const [dir, ms] of byDir) {
    for (const m of ms) {
      const q = (m.base.match(QUANT) || [])[1];
      const several = ms.length > 1 && !(q && ms.filter((x) => (x.base.match(QUANT) || [])[1] === q).length > 1);
      m.label = !dir ? m.base : ms.length === 1 ? dir : dir + " · " + (several && q ? q : m.base);
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

function parseIni(text) {
  const sections = new Map();
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) { cur = sec[1]; if (!sections.has(cur)) sections.set(cur, []); continue; }
    const kv = line.match(/^([^=]+?)\s*=\s*(.*)$/);
    if (kv && cur !== null) sections.get(cur).push([kv[1].trim(), kv[2]]);
  }
  return sections;
}

function generate(folder) {
  const models = list(folder), off = visionOff();
  let old = new Map();
  try { old = parseIni(fs.readFileSync(PRESET_FILE, "utf8")); } catch {}
  const MANAGED = new Set(["model", "m", "mmproj", "mm"]);
  const lines = [
    "; Generated by llamacpp-harness from: " + path.resolve(folder),
    "; Regenerate from the Models page. Extra keys you add inside a section are kept.",
    "; Start llama-server with: --models-preset \"" + PRESET_FILE + "\"",
    "version = 1",
    "",
  ];
  if (old.has("*")) { lines.push("[*]"); for (const [k, v] of old.get("*")) lines.push(`${k} = ${v}`); lines.push(""); }
  for (const m of models) {
    if (m.strata) continue; // llama-server can't read .strata files
    lines.push(`[${m.name}]`);
    lines.push(`model = ${m.model}`);
    if (m.mmproj && !off.has(m.name)) lines.push(`mmproj = ${m.mmproj}`);
    for (const [k, v] of old.get(m.name) || []) if (!MANAGED.has(k.toLowerCase())) lines.push(`${k} = ${v}`);
    lines.push("");
  }
  const text = lines.join("\r\n");
  let prev = null;
  try { prev = fs.readFileSync(PRESET_FILE, "utf8"); } catch {}
  const changed = prev !== text;
  if (changed) fs.writeFileSync(PRESET_FILE, text, "utf8");
  return { file: PRESET_FILE, models, changed };
}

function info(folder) {
  let mtime = null;
  try { mtime = fs.statSync(PRESET_FILE).mtimeMs; } catch {}
  return { file: PRESET_FILE, exists: mtime !== null, mtime, models: folder ? list(folder) : [] };
}

module.exports = { invalidate, generate, info, list, visionOff, setVision, parseIni };
