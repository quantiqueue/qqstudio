// Server-side agent runs. The loop (model -> tool calls -> model ...) lives here, not in the browser, so a reply
// keeps going when the user switches chats, opens Settings, reloads or closes the tab. Progress is saved to the
// chat file as it streams; any number of pages can watch a run through an event stream and stop it.
const fs = require("fs");
const secrets = require("./secrets");

const MAX_IMAGES = 4; // most recent images re-sent to a vision model on each step; older ones become a short note
const SAVE_EVERY_MS = 1500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Text the model keeps repeating (a common failure of small models): the same sentence many times, or the same chunk
// over and over without sentence breaks. Checked on the tail only, every few hundred characters.
function repeating(text) {
  const tail = text.slice(-4000);
  const prose = text.replace(/```[\s\S]*?(?:```|$)/g, "\n").slice(-4000); // code legitimately repeats lines
  const parts = prose.split(/(?<=[.!?\u3002])\s+|\n+/).map((x) => x.trim().toLowerCase().replace(/\s+/g, " ")).filter((x) => x.length >= 15);
  const counts = new Map();
  // real loops are dense: 6 of the last 12 sentences are the same
  for (const p of parts.slice(-12)) { const n = (counts.get(p) || 0) + 1; if (n >= 6) return true; counts.set(p, n); }
  if (tail.length >= 1500) {
    const k = tail.slice(-120); let n = 0, i = -1;
    while ((i = tail.indexOf(k, i + 1)) !== -1) if (++n >= 6) return true;
  }
  return false;
}
// The tool the model calls to turn on a tool group (MCP server or built-in category) left on Auto.
const enableSpec = (names) => ({ type: "function", function: {
  name: "enable_tools",
  description: "Turn on a group of tools listed in your instructions. Its tools can be called right after this returns.",
  parameters: { type: "object", properties: { name: { type: "string", enum: names, description: "Name of the tool group" } }, required: ["name"] },
} });
const stripUi = (m) => Object.fromEntries(Object.entries(m).filter(([k]) => !k.startsWith("_")));

module.exports = function createRuns({ llama, runTool, toolList, isEnabled, chatFile, updateChat, statusOf, visionOf, loadImage, imagePathsIn, uploadPath, getConfig, nCtx, samplingFor = () => ({}), ensureEngine = async () => {} }) {
  const runs = new Map(); // chatId -> run

  const readChat = async (id) => JSON.parse(await fs.promises.readFile(chatFile(id), "utf8"));
  function emit(run, ev) {
    const line = `data: ${JSON.stringify(ev)}\n\n`;
    for (const c of run.clients) c.write(line);
  }
  // Writes the run's messages into the chat file, keeping fields the page may have changed (title, mode, ...).
  function save(run, partial = null, extra = {}) {
    if (run.deleted) return Promise.resolve();
    return updateChat(chatFile(run.id), (disk) => {
      if (!disk || run.deleted) { run.deleted = true; stop(run); return null; } // chat was deleted
      return { ...disk, ...extra, messages: partial ? [...run.messages, partial] : run.messages, updated: Date.now() };
    }).catch((e) => console.error(`[run] save ${run.id}: ${e.message}`));
  }

  // "[Attached image saved at C:\\...\\uploads\\x.png]" for the user's pasted images.
  function pathNote(imgs) {
    const files = (imgs || []).map((im) => uploadPath && uploadPath(im.full || im.src)).filter(Boolean);
    if (!files.length) return "";
    return files.length === 1 ? `[Attached image saved at ${files[0]}]` : `[Attached images saved at:\n${files.map((f) => "- " + f).join("\n")}]`;
  }

  // The conversation as the model gets it. For vision models, images pasted by the user go into their message and
  // images returned by tools follow the tool results as one user message (tool messages can't carry images).
  // Every model (vision or not) is told where pasted images are saved, so it can hand the file to a tool.
  async function modelMessages(run) {
    const all = run.messages;
    run = { ...run, messages: all.slice(lastSummary(all)) }; // compacted turns are replaced by their summary
    const plain = run.messages.map((m) => {
      const base = stripUi(m);
      const note = m.role === "user" && pathNote(m._images);
      return note ? { ...base, content: (typeof base.content === "string" && base.content ? base.content + "\n\n" : "") + note } : base;
    });
    if (!run.vision) return plain;
    const keep = new Set(); // newest MAX_IMAGES image refs
    for (let i = run.messages.length - 1; i >= 0 && keep.size < MAX_IMAGES; i--)
      for (const im of [...(run.messages[i]._images || [])].reverse()) { if (keep.size >= MAX_IMAGES) break; keep.add(im); }
    const parts = async (imgs) => {
      const out = []; let omitted = 0, unreadable = 0;
      for (const im of imgs) {
        if (!keep.has(im)) { omitted++; continue; }
        const src = im.full || im.src;
        if (!run.imgCache.has(src)) run.imgCache.set(src, await loadImage(src));
        const url = run.imgCache.get(src);
        if (url) out.push({ type: "image_url", image_url: { url } }); else unreadable++;
      }
      const notes = [];
      if (omitted) notes.push(`${omitted} older image${omitted > 1 ? "s" : ""} not re-sent`);
      if (unreadable) notes.push(`${unreadable} image${unreadable > 1 ? "s" : ""} couldn't be loaded (format not supported or not reachable)`);
      return { out, note: notes.length ? `[${notes.join("; ")}]` : "" };
    };
    const msgs = [];
    let pending = [];
    const flush = async () => {
      if (!pending.length) return;
      const { out, note } = await parts(pending);
      pending = [];
      if (!out.length && !note) return;
      msgs.push({ role: "user", content: [{ type: "text", text: "[Images returned by the tool calls above, attached so you can see them]" + (note ? " " + note : "") }, ...out] });
    };
    for (let i = 0; i < run.messages.length; i++) {
      const m = run.messages[i], base = plain[i];
      if (m.role !== "tool") await flush();
      if (m.role === "user" && m._images?.length) {
        const { out, note } = await parts(m._images);
        msgs.push({ ...base, content: [{ type: "text", text: (base.content || "") + (note ? `\n${note}` : "") || "(image)" }, ...out] });
        continue;
      }
      msgs.push(base);
      if (m.role === "tool" && m._images?.length) pending.push(...m._images);
    }
    await flush();
    return msgs;
  }

  // ---------- compaction ----------
  // When the next request would pass Settings > Engine > "Context window max" (% of the model's context), the older
  // part of the session is summarised by the model and a summary message is inserted. The full history stays in the
  // session file and on screen; the model only gets the messages from the last summary on.
  const lastSummary = (msgs) => { for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]._summary) return i; return 0; };
  const chars = (m) => (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content || "").length) +
    (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0);
  const estimate = (msgs) => Math.ceil(msgs.reduce((n, m) => n + chars(m), 0) / 3) + msgs.reduce((n, m) => n + (m._images?.length || 0), 0) * 1000;
  // Tokens the next request will use: llama-server's count for the latest step since the last summary, plus an
  // estimate of what came after it. With no count yet, an estimate of everything.
  function promptSize(run) {
    const msgs = run.messages, from = lastSummary(msgs);
    for (let i = msgs.length - 1; i >= from; i--) {
      const u = msgs[i]._usage;
      if (u && msgs[i]._ctxFrom === from) return u.prompt + u.completion + estimate(msgs.slice(i + 1));
    }
    return Math.ceil((run.system.length + JSON.stringify(run.tools).length) / 3) + estimate(msgs.slice(from));
  }
  const SUMMARY_PROMPT = "You compact long conversations between a user and an AI assistant that uses tools. " +
    "Write a summary that lets the assistant continue the work without the original messages. Include: the user's goals and requests, " +
    "decisions made, what has been done (files created or changed, with full paths; tools used and what they returned), the current state, " +
    "open problems, and the next steps. Keep exact names, paths, numbers and settings. Leave out pleasantries. Use short sections or bullets.";
  function transcript(msgs) {
    const cut = (t, n) => (t.length > n ? t.slice(0, n) + ` …[${t.length - n} more characters]` : t);
    return msgs.map((m) => {
      const text = typeof m.content === "string" ? m.content : (m.content || []).filter((p) => p.type === "text").map((p) => p.text).join(" ");
      if (m._summary) return `[Summary of an even earlier part]\n${text}`;
      if (m.role === "user") return `User: ${text}${m._images?.length ? ` [${m._images.length} image(s) attached]` : ""}`;
      if (m.role === "tool") return `Tool result: ${cut(text, 1500)}`;
      const calls = (m.tool_calls || []).map((tc) => `Tool call: ${tc.function.name}(${cut(tc.function.arguments || "", 600)})`).join("\n");
      return [text && `Assistant: ${cut(text, 4000)}`, calls].filter(Boolean).join("\n");
    }).filter(Boolean).join("\n\n");
  }
  async function maybeCompact(run) {
    const pct = Number(getConfig().compactAt) || 0;
    if (!pct) return;
    if (run.nCtx === undefined) run.nCtx = await nCtx(run.model);
    if (!run.nCtx) return;
    const limit = run.nCtx * pct / 100, size = promptSize(run);
    if (size < limit) return;
    const msgs = run.messages, from = lastSummary(msgs);
    // Keep the most recent messages that fit in about a quarter of the window; never split a tool call from its results.
    let keep = msgs.length, budget = run.nCtx * 0.25;
    while (keep > from + 1 && budget - estimate([msgs[keep - 1]]) > 0) { budget -= estimate([msgs[keep - 1]]); keep--; }
    while (keep < msgs.length && msgs[keep].role === "tool") keep++;
    if (keep <= from + 1 || keep >= msgs.length) {
      emit(run, { type: "notice", text: `The context is ${Math.round(size / run.nCtx * 100)}% full and the newest messages are too large to compact. The reply may fail; start a new session if it does.` });
      return;
    }
    const older = msgs.slice(from, keep);
    let text = transcript(older);
    const room = Math.floor(run.nCtx * 0.6 * 3); // the summary request itself must fit: drop the oldest part if needed
    if (text.length > room) text = "…[the oldest part was too long and is left out]\n\n" + text.slice(text.length - room);
    run.cur = { model: run.model, content: "", reasoning: "", phase: "Compacting session", pct: null };
    emit(run, { type: "step", model: run.model });
    emit(run, { type: "phase", text: "Compacting session", pct: null });
    const t0 = Date.now();
    let summary = "";
    try {
      run.abort = new AbortController();
      const r = await fetch(`${llama.url()}/v1/chat/completions`, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: run.abort.signal,
        body: JSON.stringify({ model: run.model, stream: false, max_tokens: 3000, temperature: 0.3,
          chat_template_kwargs: { enable_thinking: false }, reasoning_budget_tokens: 0, thinking_budget_tokens: 0,
          messages: [{ role: "system", content: SUMMARY_PROMPT }, { role: "user", content: `Summarize this conversation so far:\n\n${text}` }] }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error?.message || j.error || r.statusText);
      summary = (j.choices?.[0]?.message?.content || "").trim();
    } catch (e) {
      if (!run.stopped) emit(run, { type: "notice", text: "Compaction failed: " + e.message });
      return;
    } finally { run.abort = null; run.cur = null; }
    if (!summary || run.stopped) return;
    const msg = { role: "user", content: `[Summary of the earlier part of this session, which was compacted to save context]\n\n${summary}`,
      _summary: true, _meta: `Compacted ${older.length} messages (≈${Math.round(size / 1000)}k of ${Math.round(run.nCtx / 1000)}k tokens) · ${((Date.now() - t0) / 1000).toFixed(1)}s` };
    run.messages.splice(keep, 0, msg);
    console.log(`[run] ${run.id} compacted ${older.length} messages at ${size}/${run.nCtx} tokens`);
    emit(run, { type: "compacted", at: keep, msg });
    await save(run);
  }

  async function step(run) {
    const { model } = run;
    const cur = run.cur = { model, content: "", reasoning: "", phase: "Sending request", pct: null };
    const t0 = Date.now();
    let think0 = null, think1 = null, timings = null, failed = false, gotChunk = false, lastSave = Date.now();
    let looped = false, finish = null, checkedAt = 0, usage = null, ppTotal = 0;
    const calls = [];
    emit(run, { type: "step", model });
    const phase = (text, pct = null) => {
      if (cur.phase === text && cur.pct === pct) return;
      cur.phase = text; cur.pct = pct;
      emit(run, { type: "phase", text, pct });
    };
    // Until the first token, poll the router to tell "loading model" apart from "reading prompt".
    let polling = true;
    (async () => {
      while (polling && !run.stopped) {
        try {
          const j = await (await fetch(`${llama.url()}/models`)).json();
          const m = (j.data || j.models || []).find((x) => (x.id || x.name || x.model) === model);
          if (!polling) break;
          const st = m && statusOf(m);
          if (st && st !== "loaded") phase(m.status && m.status.failed ? "Model failed to load (see llama-server log)" : "Loading model");
          else if (!gotChunk) phase("Reading prompt");
        } catch {}
        await sleep(1000);
      }
    })();

    run.abort = new AbortController();
    try {
      await ensureEngine(model, (t) => phase(t)); // a loadout on another engine: stop the running one, start that one
      const body = {
        model, messages: [{ role: "system", content: run.system }, ...(await modelMessages(run))],
        return_progress: true, stream_options: { include_usage: true }, ...samplingFor(model), ...run.think.body, stream: true,
        max_tokens: run.maxTokens,
      };
      if (run.tools.length) body.tools = run.tools;
      const r = await fetch(`${llama.url()}/v1/chat/completions`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: run.abort.signal,
      });
      if (!r.ok) { const t = await r.text(); let msg = t; try { const j = JSON.parse(t); msg = j.error?.message || j.error || t; } catch {} throw new Error(msg || r.statusText); }
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of r.body) {
        buf += dec.decode(chunk, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          let j; try { j = JSON.parse(data); } catch { continue; }
          if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
          if (j.timings) timings = j.timings;
          if (j.usage) { usage = { prompt: j.usage.prompt_tokens, completion: j.usage.completion_tokens }; emit(run, { type: "usage", ...usage, model }); }
          if (!gotChunk) { gotChunk = true; polling = false; if (!cur.content) phase("Reading prompt"); }
          const pp = j.prompt_progress;
          if (pp && pp.total && pp.total !== ppTotal) { ppTotal = pp.total; emit(run, { type: "usage", prompt: pp.total, completion: 0, model, reading: true }); } // exact prompt size, early
          if (pp && pp.total && !cur.content && !cur.reasoning) {
            const done = Math.max(0, pp.processed - (pp.cache || 0)), todo = Math.max(1, pp.total - (pp.cache || 0));
            phase(`Reading prompt · ${pp.processed}/${pp.total} tokens`, Math.min(100, Math.round((done / todo) * 100)));
          }
          if (j.choices?.[0]?.finish_reason) finish = j.choices[0].finish_reason;
          const d = j.choices && j.choices[0] && j.choices[0].delta;
          if (!d) continue;
          const ev = { type: "delta" };
          if (d.reasoning_content) {
            if (think0 === null) think0 = Date.now();
            cur.reasoning += d.reasoning_content; ev.r = d.reasoning_content;
            if (!cur.content) phase("Thinking");
          }
          if (d.content) {
            if (think0 !== null && think1 === null) think1 = Date.now();
            cur.content += d.content; ev.c = d.content; cur.phase = null;
          }
          if (ev.r || ev.c) emit(run, ev);
          const total = cur.content.length + cur.reasoning.length;
          if (total - checkedAt >= 300) {
            checkedAt = total;
            if (repeating(cur.content) || repeating(cur.reasoning)) { looped = true; run.abort.abort(); break; }
          }
          for (const tc of d.tool_calls || []) {
            const i = tc.index ?? calls.length;
            calls[i] = calls[i] || { id: "", type: "function", function: { name: "", arguments: "" } };
            if (tc.id) calls[i].id = tc.id;
            if (tc.function?.name) calls[i].function.name += tc.function.name;
            if (tc.function?.arguments) calls[i].function.arguments += tc.function.arguments;
            phase("Preparing tool call" + (calls[i].function.name ? ` · ${calls[i].function.name}` : ""));
          }
          if (Date.now() - lastSave > SAVE_EVERY_MS && (cur.content || cur.reasoning)) {
            lastSave = Date.now();
            const p = { role: "assistant", content: cur.content, _meta: `${model} · interrupted`, _partial: true };
            if (cur.reasoning) p._reasoning = cur.reasoning;
            save(run, p);
          }
        }
      }
    } catch (e) {
      if (!run.stopped && !looped) {
        failed = true;
        emit(run, { type: "failed", text: (cur.content ? cur.content + "\n\n" : "") + "Error: " + (e.cause?.code === "ECONNREFUSED" ? `Cannot reach llama-server at ${llama.url()}` : e.message) });
      }
    } finally {
      polling = false;
      run.abort = null;
    }
    const toolCalls = calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${Date.now()}_${i}` }));
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const meta = `${model} · ${secs}s` +
      (timings?.predicted_per_second ? ` · ${timings.predicted_n} tok @ ${timings.predicted_per_second.toFixed(1)} tok/s` : "") +
      (run.stopped ? " · stopped" : looped ? " · stopped: repeating" : finish === "length" ? " · cut off (length limit)" : "");
    const thinkSecs = think0 === null ? null : +(((think1 ?? Date.now()) - think0) / 1000).toFixed(1);
    const tb = run.think.budget, note = (run.think.message || "").trim();
    const budgetHit = !!(cur.reasoning && tb > 0 && (cur.reasoning.length / 3.6 >= tb * 0.9 || (note && cur.reasoning.trim().endsWith(note))));
    return { content: cur.content, reasoning: cur.reasoning, toolCalls: looped ? [] : toolCalls, usage, meta, failed, thinkSecs, budgetHit, looped };
  }

  // Moves a deferred group's tools into the run (usable from the next step) and remembers it for the chat.
  async function enableTools(run, args) {
    const want = String(args.name || "").trim().toLowerCase();
    const g = [...run.deferred.values()].find((x) => x.name.toLowerCase() === want);
    if (!g) return { status: "error", text: `ERROR: no tool group named "${args.name}". Available: ${[...run.deferred.values()].map((x) => x.name).join(", ") || "none"}.` };
    if (run.loaded.has(g.key)) return { status: "done", text: `${g.name} is already on; call its tools directly.` };
    const have = new Set(run.tools.map((t) => t.function.name));
    for (const t of g.tools) if (!have.has(t.function.name)) { run.tools.push(t); run.allowed.add(t.function.name); }
    run.loaded.add(g.key);
    emit(run, { type: "loaded", loaded: [...run.loaded] });
    await save(run, null, { loaded: [...run.loaded] });
    console.log(`[run] ${run.id} enabled ${g.key} (${g.tools.length} tools)`);
    return { status: "done", text: `${g.name} is on: ${g.tools.length} tool${g.tools.length === 1 ? "" : "s"} can be called now (${g.tools.map((t) => t.function.name).join(", ")}).` + (g.note ? " " + g.note : "") };
  }

  async function callTool(run, tc) {
    const name = tc.function.name;
    let args;
    try { args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; }
    catch (e) { return { status: "bad arguments", text: `ERROR: arguments were not valid JSON (${e.message}). Call the tool again with valid JSON arguments.` }; }
    if (name === "enable_tools" && run.allowed.has(name)) return enableTools(run, args);
    if (!run.allowed.has(name)) return { status: "error", text: `ERROR: the tool "${name}" is not available in this chat.` };
    if (!isEnabled(name)) return { status: "error", text: `ERROR: the tool "${name}" is disabled in Settings > Tools.` };
    const spec = toolList().find((t) => t.name === name);
    if (spec && spec.approval) {
      let mode = "manual";
      try { mode = (await readChat(run.id)).mode || "manual"; } catch {}
      if (mode !== "auto") {
        run.tool = { tc, status: "approval" };
        emit(run, { type: "tool", tc, status: "approval" });
        const ok = await new Promise((resolve) => (run.approval = { id: tc.id, resolve }));
        run.approval = null;
        if (run.stopped) return { status: "cancelled", text: "Cancelled by user." };
        if (!ok) return { status: "denied", text: "The user denied this action. Do not retry it; ask the user how to proceed." };
      }
    }
    run.tool = { tc, status: "running" };
    emit(run, { type: "tool", tc, status: "running" });
    const t0 = Date.now();
    // Secret masking (Settings > Sessions): placeholders in the arguments get their real values just for the tool.
    const maskOn = getConfig().maskSecrets !== false;
    let callArgs = args;
    if (maskOn) {
      const u = secrets.unmask(run.id, args);
      if (u.missing.length) return { status: "error", text: `ERROR: ${u.missing.join(", ")} ${u.missing.length > 1 ? "are" : "is"} no longer available (the harness restarted since it was read). Read it again, then retry.` };
      callArgs = u.value;
    }
    const out = await runTool(name, callArgs);
    console.log(`[tool] ${name} ${JSON.stringify(args).slice(0, 200)} (${Date.now() - t0}ms)`);
    let text = String(out.text), images = out.images || [];
    if (maskOn) { // secrets in the result are replaced before it is saved or sent to the model
      const m = secrets.mask(run.id, text);
      text = m.text;
      if (m.count) text += `\n(${m.count} secret${m.count > 1 ? "s" : ""} hidden as [secret:…] placeholders. To use one, put the placeholder in a tool argument; it is filled in when the tool runs. Never ask the user for the real value.)`;
    }
    const failed = text.startsWith("ERROR");
    // MCP tools that write an image (e.g. Aseprite export_frame) only return its path: pick it up so it's shown and seen.
    if (!failed && !images.length && name.includes("__")) images = imagePathsIn(text);
    if (run.vision && images.length && !failed) text += `\n(${images.length > 1 ? "These images are" : "This image is"} attached to the conversation so you can see ${images.length > 1 ? "them" : "it"}.)`;
    return { status: failed ? "error" : "done", text, images };
  }

  // Ends a reply that can't usefully go on: notes why on its last assistant message (shown with a Continue button).
  async function halt(run, text) {
    const last = [...run.messages].reverse().find((m) => m.role === "assistant");
    if (last) last._stop = text;
    emit(run, { type: "halted", text });
    await save(run);
  }

  // ---------- steering ----------
  // Messages sent while a reply runs wait ("pending") until the current step is done, then join the conversation as one
  // user message before the next model call, never between a tool call and its results.
  async function applyPending(run, leftover = false) {
    if (!run.pending.length) return false;
    const items = run.pending.splice(0);
    const msg = { role: "user", content: items.map((i) => i.text).filter(Boolean).join("\n\n"), _steer: true };
    const imgs = items.flatMap((i) => i.images || []);
    if (imgs.length) msg._images = imgs;
    run.messages.push(msg);
    emit(run, { type: "steer_applied", ids: items.map((i) => i.id), msg, leftover });
    await save(run);
    return true;
  }
  function steer(run, b) {
    const text = String(b.text || "").trim();
    const images = (Array.isArray(b.images) ? b.images : []).filter((i) => i && typeof i.src === "string").map((i) => ({ src: i.src, full: i.full || i.src }));
    if (!text && !images.length) throw Object.assign(new Error("Empty message"), { status: 400 });
    const item = { id: String(b.id || Date.now().toString(36)), text, images };
    run.pending.push(item);
    emit(run, { type: "steer_pending", ...item });
    return item;
  }

  async function loop(run) {
    let lastSig = null, same = 0;
    try {
      for (let s = 0; !run.stopped; s++) {
        await applyPending(run);
        await maybeCompact(run);
        if (run.stopped) break;
        const r = await step(run);
        run.cur = null;
        // A step with only thinking (e.g. stopped mid-thought) is still saved, so the page closes it.
        if (r.failed || (!r.content && !r.toolCalls.length && !r.reasoning)) break;
        const msg = { role: "assistant", content: r.content, _meta: r.meta };
        if (r.usage) { msg._usage = { ...r.usage, model: run.model }; msg._ctxFrom = lastSummary(run.messages); } // exact counts from llama-server (context meter, compaction)
        if (r.reasoning) { msg._reasoning = r.reasoning; if (r.thinkSecs != null) msg._thinkSecs = r.thinkSecs; if (r.budgetHit) msg._budgetHit = true; }
        if (r.toolCalls.length) msg.tool_calls = r.toolCalls;
        run.messages.push(msg);
        emit(run, { type: "assistant", msg });
        await save(run);
        if (r.looped) { emit(run, { type: "notice", text: "Stopped: the model kept repeating itself. Try again, or lower its temperature / add a presence penalty for this model in models.ini." }); break; }
        if (!r.toolCalls.length) { if (run.pending.length && !run.stopped) continue; break; } // a steer arrived as it finished: keep going
        const sig = [];
        for (const tc of r.toolCalls) { // every tool call needs a result, even if cancelled
          const res = run.stopped ? { status: "cancelled", text: "Cancelled by user." } : await callTool(run, tc);
          sig.push(tc.function.name, tc.function.arguments, res.text);
          const tm = { role: "tool", tool_call_id: tc.id, content: res.text, _status: res.status };
          if (res.images?.length) tm._images = res.images;
          run.messages.push(tm);
          run.tool = null;
          emit(run, { type: "tool_result", msg: tm });
          await save(run);
        }
        // The same calls with the same arguments giving the same results, 3 steps in a row: it's stuck.
        const k = JSON.stringify(sig);
        same = k === lastSig ? same + 1 : 1; lastSig = k;
        if (same >= 3 && !run.stopped) { await halt(run, "Stopped: the same tool call gave the same result 3 times in a row"); break; }
      }
    } catch (e) {
      console.error(`[run] ${run.id}: ${e.stack || e.message}`);
      emit(run, { type: "failed", text: "Error: " + e.message });
    } finally {
      run.cur = null; run.tool = null;
      if (run.pending.length && !run.deleted) await applyPending(run, true).catch(() => {}); // stopped with steers pending: the page starts a new reply with them
      await save(run, null, run.clients.size ? {} : { unread: true }); // nobody watching: mark it for the sidebar
      runs.delete(run.id);
      emit(run, { type: "done" });
      for (const c of run.clients) c.end();
      console.log(`[run] ${run.id} finished${run.stopped ? " (stopped)" : ""}`);
    }
  }

  function stop(run) {
    if (!run) return;
    run.stopped = true;
    if (run.abort) run.abort.abort();
    if (run.approval) run.approval.resolve(false);
  }

  // Output cap per model call (Settings > Engine): reply tokens on top of the thinking budget. With no thinking cap
  // (Default / Max) it's 4x the reply tokens. 0 = no cap (max_tokens isn't sent).
  function outputCap(budget) {
    const reply = Number(getConfig().replyTokens) || 0;
    if (!reply) return undefined;
    return budget === 0 ? reply : budget > 0 ? budget + reply : reply * 4;
  }

  async function start(body) {
    const id = body.chatId;
    if (!id || !chatFile(id)) throw Object.assign(new Error("Bad chat id"), { status: 400 });
    if (runs.has(id)) throw Object.assign(new Error("This chat already has a reply in progress."), { status: 409 });
    let chat;
    try { chat = await readChat(id); } catch { throw Object.assign(new Error("Chat not found (save it first)"), { status: 404 }); }
    if (!body.model) throw Object.assign(new Error("No model selected"), { status: 400 });
    const tools = (Array.isArray(body.tools) ? body.tools : []).filter((t) => t?.function?.name && t.function.name !== "enable_tools");
    const deferred = new Map();
    for (const g of Array.isArray(body.deferred) ? body.deferred : [])
      if (g && g.key && g.name && Array.isArray(g.tools) && g.tools.length)
        deferred.set(g.key, { key: String(g.key), name: String(g.name), note: String(g.note || ""), tools: g.tools.filter((t) => t?.function?.name) });
    if (deferred.size) tools.push(enableSpec([...deferred.values()].map((g) => g.name)));
    const budget = body.think?.budget;
    const run = {
      id, model: body.model, system: String(body.system || ""), tools, vision: visionOf(body.model), imgCache: new Map(),
      allowed: new Set(tools.map((t) => t && t.function && t.function.name).filter(Boolean)),
      think: { body: body.think?.body || {}, budget: body.think?.budget ?? null, message: body.think?.message || "" },
      deferred, loaded: new Set(Array.isArray(chat.loaded) ? chat.loaded : []),
      maxTokens: outputCap(budget),
      messages: (chat.messages || []).filter((m) => !m._partial),
      clients: new Set(), pending: [], cur: null, tool: null, approval: null, abort: null, stopped: false, deleted: false,
    };
    runs.set(id, run);
    console.log(`[run] ${id} started (${run.model}, ${tools.length} tools${deferred.size ? `, ${deferred.size} on Auto` : ""}${run.vision ? ", vision" : ""})`);
    loop(run);
    return run;
  }

  function watch(req, res, id) {
    const run = runs.get(id);
    if (!run) { res.writeHead(204); return res.end(); } // 204 tells EventSource not to reconnect
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`data: ${JSON.stringify({ type: "snapshot", messages: run.messages, cur: run.cur, tool: run.tool, pending: run.pending })}\n\n`);
    run.clients.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 15000);
    req.on("close", () => { clearInterval(ping); run.clients.delete(res); });
  }

  // /api/runs routes.
  async function handle(req, res, { readBody, sendJson }) {
    const u = new URL(req.url, "http://x");
    const m = u.pathname.match(/^\/api\/runs(?:\/([^/]+)(?:\/(events|stop|approve|steer))?)?$/);
    if (!m) return sendJson(res, 404, { error: "Not found" });
    const [, id, action] = m;
    try {
      if (!id && req.method === "GET") return sendJson(res, 200, { active: [...runs.keys()] });
      if (!id && req.method === "POST") { const run = await start(JSON.parse(await readBody(req))); return sendJson(res, 200, { ok: true, id: run.id }); }
      if (id && action === "events" && req.method === "GET") return watch(req, res, id);
      if (id && action === "stop" && req.method === "POST") { stop(runs.get(id)); return sendJson(res, 200, { ok: true }); }
      if (id && action === "steer" && req.method === "POST") {
        const run = runs.get(id);
        if (!run || run.stopped) return sendJson(res, 409, { error: "No reply in progress" }); // the page sends it as a normal message
        return sendJson(res, 200, { ok: true, id: steer(run, JSON.parse(await readBody(req))).id });
      }
      if (id && action === "approve" && req.method === "POST") {
        const b = JSON.parse(await readBody(req)), run = runs.get(id);
        if (run && run.approval && run.approval.id === b.id) run.approval.resolve(b.approved === true);
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 405, { error: "Method not allowed" });
    } catch (e) {
      return sendJson(res, e.status || 400, { error: e.message });
    }
  }

  return {
    handle,
    has: (id) => runs.has(id),
    anyActive: () => runs.size > 0,
    waiting: (id) => !!runs.get(id)?.approval,
    stop: (id) => stop(runs.get(id)),
    deleted: (id) => { const r = runs.get(id); if (r) { r.deleted = true; stop(r); } },
    modeChanged: (id, mode) => { const r = runs.get(id); if (mode === "auto" && r && r.approval) r.approval.resolve(true); },
  };
};
