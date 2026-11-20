// Loadouts: an engine + a model + how to run it. A loadout runs as its own llama-server process (one at a time, see
// llama.js), started with the loadout's model and flags; several loadouts can use the same model file with different
// settings. Sampling settings are sent with each request instead, so changing them needs no reload.
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");

const P = require("./paths");
const llama = require("./llama");
const presets = require("./presets");
const FILE = P.loadouts;

// Load settings: key = llama.cpp's long flag name (passed as --<key>).
const FIELDS = [
  { key: "ctx-size", help: "How many tokens the model can hold at once: the conversation, tools and reply together. More uses more memory. Blank uses the model's full trained context.", label: "Context size", type: "number", group: "Memory & speed", hint: "tokens", aliases: ["c"] },
  { key: "n-gpu-layers", help: "How many of the model's layers run on the GPU. auto lets llama.cpp decide; all puts them all there.", label: "GPU layers", type: "text", group: "Memory & speed", hint: "number, auto or all", aliases: ["ngl", "gpu-layers"] },
  { key: "n-cpu-moe", help: "For mixture-of-experts models: keeps the experts of the first N layers in system RAM, to fit a model that's too big for the GPU.", label: "MoE layers on CPU", type: "number", group: "Memory & speed", hint: "keeps the experts of the first N layers in RAM", aliases: ["ncmoe"] },
  { key: "fit", help: "Lets llama.cpp shrink settings such as context and GPU layers so the model fits in free memory.", label: "Fit to memory", type: "select", options: ["on", "off"], group: "Memory & speed", hint: "let llama.cpp size the model to the free memory" },
  { key: "fit-target", help: "How much memory to leave free on each GPU when fitting, in MiB.", label: "Fit headroom", type: "number", group: "Memory & speed", hint: "MiB to leave free" },
  { key: "device", help: "Which GPUs to use, e.g. CUDA0, or CUDA0,CUDA1 to split across two. Blank uses all.", label: "Devices", type: "text", group: "Memory & speed", hint: "e.g. CUDA0, or CUDA0,CUDA1", aliases: ["dev"] },
  { key: "flash-attn", help: "A faster way to compute attention that uses less memory. auto turns it on where supported.", label: "Flash attention", type: "select", options: ["auto", "on", "off"], group: "Memory & speed", aliases: ["fa"] },
  { key: "cache-type-k", help: "Precision of the context memory (keys). q8_0 roughly halves its size with little quality loss.", label: "KV cache type (K)", type: "select", options: ["f16", "bf16", "q8_0", "q5_1", "q5_0", "q4_1", "q4_0", "iq4_nl"], group: "Memory & speed", aliases: ["ctk"] },
  { key: "cache-type-v", help: "Precision of the context memory (values). Quantized values need flash attention.", label: "KV cache type (V)", type: "select", options: ["f16", "bf16", "q8_0", "q5_1", "q5_0", "q4_1", "q4_0", "iq4_nl"], group: "Memory & speed", aliases: ["ctv"] },
  { key: "batch-size", help: "Tokens read per step when processing the prompt. Larger reads long prompts faster but uses more memory.", label: "Batch", type: "number", group: "Memory & speed", aliases: ["b"] },
  { key: "ubatch-size", help: "Tokens sent to the GPU per pass; at most Batch. Larger can be faster and uses more memory.", label: "Micro-batch", type: "number", group: "Memory & speed", aliases: ["ub"] },
  { key: "threads", help: "CPU threads used for generating. Blank uses llama.cpp's default.", label: "Threads", type: "number", group: "Memory & speed", aliases: ["t"] },
  { key: "mlock", help: "Keeps the model locked in RAM so the system can't swap it out to disk.", label: "Lock in RAM (mlock)", type: "bool", group: "Memory & speed" },
  { key: "no-mmap", help: "Reads the whole model into memory at start instead of mapping the file. Slower to load; can help on some systems.", label: "Don't memory-map (no-mmap)", type: "bool", group: "Memory & speed" },
  { key: "model-draft", help: "A small model of the same family that guesses ahead for the main model, which can speed up replies.", label: "Draft model", type: "model", group: "Speculative decoding", hint: "a small model from the same family", aliases: ["md"] },
  { key: "draft-max", help: "How many tokens the draft model guesses at a time.", label: "Draft tokens", type: "number", group: "Speculative decoding", aliases: ["draft", "draft-n"] },
];
// Sampling: sent with each request (OpenAI / llama-server field names), so changing it needs no reload.
// Strata's settings (strata launch flags; Strata's docs/TERMINAL_LAUNCH.md). Context size is shared
// with llama.cpp's field; vision is the loadout's Vision switch.
const STRATA_FIELDS = [
  { key: "ctx-size", label: "Context size", type: "number", group: "Basics", flag: "context",
    help: "How many tokens the model can hold at once: the conversation, tools and reply together. More uses more memory. Blank: Strata's default." },
  { key: "kv", label: "Context memory format", type: "select", options: ["int8", "q4_0", "k8v4", "fp16"], group: "Memory & speed", flag: "kv",
    help: "How the conversation memory is stored. int8 is Strata's default; q4_0 uses half the memory; fp16 is the most precise and largest." },
  { key: "parallel", label: "Parallel requests", type: "number", group: "Memory & speed", flag: "parallel",
    help: "How many requests Strata answers at the same time, 1 to 8. Blank: fit to your graphics card. Sub-agents need more than one." },
  { key: "gpu", label: "Graphics cards", type: "text", group: "Memory & speed", flag: "gpu", hint: "e.g. 0, or 0,1",
    help: "Which graphics cards Strata uses, by number: 0 for the first, 0,1 to use two. Blank: Strata's choice (usually one card)." },
  { key: "vram-reserve", label: "Graphics memory to leave free", type: "number", group: "Memory & speed", hint: "MiB, e.g. 2048",
    help: "How much graphics memory Strata leaves unused for other programs (the desktop, a browser, games), in MiB. Strata fills the rest with model experts, so more free memory can mean a little slower answers. Blank: Strata's default (700 MiB when pictures are read on the graphics card, else none)." },
  { key: "reader", label: "Picture reader", type: "select", options: ["gpu", "cpu"], group: "Memory & speed",
    help: "Where pictures are read when Vision is on. Blank: Strata decides (the GPU from 24 GB of graphics memory, else the CPU)." },
  { key: "drafting", label: "Drafting", type: "select", options: ["auto", "mtp", "dflash2", "off"], group: "Speculative decoding", flag: "drafting",
    help: "A small drafter guesses words ahead to make answers faster. auto picks DFlash2 for Flash-Next where it can; off saves memory. The first start downloads the drafter." },
  { key: "tune", label: "Tuning", type: "select", options: ["quick", "thorough"], group: "Speculative decoding", flag: "tune",
    help: "Measure the fastest settings for this PC before serving: quick takes about 20 minutes, thorough up to 2 hours. Done once; the result is reused." },
];
// On a Mac, Strata runs on Metal with unified memory: it sets its own context-memory format and has no cards to pick or
// graphics memory to leave free, so those fields aren't offered (or passed) there.
const STRATA_MAC_OFF = new Set(["kv", "gpu", "vram-reserve"]);
if (process.platform === "darwin") STRATA_FIELDS.splice(0, STRATA_FIELDS.length, ...STRATA_FIELDS.filter((f) => !STRATA_MAC_OFF.has(f.key)));
// Model files Strata can run: exactly the files its installer lists (Hugging Face repo, path, byte size, per catalog size),
// from its catalog (strata_catalog.py). Until that list has been read, a loose name match stands in.
const STRATA_MODEL = /flash[-_ ]?next/i;
const strataEngine = () => llama.all().find((e) => e.type === "strata");
let strataIdx = { at: -1 };
function strataIndex() {
  const e = strataEngine(), c = e && llama.strataCatalogCached(e.id);
  if (!c?.files?.length || !c.files[0].sizes) return null; // (an older list without sizes: refreshed by the server)
  if (strataIdx.at === c.at) return strataIdx;
  const byPath = new Map(), byBase = new Map(), sets = new Map(), rows = new Map();
  for (const r of c.rows || []) rows.set(r.family + "/" + r.model, r);
  for (const f of c.files) {
    const k = f.family + "/" + f.model;
    byPath.set(f.repo + "/" + f.path, f);
    byBase.set(path.posix.basename(f.path).toLowerCase(), f);
    if (!sets.has(k)) sets.set(k, []);
    sets.get(k).push(f);
  }
  strataIdx = { at: c.at, byPath, byBase, sets, rows, repos: new Set(c.files.map((f) => f.repo)) };
  return strataIdx;
}
// A Hugging Face search result: is it one of the repos Strata's catalog downloads from?
const strataRepo = (repo) => !!strataIndex()?.repos.has(repo);
// A file group of a Hugging Face repo ({paths, sizes: {path: bytes}}): null, or {title, words} when it is a full set Strata lists,
// with different: true when a file's size isn't the one Strata pinned (the repo changed it since: Strata's check would refuse it).
function strataFiles(repo, g) {
  const ix = strataIndex();
  if (!ix || !ix.repos.has(repo)) return null;
  const hits = g.paths.map((p) => ix.byPath.get(repo + "/" + p));
  if (!hits.length || hits.some((h) => !h)) return null;
  const k = hits[0].family + "/" + hits[0].model, set = ix.sets.get(k) || [];
  if (set.length !== hits.length) return null;
  const r = ix.rows.get(k);
  return { title: r ? r.title : k, words: r ? r.words : "", different: hits.some((h) => h.sizes?.length && g.sizes?.[repo + "/" + h.path] && !h.sizes.includes(g.sizes[repo + "/" + h.path])) };
}
// A model in the models folder: all files of one of Strata's sets, beside each other, at the pinned sizes.
function strataLocal(m) {
  const ix = strataIndex();
  if (!ix) return STRATA_MODEL.test(m.name) || STRATA_MODEL.test(m.model);
  const f = ix.byBase.get(path.basename(m.model).toLowerCase());
  if (!f) return false;
  const dir = path.dirname(m.model);
  return (ix.sets.get(f.family + "/" + f.model) || []).every((x) => { try { const n = fs.statSync(path.join(dir, path.posix.basename(x.path))).size; return !x.sizes?.length || x.sizes.includes(n); } catch { return false; } });
}
const strataModels = () => localModels().filter(strataLocal);
const isStrata = (engineId) => llama.byId(engineId)?.type === "strata";

const SAMPLING = [
  { key: "temperature", help: "Randomness. Lower is more focused and repeatable; higher is more varied.", label: "Temperature", hint: "e.g. 0.7", flag: "temp" },
  { key: "top_k", help: "Picks only from the K most likely next tokens.", label: "Top-k", hint: "e.g. 20", flag: "top-k" },
  { key: "top_p", help: "Picks only from the most likely tokens that together make up P of the probability.", label: "Top-p", hint: "e.g. 0.8", flag: "top-p" },
  { key: "min_p", help: "Drops tokens less likely than this fraction of the most likely one.", label: "Min-p", hint: "e.g. 0", flag: "min-p" },
  { key: "presence_penalty", help: "Discourages reusing words already used; helps against repetition loops.", label: "Presence penalty", hint: "e.g. 1.5 against repetition", flag: "presence-penalty" },
  { key: "repeat_penalty", help: "Penalizes recently repeated tokens. 1 means off.", label: "Repeat penalty", hint: "e.g. 1.05", flag: "repeat-penalty" },
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
  const eng = llama.defaultEngine();
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
  if (typeof input.modelPath === "string") { if (input.modelPath) l.modelPath = input.modelPath; else delete l.modelPath; } // set by the server only
  if (typeof input.hfRepo === "string") { if (input.hfRepo) l.hfRepo = input.hfRepo; else delete l.hfRepo; }
  if (typeof input.vision === "boolean") l.vision = input.vision;
  if (typeof input.other === "string") l.other = input.other.trim().slice(0, 2000);
  if (input.load && typeof input.load === "object") {
    l.load = {};
    for (const f of isStrata(l.engine) ? STRATA_FIELDS : FIELDS) {
      const v = input.load[f.key];
      if (v === undefined || v === null || v === "" || v === false) continue;
      if (f.type === "bool") { l.load[f.key] = true; continue; }
      if (f.key === "gpu" && !/^\d+(\s*,\s*\d+)*$/.test(String(v).trim())) throw Object.assign(new Error("Graphics cards: card numbers separated by commas, e.g. 0,1"), { status: 400 });
      if (f.key === "parallel" && !(Number(v) >= 1 && Number(v) <= 8)) throw Object.assign(new Error("Parallel requests must be 1 to 8"), { status: 400 });
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
  if (isStrata(l.engine)) { // Strata runs files from the models folder that it supports
    if (!strataModels().some((m) => m.name === l.model)) throw Object.assign(new Error("Strata runs the Qwen3.8-Flash-Next files its catalog lists (they're tagged Strata on the Models tab); pick one of those"), { status: 400 });
    delete l.modelPath; delete l.hfRepo;
    return l;
  }
  if (!l.model || !(localModels().some((m) => m.name === l.model) || l.modelPath || l.hfRepo)) throw Object.assign(new Error("Pick a model from the models folder, or one the engine lists"), { status: 400 });
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
  // Blank would mean the model's full context for llama.cpp; Strata fits the context to the PC itself, so it starts blank.
  const defaults = isStrata(input.engine) ? {} : { "ctx-size": String(max ? Math.min(max, DEFAULT_CTX) : DEFAULT_CTX) };
  const l = clean({ name: input.name || input.model, engine: input.engine || llama.defaultEngine()?.id || "", vision: m ? !!m.mmproj : false, sampling: {}, other: "", ...input,
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

// ---------- the llama-server command line for a loadout ----------
// Load settings use llama.cpp's long flag names, so each becomes --<key> <value> (or just --<key> when on).
// Returns null when the model can't be found.
function argsFor(l, models = localModels()) {
  if (isStrata(l.engine)) return strataArgs(l, models);
  const m = models.find((x) => x.name === l.model);
  const file = m ? m.model : l.modelPath;
  if (!file && !l.hfRepo) return null;
  const a = file ? ["--model", file] : ["--hf-repo", l.hfRepo]; // hf-repo: from llama.cpp's download cache
  if (l.vision && m && m.mmproj) a.push("--mmproj", m.mmproj);
  for (const [k, v] of Object.entries(l.load || {})) {
    if (k === "model-draft") { const dm = models.find((x) => x.name === v); if (dm) a.push("--model-draft", dm.model); continue; }
    if (v === true) a.push("--" + k); else a.push("--" + k, String(v));
  }
  a.push(...tokens(l.other));
  return a;
}
// What llama.js needs to run a loadout. sig changes whenever the process would start differently (settings, model
// file, engine), so a running loadout whose sig no longer matches gets reloaded.
// `strata launch` flags for a loadout: the model's folder, then its settings. Other flags are passed as typed.
function strataArgs(l, models) {
  const m = models.find((x) => x.name === l.model);
  if (!m) return null;
  const a = ["--model-path", path.dirname(m.model)];
  const load = l.load || {};
  if (load["ctx-size"]) a.push("--context", String(load["ctx-size"]));
  const mac = process.platform === "darwin";
  if (load.kv && !mac) a.push("--kv", load.kv);
  if (load.parallel) a.push("--parallel", String(load.parallel));
  if (load.gpu && !mac) a.push("--gpu", String(load.gpu).replace(/\s+/g, ""));
  if (load["vram-reserve"] && !mac) a.push("--set", `vram-reserve-mib=${Math.max(0, Math.round(Number(load["vram-reserve"])))}`); // an engine option: Strata's --set
  a.push("--vision", l.vision === false ? "off" : load.reader || "on");
  if (load.drafting) a.push("--drafting", load.drafting);
  if (load.tune) a.push("--tune", load.tune);
  a.push(...tokens(l.other));
  return a;
}
function spec(id) {
  const l = get(id);
  if (!l) return null;
  const e = llama.byId(l.engine), args = argsFor(l);
  if (!e || !args) return null;
  return { loadout: l.id, name: l.name, engine: e.id, args, sig: JSON.stringify([e.exe, args]) };
}
function commandLine(l) {
  const e = llama.byId(l.engine), args = argsFor(l);
  if (!args) return "(the model file can't be found)";
  const q = (x) => (/[\s"]/.test(x) ? `"${x}"` : x);
  if (e && e.type === "strata") return ["strata", "launch", ...args.map(q), "--port <port> --access local --no-tui --yes --restart --save-preset " + q(l.id)].join(" ");
  return [e ? e.exe : "llama-server", ...(e ? llama.subcmd(e.exe) : []), ...args, "--jinja --host 127.0.0.1 --port <port> --alias " + l.id].map((x, i, all) => (i === all.length - 1 ? x : q(x))).join(" ");
}

// ---------- models in llama.cpp's download cache (-hf) ----------
// Models llama.cpp downloaded itself, outside the models folder. Newer builds keep them in the Hugging Face cache
// (models--<owner>--<repo>\snapshots\<rev>\…); older ones in their own cache folder with manifest files.
// Named <owner>/<repo>:<quant>, the way llama.cpp names them. Cached for a minute.
let cacheList = null;
function cachedModels() {
  if (cacheList && Date.now() - cacheList.at < 60000) return cacheList.value;
  const home = os.homedir(), found = new Map();
  const hub = process.env.HF_HUB_CACHE || (process.env.HF_HOME ? path.join(process.env.HF_HOME, "hub") : path.join(home, ".cache", "huggingface", "hub"));
  const add = (name, file) => { try { const t = fs.statSync(file).mtimeMs; if (!found.has(name) || found.get(name).t < t) found.set(name, { name, path: file, t }); } catch {} };
  const quant = (f) => (path.basename(f).replace(/(-\d{5}-of-\d{5})?\.gguf$/i, "").match(/[-_.]((?:UD-)?(?:I?Q\d[\w]*|BF16|F16|F32|MXFP4[\w]*))$/i) || [])[1];
  const ok = (f) => /\.gguf$/i.test(f) && !/mmproj/i.test(path.basename(f)) && !/-(?!00001)\d{5}-of-\d{5}\.gguf$/i.test(f);
  try {
    for (const d of fs.readdirSync(hub)) {
      const m = d.match(/^models--([^-]+(?:-[^-]+)*?)--(.+)$/);
      if (!m) continue;
      const snaps = path.join(hub, d, "snapshots");
      let revs = []; try { revs = fs.readdirSync(snaps); } catch {}
      for (const rev of revs) (function walk(dir, depth) {
        let items = []; try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch {}
        for (const x of items) {
          const f = path.join(dir, x.name);
          if (x.isDirectory()) { if (depth < 3) walk(f, depth + 1); }
          else if (ok(f)) add(`${m[1]}/${m[2]}:${quant(f) || path.basename(f).replace(/\.gguf$/i, "")}`, f);
        }
      })(path.join(snaps, rev), 0);
    }
  } catch {}
  const old = process.env.LLAMA_CACHE || (process.platform === "win32" ? path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "llama.cpp") : path.join(home, ".cache", "llama.cpp"));
  try {
    for (const f of fs.readdirSync(old)) {
      const m = f.match(/^manifest=([^=]+)=([^=]+)=(.+)\.json$/);
      if (!m) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(old, f), "utf8")), r = j.ggufFile?.rfilename;
        if (r) add(`${m[1]}/${m[2]}:${m[3]}`, path.join(old, `${m[1]}_${m[2]}_${r.replace(/\//g, "_")}`));
      } catch {}
    }
  } catch {}
  const value = [...found.values()].map(({ name, path: p }) => ({ name, path: p })).sort((a, b) => a.name.localeCompare(b.name));
  cacheList = { at: Date.now(), value };
  return value;
}

// ---------- what each engine build supports (from its --help) ----------
const helpCache = new Map(); // engine id -> { exe, mtime, flags: Set | null }
const helpRunning = new Map(); // engine id -> promise of the --help run in progress (shared, so it never runs twice at once)
function supported(e) {
  if (e.type === "strata") return Promise.resolve(null);
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

module.exports = { FIELDS, STRATA_FIELDS, strataModels, strataRepo, strataFiles, isStrata, SAMPLING, DEFAULT_CTX, trainedContext, list, get, create, update, remove, removeForModel, argsFor, spec, commandLine, cachedModels, fieldSupport, samplingFor, visionOf, localModels, load };
