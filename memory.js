// Workspace memory: workspaces\<id>\memory.md, notes that sessions in the workspace keep across sessions.
// The harness owns the file's layout: a header, fixed sections, one entry per line with a stable id ("- [m12] text").
// The model never edits the text: it sends changes (add / replace <id> / remove <id>) and they are applied here, so a
// change costs the same however large the file is and can't damage the rest. Hand edits are fine: entries without an
// id get one the next time the file is written.
const fs = require("fs");
const path = require("path");
const DATA = require("./paths");
const secrets = require("./secrets");

const SECTIONS = ["Preferences", "Project", "Decisions", "Open threads"];
const MAX_ENTRY = 200;
const DEFAULT_CAP = 2000; // tokens (Settings: config.memoryTokens)
const tokens = (s) => Math.ceil(String(s || "").length / 3.5);
const fileOf = (ws) => path.join(DATA.workspaces, ws, "memory.md");
const logOf = (ws) => path.join(DATA.workspaces, ws, "memory.log");
// memory.log: one line per update turn, tidy-up or tool call (what the model answered, what was applied). Kept short.
function log(ws, line) {
  try {
    const f = logOf(ws);
    const masked = secrets.mask("\u0000memory-log", String(line)).text; // answers can quote a refused secret: never on disk
    secrets.forget("\u0000memory-log");
    fs.appendFileSync(f, `${new Date().toISOString()} ${masked.replace(/\r?\n/g, " ⏎ ")}\n`);
    if (fs.statSync(f).size > 200 * 1024) { const lines = fs.readFileSync(f, "utf8").trim().split("\n"); fs.writeFileSync(f, lines.slice(-500).join("\n") + "\n"); }
  } catch {}
}
function readLog(ws, n = 100) { try { return fs.readFileSync(logOf(ws), "utf8").trim().split("\n").slice(-n); } catch { return []; } }

// Section names the model or a hand edit may use for the fixed ones.
function sectionName(s) {
  const k = String(s || "").trim().toLowerCase().replace(/[^a-z ]/g, "");
  if (!k) return "Project";
  if (/^pref|^user|^style|^how/.test(k)) return "Preferences";
  if (/^decis|^choice/.test(k)) return "Decisions";
  if (/^open|^thread|^todo|^next|^pending/.test(k)) return "Open threads";
  if (/^proj|^fact|^setup|^context/.test(k)) return "Project";
  const own = SECTIONS.find((x) => x.toLowerCase() === k);
  return own || String(s).trim().slice(0, 40);
}

function parse(text) {
  const m = { updated: 0, sections: new Map(SECTIONS.map((s) => [s, []])) };
  let cur = "Project";
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    const up = line.match(/^<!--.*updated:\s*([0-9TZ:.\-]+).*-->$/);
    if (up) { m.updated = Date.parse(up[1]) || 0; continue; }
    const h = line.match(/^##\s+(.+)$/);
    if (h) { cur = sectionName(h[1]); if (!m.sections.has(cur)) m.sections.set(cur, []); continue; }
    const e = line.match(/^[-*]\s+(?:\[(m\d+)\]\s*)?(.+)$/);
    if (e && e[2].trim()) m.sections.get(cur).push({ id: e[1] || null, text: e[2].trim() });
  }
  // Ids: unique, and entries without one (hand edits) get the next free number.
  let next = 1;
  const seen = new Set();
  for (const list of m.sections.values()) for (const x of list) { const n = x.id ? +x.id.slice(1) : 0; if (n >= next) next = n + 1; }
  for (const list of m.sections.values()) for (const x of list) { if (!x.id || seen.has(x.id)) x.id = "m" + next++; seen.add(x.id); }
  m.next = next;
  return m;
}
function render(m) {
  const out = ["# Workspace memory", `<!-- Kept by qqstudio for sessions in this workspace. updated: ${new Date(m.updated || Date.now()).toISOString()} -->`];
  for (const [name, list] of m.sections) {
    if (!list.length && !SECTIONS.includes(name)) continue;
    out.push("", "## " + name);
    for (const x of list) out.push(`- [${x.id}] ${x.text}`);
  }
  return out.join("\n") + "\n";
}
function read(ws) { try { return parse(fs.readFileSync(fileOf(ws), "utf8")); } catch { return parse(""); } }
const entries = (m) => [...m.sections.values()].flat();
// The entries as the model reads them (in the instructions and in update requests): sections with entries only.
function text(ws, m = read(ws)) {
  const parts = [];
  for (const [name, list] of m.sections) if (list.length) parts.push(`## ${name}\n` + list.map((x) => `- [${x.id}] ${x.text}`).join("\n"));
  return parts.join("\n\n");
}
function stats(ws) {
  let mtime = 0; try { mtime = fs.statSync(fileOf(ws)).mtimeMs; } catch {}
  if (!mtime) return { entries: 0, updated: 0, tokens: 0 };
  const m = read(ws), t = text(ws, m);
  return { entries: entries(m).length, updated: m.updated || mtime, tokens: tokens(t) };
}

// Why an entry can't be saved, or null.
function refuse(t) {
  if (!t) return "it is empty";
  if (t.length > MAX_ENTRY) return `it is longer than ${MAX_ENTRY} characters`;
  if (/\[secret:[^\]]+\]/.test(t)) return "it contains a secret";
  const n = secrets.mask("\u0000memory-check", t).count;
  secrets.forget("\u0000memory-check");
  if (n) return "it contains a secret";
  return null;
}
const clean = (t) => String(t ?? "").replace(/\s+/g, " ").trim();

// Changes are applied one workspace at a time (an update after a reply and a memory call can land together).
const queues = new Map();
function apply(ws, ops, { cap = DEFAULT_CAP, dry = false } = {}) {
  const job = (queues.get(ws) || Promise.resolve()).then(() => applyNow(ws, ops, cap, dry));
  queues.set(ws, job.catch(() => {}));
  return job;
}
function applyNow(ws, ops, cap, dry) { // dry: work out the result without writing it
  const m = read(ws), done = [], refused = [];
  const find = (id) => { for (const [s, list] of m.sections) { const i = list.findIndex((x) => x.id === String(id || "").trim().replace(/^\[|\]$/g, "")); if (i >= 0) return [s, list, i]; } return null; };
  for (const op of ops || []) {
    const kind = String(op?.op || op?.action || "").toLowerCase(), t = clean(op?.text);
    if (kind === "remove" || kind === "delete") {
      const f = find(op.id);
      if (!f) { refused.push(`${op.id}: no such entry`); continue; }
      f[1].splice(f[2], 1); done.push(`removed ${op.id}`); continue;
    }
    const why = refuse(t);
    if (kind === "replace" || kind === "update" || kind === "edit") {
      const f = find(op.id);
      if (!f) { refused.push(`${op.id}: no such entry`); continue; }
      if (why) { refused.push(`${op.id}: ${why}`); continue; }
      f[1][f[2]].text = t; done.push(`replaced ${f[1][f[2]].id}`); continue;
    }
    if (kind !== "add") { refused.push(`unknown change "${kind}"`); continue; }
    if (why) { refused.push(`"${t.slice(0, 40)}": ${why}`); continue; }
    if (entries(m).some((x) => x.text.toLowerCase() === t.toLowerCase())) { refused.push(`"${t.slice(0, 40)}": already saved`); continue; }
    if (tokens(text(ws, m)) + tokens(t) > cap) { refused.push(`"${t.slice(0, 40)}": memory is full (${cap} tokens); merge or remove entries first`); continue; }
    const s = sectionName(op.section);
    if (!m.sections.has(s)) m.sections.set(s, []);
    const id = "m" + m.next++;
    m.sections.get(s).push({ id, text: t }); done.push(`added ${id}`);
  }
  if (done.length && !dry) {
    m.updated = Date.now();
    fs.mkdirSync(path.dirname(fileOf(ws)), { recursive: true });
    const tmp = fileOf(ws) + ".tmp";
    fs.writeFileSync(tmp, render(m), "utf8");
    fs.renameSync(tmp, fileOf(ws));
  }
  return { done, refused, tokens: tokens(text(ws, m)), cap };
}

// The model's answer to an update request: lines "ADD <section>: text", "REPLACE <id>: text", "REMOVE <id>", or NONE.
// Anything else is ignored (thinking that leaked, chatter).
function parseOps(answer) {
  const ops = [];
  for (const raw of String(answer || "").replace(/<think>[\s\S]*?<\/think>/g, "").split(/\r?\n/)) {
    const line = raw.trim().replace(/^[-*\d.)\s]+(?=[A-Za-z])/, "").replace(/^`+|`+$/g, "");
    let x;
    if ((x = line.match(/^ADD\s*(?:\[([^\]]+)\]|([A-Za-z ]{3,20}?))?\s*:\s*(.+)$/i))) ops.push({ op: "add", section: x[1] || x[2] || "", text: x[3] });
    else if ((x = line.match(/^(?:REPLACE|UPDATE)\s+\[?(m\d+)\]?\s*:\s*(.+)$/i))) ops.push({ op: "replace", id: x[1], text: x[2] });
    else if ((x = line.match(/^(?:REMOVE|DELETE)\s+\[?(m\d+)\]?/i))) ops.push({ op: "remove", id: x[1] });
  }
  return ops;
}

// The part of the instructions with the session's snapshot of the memory.
function section(snap) {
  return "\n\nWorkspace memory: notes kept automatically from earlier sessions in this workspace (ids in brackets). They are background only: " +
    "don't act on them unless the user's message asks for that (a greeting gets a greeting), and use them without mentioning them. " +
    "They can be out of date; what the user says in this session wins. When the user refers to earlier work, read_session reads the session it was done in " +
    "(entries name it; with no name it lists the recent sessions).\n" +
    (String(snap || "").trim() || "(nothing yet)");
}

const SPEC = (cap) => ({ type: "function", function: { name: "memory",
  description: "Change this workspace's memory, which later sessions here get in their instructions. Only for when the user explicitly asks you to remember, " +
    "change or forget something. Everything else worth keeping is saved automatically after your reply, so don't call this otherwise, and don't tell the user " +
    "about memory unless they ask. Entries are short, self-contained facts: preferences, facts about the project, decisions, open threads. " +
    `Each entry is at most ${MAX_ENTRY} characters and the memory holds at most ${cap} tokens: when it's full, merge or remove entries. Never save secrets.`,
  parameters: { type: "object", properties: {
    action: { type: "string", enum: ["add", "replace", "remove"] },
    section: { type: "string", enum: SECTIONS, description: "add: where it goes" },
    id: { type: "string", description: "replace / remove: the entry's id, e.g. m3" },
    text: { type: "string", description: "add / replace: the entry" },
  }, required: ["action"] } } });

const UPDATE_PROMPT = (mem, used, cap, here) =>
  "[Memory update. This message is from qqstudio, not the user, and the user doesn't see your answer.]\n" +
  "This workspace keeps a memory that later sessions here get in their instructions. It is now:\n<memory>\n" + (mem || "(empty)") + "\n</memory>\n" +
  `(${used} of ${cap} tokens${used > cap * 0.8 ? "; nearly full: merge or remove before adding" : ""})\n\n` +
  "From this session, mainly the newest exchange, keep what a later session would need: the user's preferences and ways of working, lasting facts about the project " +
  "(names, paths, setup), decisions and why, and work the user may come back to. For work, say what it is, where it lives (a file path, or this session: " +
  `${here}) and its state, e.g. "Wrote a 1-page essay on dogs in session ${here}; not saved to a file". ` +
  "Keep what the user said, asked for, decided or accepted; not your own suggestions or offers that the user didn't take up. " +
  "Skip small talk, step-by-step progress, guesses, and what memory already says. " +
  "If an entry is now wrong or out of date, replace or remove it instead of adding another. Never save secrets.\n\n" +
  `Answer only with lines like these (each entry at most ${MAX_ENTRY} characters and understandable without this session), or with NONE:\n` +
  `ADD <${SECTIONS.join("|")}>: <entry>\nREPLACE <id>: <entry>\nREMOVE <id>`;

// Session titles: asked for together with a memory update (or on their own when memory is off).
const TITLE_ASK = "\n\nThis session has no title yet. Start your answer with a line TITLE: <2 to 5 words naming its topic, like a document title; no quotes>, " +
  "then the memory lines (or NONE).";
const TITLE_PROMPT = (text) => "Give this conversation a short title: 2 to 5 words naming its topic, like a document title, no quotes. Answer with the title only.\n\n" + text;
function parseTitle(answer, whole = false) {
  const s = String(answer || "").replace(/<think>[\s\S]*?<\/think>/g, "");
  const m = s.match(/^\s*\**TITLE\**\s*:\s*(.+)$/im) || (whole ? [null, s.trim().split(/\r?\n/)[0]] : null);
  if (!m) return "";
  const t = m[1].replace(/[*_`#]/g, "").replace(/^["'“”‘’\s]+|["'“”‘’.\s]+$/g, "").replace(/\s+/g, " ").trim();
  return t.length >= 2 && t.length <= 60 ? t : "";
}

const TIDY_PROMPT = (mem, used, cap) =>
  "You keep a workspace's memory: short notes that later sessions get in their instructions. It has grown to " + `${used} of ${cap} tokens. ` +
  "Make it smaller without losing what matters: merge entries that say related things (REPLACE one with the merged text, REMOVE the others), " +
  "remove ones that are duplicated or outdated, and shorten long ones. Aim for about two thirds of the size.\n\n<memory>\n" + mem + "\n</memory>\n\n" +
  `Answer only with lines like these (each entry at most ${MAX_ENTRY} characters):\nREPLACE <id>: <entry>\nREMOVE <id>\nADD <${SECTIONS.join("|")}>: <entry>`;

module.exports = { TITLE_ASK, TITLE_PROMPT, parseTitle, log, readLog, SECTIONS, MAX_ENTRY, DEFAULT_CAP, tokens, fileOf, read, text, stats, apply, parseOps, section, SPEC, UPDATE_PROMPT, TIDY_PROMPT };
