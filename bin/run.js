// qqstudio run: one task, headless. Starts qqstudio's server in this process (a free port, a throwaway data folder,
// a Continuous Work workspace whose folder is the task's folder), runs the task to task_complete, prints the result
// and exits. By default it uses the loadout loaded in qqstudio (the engine on 127.0.0.1:9931); --base-url points at
// another llama.cpp-compatible server instead.
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), net = require("net");
const pkg = require("../package.json");

const HELP = [
  "qqstudio run " + pkg.version + " - run one task headless (Continuous Work: no approvals, no questions)",
  "",
  "Usage: qqstudio run [options] -- \"<task>\"",
  "",
  "Options:",
  "      --cwd <dir>             Working folder for the task (default: the current folder)",
  "      --logs <dir>            Write session.json (after every step), events.jsonl and qqstudio.log there",
  "      --json                  One JSON event per line on stdout (default: the final summary as text)",
  "      --no-web                Leave out the web tools (web search, fetch, downloads, web APIs)",
  "      --no-agents             Leave out sub-agents",
  "      --limit-time <min>      Stop the task after this many minutes",
  "      --limit-tokens <n>      Stop the task after this many generated tokens",
  "      --instruction-file <p>  Read the task from a file",
  "      --base-url <url>        A llama.cpp-compatible server instead of the loaded loadout (needs --model)",
  "      --model <name>          Model name to send with --base-url",
  "      --yolo                  Accepted for familiarity: every tool already runs without asking",
  "  -h, --help                  Show this help",
  "",
  "Exit codes: 0 done (task_complete), 1 error, 2 stopped (limit, Ctrl+C), 3 ended without task_complete.",
].join("\n");

const say = (s) => process.stderr.write(s + "\n");
function fail(msg, code = 1) { say("qqstudio run: " + msg); process.exit(code); }

function parse(argv) {
  const o = { cwd: process.cwd(), logs: null, json: false, web: true, agents: true, limitMin: 0, limitTokens: 0, file: null, baseUrl: null, model: null, task: "" };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i], val = null;
    if (a === "--") { rest.push(...argv.slice(i + 1)); break; }
    const eq = a.indexOf("=");
    if (a.startsWith("--") && eq > 0) { val = a.slice(eq + 1); a = a.slice(0, eq); }
    const next = () => { if (val !== null) return val; if (i + 1 >= argv.length) fail(a + " needs a value"); return argv[++i]; };
    switch (a) {
      case "--cwd": o.cwd = path.resolve(next()); break;
      case "--logs": o.logs = path.resolve(next()); break;
      case "--json": o.json = true; break;
      case "--no-web": o.web = false; break;
      case "--no-agents": o.agents = false; break;
      case "--limit-time": o.limitMin = Number(next()) || 0; break;
      case "--limit-tokens": o.limitTokens = Number(next()) || 0; break;
      case "--instruction-file": o.file = path.resolve(next()); break;
      case "--base-url": o.baseUrl = next().replace(/\/+$/, "").replace(/\/v1$/, ""); break;
      case "--model": o.model = next(); break;
      case "--yolo": break;
      case "-h": case "--help": console.log(HELP); process.exit(0); break;
      default: if (a.startsWith("-")) fail("unknown option " + a + "\n\nRun \"qqstudio run --help\" for the options."); rest.push(a);
    }
  }
  o.task = o.file ? fs.readFileSync(o.file, "utf8") : rest.join(" ");
  if (!o.task.trim()) fail("no task given. Usage: qqstudio run [options] -- \"<task>\"");
  if (!fs.existsSync(o.cwd) || !fs.statSync(o.cwd).isDirectory()) fail("--cwd is not a folder: " + o.cwd);
  if (o.baseUrl && !o.model) fail("--base-url needs --model");
  return o;
}

// The loadout loaded in qqstudio: engines/running.json in the user's data folder, plus its loadout and engine entries.
function loadedLoadout(home) {
  const read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(home, f), "utf8")); } catch { return d; } };
  const r = read(path.join("engines", "running.json"), null);
  if (!r || !r.loadout) return null;
  const L = read("loadouts.json", {}), list = Array.isArray(L) ? L : (L && L.loadouts) || []; // {loadouts: [...]}
  const lo = list.find((l) => l.id === r.loadout);
  const eng = ((read("engines.json", {}) || {}).engines || []).find((e) => e.id === (lo && lo.engine) || e.id === r.engine);
  return { id: r.loadout, loadout: lo || null, engine: eng || null, strata: !!r.strata || (eng && eng.type === "strata") };
}

const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.unref(); s.on("error", rej); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });

// The instructions the page would give, for the headless tool set (the page builds them in the browser; keep in step
// with systemPrompt() in public/index.html).
function systemPrompt(names, dir) {
  const on = new Set(names), has = (...n) => n.some((x) => on.has(x)), win = process.platform === "win32";
  const lines = [`You are a helpful assistant running on the user's ${win ? "Windows" : process.platform} computer.`];
  const fileOps = [["list_dir", "list folders"], ["read_file", "read files and documents (PDF, Word, Excel, PowerPoint)"], ["search_files", "find files by name"], ["search_text", "search inside files"], ["write_file", "write files"], ["edit_file", "edit files"],
    ["move_file", "move or rename files"], ["delete_file", "delete files"]].filter(([n]) => on.has(n)).map(([, d]) => d);
  if (fileOps.length) {
    lines.push(`You have tools to ${fileOps.join(", ")}. The working folder is ${dir}: work there unless the task names another place. Relative paths are in the working folder.`);
    lines.push(`Call the tools yourself instead of telling the user how to do it. Use absolute ${win ? "Windows " : ""}paths outside the working folder.`);
  }
  if (has("web_search", "fetch_url", "download_file")) {
    const w = [["web_search", "search the web (web_search)"], ["fetch_url", "read web pages (fetch_url)"], ["download_file", "download files (download_file)"]].filter(([n]) => on.has(n)).map(([, d]) => d);
    lines.push(`You can ${w.join(", ")}. Use them for anything current or that you are unsure about, and mention the URLs you used.`);
  }
  if (on.has("edit_file")) lines.push("To change part of a file, use edit_file rather than rewriting the whole file.");
  if (on.has("run_script")) lines.push("For anything that needs code (calculations, data, images, converting files), write it as a script with run_script instead of quoting it into run_command.");
  if (on.has("run_background")) lines.push("Start long-running commands (dev servers, builds) with run_background, then check them with check_background.");
  if (on.has("run_agent")) lines.push("You can hand a separate, self-contained piece of work to a sub-agent with run_agent; it works in the background and its report arrives in this conversation by itself.");
  if (on.has("todo")) lines.push("For work with several steps, keep a task list with todo and update it as you go.");
  if (on.has("run_command")) lines.push(`You can run ${win ? "cmd.exe" : "shell"} commands with run_command; use it when no specific tool fits.`);
  lines.push("Only use the tools listed to you. Never say you cannot do something a tool can do.");
  lines.push("If a tool returns an error, read it and try a corrected call.");
  lines.push("After you have what you need, answer concisely.");
  return lines.join(" ");
}

const WEB = new Set(["web_search", "fetch_url", "download_file", "http_request"]);
const LEFT_OUT = new Set(["ask_user", "load_skill", "image_search", "show_image"]); // nobody to ask; no skills; nobody to show pictures to
const AGENTS = new Set(["run_agent", "message_agent", "stop_agent", "check_agent"]);

module.exports = async function run(argv) {
  const o = parse(argv);
  const userHome = process.env.QQSTUDIO_HOME || path.join(os.homedir(), ".qqstudio");
  let model, llamaUrl, lo = null;
  if (o.baseUrl) { model = o.model; llamaUrl = o.baseUrl; }
  else {
    lo = loadedLoadout(userHome);
    if (!lo) fail("no loadout is loaded in qqstudio. Load one first (Settings > Loadouts), or pass --base-url and --model.");
    model = lo.id; llamaUrl = "http://127.0.0.1:" + (Number(process.env.LLAMA_PORT) || 9931);
  }
  try { const r = await fetch(llamaUrl + "/health", { signal: AbortSignal.timeout(8000) }); if (!r.ok && r.status !== 503) throw new Error("HTTP " + r.status); }
  catch (e) { fail(`the engine at ${llamaUrl} doesn't answer (${e.message}).` + (lo ? " Is the loadout still loaded?" : "")); }

  // A throwaway data folder: nothing of the user's sessions, settings or tools is read or changed.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "qqstudio-run-"));
  if (lo && lo.loadout) { // its loadout and engine entries, so qqstudio knows the engine (Strata: no model name is sent)
    fs.writeFileSync(path.join(home, "loadouts.json"), JSON.stringify({ loadouts: [lo.loadout] }));
    if (lo.engine) fs.writeFileSync(path.join(home, "engines.json"), JSON.stringify({ engines: [lo.engine] }));
  }
  if (o.logs) fs.mkdirSync(o.logs, { recursive: true });
  const logFile = o.logs ? fs.openSync(path.join(o.logs, "qqstudio.log"), "a") : null;
  const toLog = (...a) => { if (logFile !== null) fs.writeSync(logFile, a.map((x) => (typeof x === "string" ? x : require("util").inspect(x))).join(" ") + "\n"); };
  console.log = toLog; console.info = toLog; console.warn = toLog; console.error = toLog; // the server's own lines

  const port = await freePort();
  Object.assign(process.env, { QQSTUDIO_HOME: home, PORT: String(port), HOST: "127.0.0.1", LLAMA_URL: llamaUrl, QQSTUDIO_TRAY: "0", HOT_RELOAD: "0", QQSTUDIO_SLOT: lo ? "last" : "", QQSTUDIO_OWN_SIGNALS: "1" });
  delete process.env.QQSTUDIO_OPEN;
  require("../server.js");
  const U = `http://127.0.0.1:${port}/api`;
  const api = async (p, opts = {}) => {
    const r = await fetch(U + p, { ...opts, headers: { "Content-Type": "application/json", ...(opts.headers || {}) }, body: opts.body && JSON.stringify(opts.body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status} for ${p}`);
    return j;
  };
  for (let i = 0; ; i++) { try { await api("/ping"); break; } catch { if (i > 100) fail("qqstudio's server didn't start"); await new Promise((r) => setTimeout(r, 100)); } }

  let exitCode = 1, chatId = null, finished = false;
  const cleanup = () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} };
  const writeSession = async () => {
    if (!o.logs || !chatId) return;
    try { const c = await api("/chats/" + chatId); fs.writeFileSync(path.join(o.logs, "session.json"), JSON.stringify(c, null, 1)); } catch {}
  };
  const out = (ev) => {
    if (o.logs) fs.appendFileSync(path.join(o.logs, "events.jsonl"), JSON.stringify(ev) + "\n");
    if (o.json) process.stdout.write(JSON.stringify(ev) + "\n");
  };
  const finish = async (code) => {
    if (finished) return; finished = true;
    await writeSession();
    cleanup();
    process.exit(code);
  };
  let stopping = false;
  const onSignal = async () => {
    if (stopping) { cleanup(); process.exit(2); }
    stopping = true; say("qqstudio run: stopping…");
    if (chatId) await api(`/runs/${chatId}/stop`, { method: "POST" }).catch(() => {});
    setTimeout(() => finish(2), 10000).unref(); // the run's end normally comes first
  };
  process.on("SIGINT", onSignal); process.on("SIGTERM", onSignal); process.on("SIGHUP", onSignal);

  try {
    const w = await api("/workspaces", { method: "POST", body: { name: "Headless", memory: false, continuous: true, limitMin: o.limitMin, limitTokens: o.limitTokens, dir: o.cwd } });
    const ws = w.workspace;
    const t = await api("/tools");
    const tools = (t.tools || []).filter((x) => x.enabled && !x.server && !LEFT_OUT.has(x.name) && (o.web || !WEB.has(x.name)) && (o.agents || !AGENTS.has(x.name)));
    chatId = "run" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    await api("/chats/" + chatId, { method: "PUT", body: { id: chatId, workspace: ws.id, title: "qqstudio run", mode: "auto", messages: [{ role: "user", content: o.task }] } });
    await api("/runs", { method: "POST", body: { chatId, model, system: systemPrompt(tools.map((x) => x.name), ws.dir), tools: tools.map((x) => x.spec), think: { body: {}, budget: null } } });
    out({ type: "start", version: pkg.version, model, engine: llamaUrl, cwd: ws.dir, tools: tools.map((x) => x.name) });
    if (!o.json) say(`qqstudio run ${pkg.version} · ${model} · ${ws.dir}`);
  } catch (e) { say("qqstudio run: " + e.message); return finish(1); }

  // Follow the run's events until it ends.
  let summary = null, halted = null, failed = null, lastText = "";
  const res = await fetch(`${U}/runs/${chatId}/events`);
  if (res.status === 200) {
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        if (!chunk.startsWith("data: ")) continue;
        let ev; try { ev = JSON.parse(chunk.slice(6)); } catch { continue; }
        if (ev.type === "assistant") {
          const m = ev.msg || {};
          if (m.content) lastText = m.content;
          const calls = (m.tool_calls || []).map((c) => ({ name: c.function.name, arguments: c.function.arguments }));
          out({ type: "step", text: m.content || "", reasoning: m._reasoning || "", tool_calls: calls, usage: m._usage || null, meta: m._meta || "" });
          if (!o.json) for (const c of calls) say("· " + c.name + " " + String(c.arguments || "").replace(/\s+/g, " ").slice(0, 120));
          await writeSession();
        } else if (ev.type === "tool_result") {
          const m = ev.msg || {};
          out({ type: "tool_result", status: m._status || "done", content: m.content || "" });
          await writeSession();
        } else if (ev.type === "complete") { summary = ev.summary; out({ type: "complete", summary }); }
        else if (ev.type === "halted") { halted = ev.text; out({ type: "halted", text: ev.text }); }
        else if (ev.type === "failed") { failed = ev.text; out({ type: "error", text: ev.text }); }
        else if (ev.type === "notice") out({ type: "notice", text: ev.text });
        else if (ev.type === "loopwarn" && ev.on) out({ type: "loop_warning" });
        else if (ev.type === "done") {
          const reason = summary ? "complete" : failed ? "error" : stopping ? "stopped" : halted ? (/limit/.test(halted) ? "limit" : /without task_complete/.test(halted) ? "no_complete" : "stopped") : "no_complete";
          exitCode = { complete: 0, error: 1, stopped: 2, limit: 2, no_complete: 3 }[reason];
          out({ type: "done", reason, summary: summary || lastText, tokens: ev.tokens, ms: ev.ms });
          if (!o.json) { if (summary || lastText) process.stdout.write((summary || lastText).trim() + "\n"); if (halted || failed) say("qqstudio run: " + (halted || failed)); }
        }
      }
    }
  }
  await finish(exitCode);
};
