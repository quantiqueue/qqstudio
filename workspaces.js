// Workspaces: %USERPROFILE%\.qqstudio\workspaces\<id>\
//   workspace.json   {name, description, created, memory}   memory: workspace memory on (memory.js)
//   memory.md        the workspace memory (memory.js)
//   sessions\<id>.json   one file per session (chat)
//   files\           files the user drops in, and files the model creates without another destination
// "Default" always exists and can't be deleted. Session ids are unique across workspaces; an index maps id -> workspace.
const fs = require("fs");
const path = require("path");
const DATA = require("./paths");
const memory = require("./memory");

const ROOT = DATA.workspaces;
const DEFAULT = "Default";
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,60}$/;
const SESSION_RE = /^[a-z0-9]{6,40}$/;
const index = new Map(); // session id -> workspace id

const wsDir = (id) => (ID_RE.test(id || "") ? path.join(ROOT, id) : null);
const sessionsDir = (id) => path.join(ROOT, id, "sessions");
// A workspace's files folder: its own folder, or one it was given (workspace.json "dir", e.g. qqstudio run's task folder).
const dirOf = new Map(); // id -> the given folder (or null), read once
const filesDir = (id) => {
  if (!dirOf.has(id)) { const m = DATA.readJson(metaFile(id), {}); dirOf.set(id, typeof m.dir === "string" && m.dir ? m.dir : null); }
  return dirOf.get(id) || path.join(ROOT, id, "files");
};
const metaFile = (id) => path.join(ROOT, id, "workspace.json");
const exists = (id) => !!wsDir(id) && fs.existsSync(metaFile(id));

function ensure(id, name) {
  wsIds = null;
  for (const d of [sessionsDir(id), filesDir(id)]) fs.mkdirSync(d, { recursive: true });
  if (!fs.existsSync(metaFile(id))) DATA.writeJson(metaFile(id), { name: name || id, description: "", created: Date.now() });
}

// Startup: make Default, adopt hand-made folders, move the old chats\ folder into Default, build the index.
function init() {
  fs.mkdirSync(ROOT, { recursive: true });
  ensure(DEFAULT, "Default");
  for (const d of fs.readdirSync(ROOT, { withFileTypes: true })) if (d.isDirectory() && ID_RE.test(d.name)) ensure(d.name);
  const old = DATA.chats;
  if (fs.existsSync(old)) {
    let n = 0;
    for (const f of fs.readdirSync(old)) {
      if (!f.endsWith(".json")) continue;
      const to = path.join(sessionsDir(DEFAULT), f);
      if (fs.existsSync(to)) continue;
      try { fs.renameSync(path.join(old, f), to); n++; } catch {}
    }
    try { if (!fs.readdirSync(old).length) fs.rmdirSync(old); } catch {}
    if (n) console.log(`[workspaces] moved ${n} session(s) from chats\\ into ${DEFAULT}`);
  }
  for (const w of ids()) for (const f of fs.readdirSync(sessionsDir(w))) if (f.endsWith(".json")) index.set(f.slice(0, -5), w);
  resyncSessions().catch(() => {}); // the sessions list is ready before the first page asks
}

// The workspace ids: read again after 30 s, or at once after create/remove (folders made by hand show within 30 s).
let wsIds = null, wsIdsAt = 0;
function ids() {
  if (!wsIds || Date.now() - wsIdsAt > 30000) {
    wsIds = fs.readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory() && exists(d.name)).map((d) => d.name);
    wsIdsAt = Date.now();
  }
  return [...wsIds];
}
function info(id) {
  const m = DATA.readJson(metaFile(id), {});
  let sessions = 0;
  if (sessSynced) for (const e of sessIndex.values()) { if (e.ws === id) sessions++; } // from the sessions index: no folder read
  else try { sessions = fs.readdirSync(sessionsDir(id)).filter((f) => f.endsWith(".json")).length; } catch {}
  return { id, name: m.name || id, description: m.description || "", created: m.created || 0, isDefault: id === DEFAULT, sessions, dir: filesDir(id),
    memory: m.memory === true, memoryStats: m.memory === true ? memory.stats(id) : null,
    continuous: m.continuous === true, limitMin: m.limitMin || 0, limitTokens: m.limitTokens || 0 };
}
// Continuous Work on? (read for every reply) -> { limitMin, limitTokens } or null. Limits 0 = none.
function continuousOf(id) {
  if (!exists(id)) return null;
  const m = DATA.readJson(metaFile(id), {});
  return m.continuous === true ? { limitMin: m.limitMin || 0, limitTokens: m.limitTokens || 0 } : null;
}
// Continuous Work fields from a create/update body: the toggle and its optional limits per task (minutes, tokens; 0 = none).
function workFields(m, patch) {
  if (typeof patch.continuous === "boolean") m.continuous = patch.continuous;
  for (const k of ["limitMin", "limitTokens"]) if (k in patch) {
    const v = Math.round(Number(patch[k]) || 0);
    m[k] = v > 0 ? Math.min(v, k === "limitMin" ? 24 * 60 : 1e9) : 0;
  }
}
// Workspace memory on? (read for every reply, so just the flag)
function memoryOn(id) {
  return exists(id) && DATA.readJson(metaFile(id), {}).memory === true;
}
// Default first, then by name.
function list() {
  return ids().map(info).sort((a, b) => (b.isDefault - a.isDefault) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

function create({ name, description, memory: mem }) {
  name = String(name || "").trim().slice(0, 80);
  if (!name) throw Object.assign(new Error("A workspace needs a name"), { status: 400 });
  if (list().some((w) => w.name.toLowerCase() === name.toLowerCase())) throw Object.assign(new Error(`A workspace called "${name}" already exists`), { status: 409 });
  const base = name.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "workspace";
  let id = /^[A-Za-z0-9]/.test(base) ? base : "w-" + base, n = 2;
  while (fs.existsSync(path.join(ROOT, id)) || id.toLowerCase() === DEFAULT.toLowerCase()) id = `${base}-${n++}`;
  ensure(id, name);
  const m = { name, description: String(description || "").slice(0, 4000), created: Date.now(), memory: mem === true };
  workFields(m, arguments[0] || {});
  const given = arguments[0] && arguments[0].dir; // a folder of its own (absolute, existing): files live there, not in the workspace
  if (typeof given === "string" && path.isAbsolute(given) && fs.existsSync(given)) m.dir = given;
  dirOf.delete(id);
  DATA.writeJson(metaFile(id), m);
  return info(id);
}
function update(id, patch) {
  if (!exists(id)) throw Object.assign(new Error("No such workspace"), { status: 404 });
  const m = DATA.readJson(metaFile(id), {});
  if (typeof patch.name === "string") {
    const name = patch.name.trim().slice(0, 80);
    if (!name) throw Object.assign(new Error("A workspace needs a name"), { status: 400 });
    if (list().some((w) => w.id !== id && w.name.toLowerCase() === name.toLowerCase())) throw Object.assign(new Error(`A workspace called "${name}" already exists`), { status: 409 });
    m.name = name;
  }
  if (typeof patch.description === "string") m.description = patch.description.slice(0, 4000);
  if (typeof patch.memory === "boolean") m.memory = patch.memory;
  workFields(m, patch);
  DATA.writeJson(metaFile(id), m);
  return info(id);
}
// Deletes the workspace folder with its sessions and files (permanently). Returns the session ids that were in it.
async function remove(id) {
  if (id === DEFAULT) throw Object.assign(new Error("The Default workspace can't be deleted"), { status: 400 });
  if (!exists(id)) throw Object.assign(new Error("No such workspace"), { status: 404 });
  const gone = [...index].filter(([, w]) => w === id).map(([s]) => s);
  for (const s of gone) index.delete(s);
  for (const [f, e] of sessIndex) if (e.ws === id) sessIndex.delete(f);
  wsIds = null;
  for (let i = 0; ; i++) { // Windows: files may be briefly locked (an image being served, Explorer open)
    try { await fs.promises.rm(path.join(ROOT, id), { recursive: true, force: true }); break; }
    catch (e) { if (i >= 20 || !["EBUSY", "EPERM", "ENOTEMPTY"].includes(e.code)) throw e; await new Promise((r) => setTimeout(r, 200)); }
  }
  return gone;
}

// Session files. sessionFile(id) finds an existing session; placeSession(id, ws) is for the first save of a new one.
const workspaceOf = (sid) => index.get(sid) || null;
function sessionFile(sid) {
  if (!SESSION_RE.test(sid || "")) return null;
  return path.join(sessionsDir(index.get(sid) || DEFAULT), sid + ".json");
}
function placeSession(sid, ws) {
  if (!SESSION_RE.test(sid || "")) return null;
  if (!index.has(sid)) index.set(sid, exists(ws) ? ws : DEFAULT);
  return sessionFile(sid);
}
const forgetSession = (sid) => index.delete(sid);
// The sessions list (the sidebar polls it every few seconds) comes from an in-memory index of each session file's
// summary, kept current by server.js (noteSession on every write and delete). Reading every file took longer than the
// page's 8 s timeout while Strata was generating (each small read took 100-1,600 ms on the user's PC), and listing the
// folders on each poll still took 0.2-1.4 s, so a poll is answered from memory. The folders are compared with it in
// the background (at startup, then at most every 30 s, never holding up a request): files not in the index yet (a
// session written by another program) are read once, and files gone from disk leave it. Changes made to a session file
// by another program show after a restart.
const sessIndex = new Map(); // session file path -> { ws, at, chat: { id, title, updated, model, parent, unread } }
let sessSynced = false, sessSyncAt = 0, sessSync = null;
const brief = (w, c) => ({ ws: w, at: Date.now(), chat: { id: c.id, title: c.title, updated: c.updated, model: c.model, parent: c.parent, unread: c.unread } });
function noteSession(file, chat) {
  if (!chat) { sessIndex.delete(file); return; }
  sessIndex.set(file, brief(path.basename(path.dirname(path.dirname(file))), chat));
}
function resyncSessions() {
  if (sessSync) return sessSync;
  const started = Date.now();
  sessSync = (async () => {
    const seen = new Set();
    for (const w of ids()) {
      const dir = sessionsDir(w);
      for (const f of await fs.promises.readdir(dir).catch(() => [])) {
        if (!f.endsWith(".json")) continue;
        const p = path.join(dir, f);
        seen.add(p);
        if (!sessIndex.has(p)) try { const e = brief(w, JSON.parse(await fs.promises.readFile(p, "utf8"))); if (!sessIndex.has(p)) sessIndex.set(p, e); } catch {}
      }
    }
    for (const [k, e] of sessIndex) if (!seen.has(k) && e.at < started) sessIndex.delete(k); // (one saved during the scan stays)
    sessSynced = true; sessSyncAt = Date.now();
  })().finally(() => { sessSync = null; });
  return sessSync;
}
async function listSessions() {
  if (!sessSynced) await resyncSessions();
  else if (Date.now() - sessSyncAt > 30000) resyncSessions().catch(() => {});
  const live = new Set(ids());
  return [...sessIndex.values()].filter((e) => live.has(e.ws));
}

async function allSessions() {
  const out = [];
  for (const w of ids()) {
    for (const f of await fs.promises.readdir(sessionsDir(w)).catch(() => [])) {
      if (!f.endsWith(".json")) continue;
      try { out.push({ ws: w, chat: JSON.parse(await fs.promises.readFile(path.join(sessionsDir(w), f), "utf8")) }); } catch {}
    }
  }
  return out;
}

// Workspace files: a path relative to the files folder, which must stay inside it.
function filePath(id, rel) {
  if (!exists(id)) return null;
  const base = filesDir(id), p = path.resolve(base, String(rel || "").replace(/^[\\/]+/, ""));
  const r = path.relative(base, p);
  return r && !r.startsWith("..") && !path.isAbsolute(r) ? p : null;
}
// A workspace's files (the overview and the files view). Kept until the folder changes (dircache.js); the server and
// the tools say so too (invalidateFiles). A scan stats the files 16 at a time: one at a time took over 8 s for 449
// files while Strata generated, and the page gave up.
async function scanFiles(base) {
  const found = [];
  async function walk(dir, depth) {
    for (const d of await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (found.length >= 2000) return;
      const p = path.join(dir, d.name);
      if (d.isDirectory()) { if (depth < 4) await walk(p, depth + 1); continue; }
      if (d.isFile() && !d.name.endsWith(".part")) found.push(p);
    }
  }
  await walk(base, 0);
  const out = [];
  for (let i = 0; i < found.length; i += 16) {
    const sts = await Promise.all(found.slice(i, i + 16).map((p) => fs.promises.stat(p).catch(() => null)));
    sts.forEach((st, j) => { if (st) out.push({ path: path.relative(base, found[i + j]).split(path.sep).join("/"), size: st.size, modified: st.mtimeMs }); });
  }
  return out.sort((a, b) => b.modified - a.modified);
}
const fileScans = require("./dircache").dirCache(scanFiles);
async function files(id) { return (await fileScans.get(filesDir(id))).map((f) => ({ ...f })); }
const invalidateFiles = (id) => fileScans.invalidate(id == null ? undefined : filesDir(id));
// A free name in the files folder: "x.png", then "x (2).png", ...
function freeName(id, name, dir = filesDir(id)) {
  const clean = path.basename(String(name || "file")).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 150) || "file";
  const ext = path.extname(clean), stem = clean.slice(0, clean.length - ext.length);
  let n = 1, cand = clean;
  while (fs.existsSync(path.join(dir, cand))) cand = `${stem} (${++n})${ext}`;
  return cand;
}

module.exports = { DEFAULT, ROOT, init, list, info, exists, memoryOn, continuousOf, create, update, remove, filesDir, filePath, files, invalidateFiles, freeName,
  workspaceOf, sessionFile, placeSession, forgetSession, allSessions, listSessions, noteSession };
