// Loadouts: an engine + a model + how to run it. Each loadout is one named preset (section) in its engine's
// models.ini, so several loadouts can use the same model file with different settings, and switching between
// loadouts on one engine is just the router swapping models. Sampling settings are sent with each request instead.
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const P = require("./paths");
const llama = require("./llama");
const presets = require("./presets");
const FILE = P.loadouts;

// Load settings: key = llama.cpp's long flag name, which is also the models.ini key.
const FIELDS = [
  { key: "ctx-size", label: "Context size", type: "number", group: "Memory & speed", hint: "tokens", aliases: ["c"] },
  { key: "n-gpu-layers", label: "GPU layers", type: "text", group: "Memory & speed", hint: "number, auto or all", aliases: ["ngl", "gpu-layers"] },
  { key: "n-cpu-moe", label: "MoE layers on CPU", type: "number", group: "Memory & speed", hint: "keeps the experts of the first N layers in RAM", aliases: ["ncmoe"] },
  { key: "fit", label: "Fit to memory", type: "select", options: ["on", "off"], group: "Memory & speed", hint: "let llama.cpp size the model to the free memory" },
  { key: "fit-target", label: "Fit headroom", type: "number", group: "Memory & speed", hint: "MiB to leave free" },
  { key: "device", label: "Devices", type: "text", group: "Memory & speed", hint: "e.g. CUDA0, or CUDA0,CUDA1", aliases: ["dev"] },
  { key: "flash-attn", label: "Flash attention", type: "select", options: ["auto", "on", "off"], group: "Memory & speed", aliases: ["fa"] },
  { key: "cache-type-k", label: "KV cache type (K)", type: "select", options: ["f16", "bf16", "q8_0", "q5_1", "q5_0", "q4_1", "q4_0", "iq4_nl"], group: "Memory & speed", aliases: ["ctk"] },
  { key: "cache-type-v", label: "KV cache type (V)", type: "select", options: ["f16", "bf16", "q8_0", "q5_1", "q5_0", "q4_1", "q4_0", "iq4_nl"], group: "Memory & speed", aliases: ["ctv"] },
  { key: "batch-size", label: "Batch", type: "number", group: "Memory & speed", aliases: ["b"] },
  { key: "ubatch-size", label: "Micro-batch", type: "number", group: "Memory & speed", aliases: ["ub"] },
  { key: "threads", label: "Threads", type: "number", group: "Memory & speed", aliases: ["t"] },
  { key: "mlock", label: "Lock in RAM (mlock)", type: "bool", group: "Memory & speed" },
  { key: "no-mmap", label: "Don't memory-map (no-mmap)", type: "bool", group: "Memory & speed" },
  { key: "model-draft", label: "Draft model", type: "model", group: "Speculative decoding", hint: "a small model from the same family", aliases: ["md"] },
  { key: "draft-max", label: "Draft tokens", type: "number", group: "Speculative decoding", aliases: ["draft", "draft-n"] },
];
// Sampling: sent with each request (OpenAI / llama-server field names), so changing it needs no reload.
const SAMPLING = [
  { key: "temperature", label: "Temperature", hint: "e.g. 0.7", flag: "temp" },
  { key: "top_k", label: "Top-k", hint: "e.g. 20", flag: "top-k" },
  { key: "top_p", label: "Top-p", hint: "e.g. 0.8", flag: "top-p" },
  { key: "min_p", label: "Min-p", hint: "e.g. 0", flag: "min-p" },
  { key: "presence_penalty", label: "Presence penalty", hint: "e.g. 1.5 against repetition", flag: "presence-penalty" },
  { key: "repeat_penalty", label: "Repeat penalty", hint: "e.g. 1.05", flag: "repeat-penalty" },
];
const ALIAS = new Map(); // any flag spelling -> field key
for (const f of FIELDS) { ALIAS.set(f.key, f.key); for (const a of f.aliases || []) ALIAS.set(a, f.key); }
ALIAS.set("flash-attention", "flash-attn"); ALIAS.set("gpu-layers", "n-gpu-layers");
const SAMPLE_BY_FLAG = new Map(SAMPLING.map((s) => [s.flag, s.key]));

let data = null; // { loadouts: [...] }
const modelsFolder = () => { try { return JSON.parse(fs.readFileSync(P.config, "utf8")).modelsFolder || P.models; } catch { return P.models; } };
const localModels = () => { try { return presets.list(modelsFolder()); } catch { return []; } };

function load() {
  if (data) return data;
  try { data = JSON.parse(fs.readFileSync(FILE, "utf8")); if (!Array.isArray(data.loadouts)) throw 0; }
  catch { data = migrate(); }
  moveEngineFlags();
  return data;
}
// Engines have no flags of their own: anything left there (e.g. --metrics) becomes "Other flags" on its loadouts.
function moveEngineFlags() {
  for (const e of llama.all()) {
    const flags = (e.extraArgs || []).join(" ").trim();
    if (!flags) continue;
    for (const l of data.loadouts.filter((x) => x.engine === e.id)) if (!` ${l.other || ""} `.includes(` ${flags} `)) l.other = `${l.other || ""} ${flags}`.trim();
    llama.update(e.id, { extraArgs: [] });
    save();
    console.log(`[loadouts] moved engine flags "${flags}" from ${e.name} into its loadouts`);
  }
}

// ---------- the model's own context length, from its GGUF header ----------
// Reads only the metadata at the start of the file (stops at <arch>.context_length). Cached per file and mtime.
const ctxCache = new Map();
function trainedContext(file) {
  let st; try { st = fs.statSync(file); } catch { return null; }
  const k = file + "|" + st.mtimeMs;
  if (ctxCache.has(k)) return ctxCache.get(k);
  let out = null, fd;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(Math.min(st.size, 8 * 1024 * 1024));
    fs.readSync(fd, buf, 0, buf.length, 0);
    if (buf.toString("latin1", 0, 4) !== "GGUF") throw 0;
    let p = 8; // magic + version
    p += 8; const n = Number(buf.readBigUInt64LE(p)); p += 8; // tensor count, kv count
    const str = () => { const len = Number(buf.readBigUInt64LE(p)); p += 8; const s = buf.toString("utf8", p, p + len); p += len; return s; };
    const SIZE = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
    const num = (t) => { const v = t === 4 ? buf.readUInt32LE(p) : t === 5 ? buf.readInt32LE(p) : t === 10 ? Number(buf.readBigUInt64LE(p)) : t === 11 ? Number(buf.readBigInt64LE(p)) : t === 2 ? buf.readUInt16LE(p) : null; p += SIZE[t] || 0; return v; };
    const skip = (t) => {
      if (t === 8) { str(); return; }
      if (t === 9) { const et = buf.readUInt32LE(p); p += 4; const cnt = Number(buf.readBigUInt64LE(p)); p += 8; if (et === 8) for (let i = 0; i < cnt; i++) str(); else p += cnt * (SIZE[et] || 0); return; }
      p += SIZE[t] || 0;
    };
    let arch = null;
    for (let i = 0; i < n && p < buf.length - 16; i++) {
      const key = str(), t = buf.readUInt32LE(p); p += 4;
      if (key === "general.architecture" && t === 8) { arch = str(); continue; }
      if (arch && key === `${arch}.context_length`) { out = num(t); break; }
      skip(t);
    }
  } catch { out = null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  ctxCache.set(k, out);
  return out;
}
const DEFAULT_CTX = 32768;
function save() { P.writeJson(FILE, data); }
const list = () => load().loadouts;
const get = (id) => list().find((l) => l.id === id) || null;

// Splits "--flag value -x v --bool" into [[flag, value|true], ...].
function parseFlags(arr) {
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const t = arr[i];
    if (!/^--?[A-Za-z]/.test(t)) continue;
    const name = t.replace(/^--?/, "");
    const next = arr[i + 1];
    if (next !== undefined && !/^--?[A-Za-z]/.test(next)) { out.push([name, next]); i++; } else out.push([name, true]);
  }
  return out;
}
const tokens = (s) => [...String(s || "").matchAll(/"([^"]*)"|(\S+)/g)].map((m) => (m[1] !== undefined ? m[1] : m[2]));

// First run: each section of the old models.ini becomes a loadout on the active engine (same id as the model, so
// existing sessions keep working). Flags from the old engine arguments that are really model settings move into them.
function migrate() {
  const d = { loadouts: [] };
  const eng = llama.active();
  let sections = new Map();
  try { sections = presets.parseIni(fs.readFileSync(P.presets, "utf8")); } catch {}
  const models = localModels();
  const moved = [], keepEngine = [];
  if (eng) for (const [name, val] of parseFlags(eng.extraArgs || [])) {
    const key = ALIAS.get(name);
    if (key) moved.push([key, val]); else keepEngine.push(name.length === 1 ? "-" + name : "--" + name, ...(val === true ? [] : [String(val)]));
  }
  for (const [name, kv] of sections) {
    if (name === "*") continue;
    const m = models.find((x) => x.name === name);
    const modelPath = (kv.find(([k]) => k === "model" || k === "m") || [])[1];
    if (!m && !modelPath) continue;
    const l = { id: name, name, engine: eng ? eng.id : "", model: m ? m.name : name, modelPath: m ? undefined : modelPath,
      vision: kv.some(([k]) => k === "mmproj" || k === "mm"), load: {}, other: "", sampling: {} };
    const other = [];
    for (const [k, v] of kv) {
      if (["model", "m", "mmproj", "mm"].includes(k)) continue;
      const key = ALIAS.get(k), sk = SAMPLE_BY_FLAG.get(k);
      if (key) l.load[key] = v === "true" ? true : v;
      else if (sk) l.sampling[sk] = v;
      else other.push(`--${k} ${v}`);
    }
    for (const [k, v] of moved) if (!(k in l.load)) l.load[k] = v;
    l.other = other.join(" ");
    d.loadouts.push(l);
  }
  if (eng && moved.length) llama.update(eng.id, { extraArgs: keepEngine });
  data = d;
  save();
  if (d.loadouts.length) console.log(`[loadouts] created ${d.loadouts.length} loadout(s) from models.ini${moved.length ? `; moved ${moved.map(([k]) => k).join(", ")} from the engine flags into them` : ""}`);
  return d;
}

// ---------- validation and editing ----------
function clean(input, prev = {}) {
  const l = { ...prev };
  if (typeof input.name === "string") l.name = input.name.trim().slice(0, 80);
  if (typeof input.engine === "string") l.engine = input.engine;
  if (typeof input.model === "string") l.model = input.model;
  if (typeof input.vision === "boolean") l.vision = input.vision;
  if (typeof input.other === "string") l.other = input.other.trim().slice(0, 2000);
  if (input.load && typeof input.load === "object") {
    l.load = {};
    for (const f of FIELDS) {
      const v = input.load[f.key];
      if (v === undefined || v === null || v === "" || v === false) continue;
      if (f.type === "bool") { l.load[f.key] = true; continue; }
      if (f.type === "number" && !/^-?\d+(\.\d+)?$/.test(String(v).trim())) throw Object.assign(new Error(`${f.label} must be a number`), { status: 400 });
      if (f.type === "select" && !f.options.includes(String(v))) throw Object.assign(new Error(`${f.label}: unknown value "${v}"`), { status: 400 });
      l.load[f.key] = String(v).trim();
    }
  }
  if (input.sampling && typeof input.sampling === "object") {
    l.sampling = {};
    for (const s of SAMPLING) {
      const v = input.sampling[s.key];
      if (v === undefined || v === null || v === "") continue;
      if (!/^-?\d+(\.\d+)?$/.test(String(v).trim())) throw Object.assign(new Error(`${s.label} must be a number`), { status: 400 });
      l.sampling[s.key] = String(v).trim();
    }
  }
  if (!l.name) throw Object.assign(new Error("The loadout needs a name"), { status: 400 });
  if (!llama.byId(l.engine)) throw Object.assign(new Error("Pick an engine"), { status: 400 });
  if (!l.model || !(localModels().some((m) => m.name === l.model) || l.modelPath)) throw Object.assign(new Error("Pick a model from the models folder"), { status: 400 });
  if (l.load?.["model-draft"] && !localModels().some((m) => m.name === l.load["model-draft"])) throw Object.assign(new Error("The draft model isn't in the models folder"), { status: 400 });
  return l;
}
function newId(name) {
  const base = String(name || "loadout").trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "loadout";
  let id = base, n = 2;
  while (get(id)) id = `${base}-${n++}`;
  return id;
}
function create(input) {
  const m = localModels().find((x) => x.name === input.model);
  const max = m ? trainedContext(m.model) : null;
  const defaults = { "ctx-size": String(max ? Math.min(max, DEFAULT_CTX) : DEFAULT_CTX) }; // blank would mean the model's full context
  const l = clean({ name: input.name || input.model, engine: input.engine || llama.active()?.id || "", vision: m ? !!m.mmproj : false, sampling: {}, other: "", ...input,
    load: input.load && Object.keys(input.load).length ? input.load : defaults });
  l.id = newId(input.name || input.model);
  list().push(l);
  save();
  return l;
}
function update(id, input) {
  const i = list().findIndex((l) => l.id === id);
  if (i < 0) throw Object.assign(new Error("No such loadout"), { status: 404 });
  list()[i] = { ...clean(input, list()[i]), id };
  save();
  return list()[i];
}
function remove(id) {
  const before = list().length;
  data.loadouts = list().filter((l) => l.id !== id);
  if (data.loadouts.length === before) throw Object.assign(new Error("No such loadout"), { status: 404 });
  save();
}
function removeForModel(name) { const n = list().length; data.loadouts = list().filter((l) => l.model !== name); if (list().length !== n) save(); }

// ---------- models.ini per engine ----------
function sectionLines(l, models) {
  const m = models.find((x) => x.name === l.model);
  const file = m ? m.model : l.modelPath;
  if (!file) return null;
  const out = [`[${l.id}]`, `model = ${file}`];
  if (l.vision && m && m.mmproj) out.push(`mmproj = ${m.mmproj}`);
  for (const [k, v] of Object.entries(l.load || {})) {
    if (k === "model-draft") { const dm = models.find((x) => x.name === v); if (dm) out.push(`model-draft = ${dm.model}`); continue; }
    out.push(`${k} = ${v === true ? "true" : v}`);
  }
  for (const [k, v] of parseFlags(tokens(l.other))) out.push(`${k} = ${v === true ? "true" : v}`);
  return out;
}
function iniFor(engineId) {
  const models = localModels();
  const lines = ["; Generated by qqstudio from Settings > Loadouts. Edit loadouts there; changes here are overwritten.", "version = 1", ""];
  for (const l of list().filter((x) => x.engine === engineId)) {
    const s = sectionLines(l, models);
    if (s) lines.push(...s, "");
  }
  return lines.join("\r\n");
}
// Writes every engine's models.ini; returns the ids of engines whose file changed.
function writeAll() {
  const changed = new Set();
  for (const e of llama.list ? [] : []) void e;
  for (const e of require("./llama").byId ? allEngines() : []) {
    const file = llama.presetOf(e), text = iniFor(e.id);
    let prev = null;
    try { prev = fs.readFileSync(file, "utf8"); } catch {}
    if (prev !== text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, "utf8"); changed.add(e.id); }
  }
  return changed;
}
const allEngines = () => llama.all();

// ---------- what each engine build supports (from its --help) ----------
const helpCache = new Map(); // engine id -> { exe, mtime, flags: Set | null }
const helpRunning = new Map(); // engine id -> promise of the --help run in progress (shared, so it never runs twice at once)
function supported(e) {
  if (helpRunning.has(e.id)) return helpRunning.get(e.id);
  const p = supportedNow(e).finally(() => helpRunning.delete(e.id));
  helpRunning.set(e.id, p);
  return p;
}
function supportedNow(e) {
  return new Promise((resolve) => {
    let mtime = 0;
    try { mtime = fs.statSync(e.exe).mtimeMs; } catch {}
    const c = helpCache.get(e.id);
    if (c && c.exe === e.exe && c.mtime === mtime) return resolve(c.flags);
    const cacheFile = path.join(P.enginesDir, e.id, "help.json");
    try { const j = JSON.parse(fs.readFileSync(cacheFile, "utf8")); if (j.exe === e.exe && j.mtime === mtime) { const f = new Set(j.flags); helpCache.set(e.id, { exe: e.exe, mtime, flags: f }); return resolve(f); } } catch {}
    const args = path.basename(e.exe).toLowerCase().replace(/\.exe$/, "") === "llama" ? ["serve", "--help"] : ["--help"];
    execFile(e.exe, args, { timeout: 20000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, out, errOut) => {
      const text = `${out || ""}\n${errOut || ""}`;
      const found = new Set([...text.matchAll(/(?:^|[\s,])--?([a-z][a-z0-9-]*)/gim)].map((m) => m[1]));
      const flags = found.size > 20 ? found : null; // too little output: the build couldn't tell us, so show everything
      helpCache.set(e.id, { exe: e.exe, mtime, flags });
      if (flags) { try { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify({ exe: e.exe, mtime, flags: [...flags] })); } catch {} }
      resolve(flags);
    });
  });
}
async function fieldSupport(e) {
  const flags = await Promise.race([supported(e), new Promise((r) => setTimeout(() => r(undefined), 3000))]);
  if (flags === undefined) return null; // still running: show all fields this time
  if (!flags) return null;
  const out = {};
  for (const f of FIELDS) out[f.key] = flags.has(f.key) || (f.aliases || []).some((a) => flags.has(a));
  return out;
}

// Request fields for a model id (= loadout id): its sampling settings.
function samplingFor(id) {
  const l = get(id);
  if (!l || !l.sampling) return {};
  return Object.fromEntries(Object.entries(l.sampling).map(([k, v]) => [k, Number(v)]));
}
// Whether a loadout can see images: vision on and the model has a projector.
function visionOf(id) {
  const l = get(id);
  if (!l) return null;
  const m = localModels().find((x) => x.name === l.model);
  return !!(l.vision && m && m.mmproj);
}

module.exports = { FIELDS, SAMPLING, DEFAULT_CTX, trainedContext, list, get, create, update, remove, removeForModel, iniFor, writeAll, fieldSupport, samplingFor, visionOf, localModels, load };
