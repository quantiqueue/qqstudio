// Server-side agent runs. The loop (model -> tool calls -> model ...) lives here, not in the browser, so a reply
// keeps going when the user switches chats, opens Settings, reloads or closes the tab. Progress is saved to the
// chat file as it streams; any number of pages can watch a run through an event stream and stop it.
const fs = require("fs");
const path = require("path");
const secrets = require("./secrets");
const lazy = require("./lazytools");

// Images re-sent to a vision model on each step: the newest 4 to 8. Older ones become a short note, 4 at a time, so the
// conversation sent doesn't change at every new image (that would make llama-server read it again from there).
const MAX_IMAGES = 8, IMAGE_STEP = 4;
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
// ask_user's questions as small models write them: {questions:[…]}, one question at the top level, options as strings.
function normQuestions(args) {
  let qs = Array.isArray(args.questions) ? args.questions : args.question ? [args] : [];
  qs = qs.slice(0, 4).map((q) => {
    const opts = (Array.isArray(q.options) ? q.options : []).slice(0, 4)
      .map((o) => (typeof o === "string" ? { label: o } : o && typeof o === "object" ? { label: String(o.label ?? o.name ?? ""), description: o.description ? String(o.description) : "", recommended: o.recommended === true } : null))
      .filter((o) => o && o.label.trim());
    opts.sort((a, b) => b.recommended - a.recommended); // the recommended option first
    return { question: String(q.question || "").trim(), header: String(q.header || "").slice(0, 16), multiple: q.multiple === true, options: opts };
  }).filter((q) => q.question && q.options.length >= 2);
  return qs.length ? { value: qs } : { error: "ask_user needs questions: [{question, options: [{label, description, recommended}, …]}] with 1-4 questions of 2-4 options each." };
}
// The answers as the model gets them.
function answerText(qs, a) {
  if (a.text) return `The user answered in their own words: "${a.text}"`;
  return "The user's answers:\n" + qs.map((q, i) => {
    const x = (a.answers || [])[i] || {}, picks = (x.choices || []).filter((c) => q.options.some((o) => o.label === c));
    const parts = picks.map((c) => c + (q.options.find((o) => o.label === c)?.recommended ? " (your recommendation)" : ""));
    if (x.other) parts.push(`their own answer: "${x.other}"`);
    return `${i + 1}. ${q.question} → ${parts.join("; ") || "(no answer)"}`;
  }).join("\n");
}
const AGENT_TOOLS = new Set(["run_agent", "message_agent", "stop_agent", "check_agent"]);
const stripUi = (m) => Object.fromEntries(Object.entries(m).filter(([k]) => !k.startsWith("_")));

module.exports = function createRuns({ llama, runTool, toolList, isEnabled, chatFile, updateChat, statusOf, modelState = async () => null, visionOf, loadImage, imagePathsIn, uploadPath, getConfig, nCtx, nSlots = async () => null, samplingFor = () => ({}), ensureEngine = async () => {}, newSession = null, filesDirOf = () => null, mcpCwd = () => null }) {
  const runs = new Map(); // chatId -> run

  // ---------- prompt cache ----------
  // llama-server keeps each slot's last prompt and reuses its matching start. A request can land on any slot, and one
  // whose start doesn't match is read in full (~25 s for 50k tokens), so each session is pinned to a slot (id_slot):
  // the one it used last, unless another running reply has it; otherwise the slot used least recently.
  const slotOf = new Map(), slotUsed = new Map(); // chatId -> slot, slot -> last use
  async function pickSlot(run, avoid = null) {
    const n = await nSlots(run.model).catch(() => null);
    if (!n || n < 2) return undefined;
    const busy = new Set([...runs.values()].filter((r) => r !== run && r.slot !== undefined).map((r) => r.slot));
    if (avoid !== null) busy.add(avoid);
    let s = avoid === null ? slotOf.get(run.id) : undefined;
    if (s === undefined || s >= n || busy.has(s)) {
      const owned = new Set([...slotOf].filter(([c]) => c !== run.id).map(([, x]) => x));
      const free = [...Array(n).keys()].filter((x) => !busy.has(x));
      free.sort((a, b) => (owned.has(a) - owned.has(b)) || ((slotUsed.get(a) || 0) - (slotUsed.get(b) || 0)));
      s = free[0];
    }
    if (s !== undefined) { slotUsed.set(s, Date.now()); if (avoid === null) slotOf.set(run.id, s); }
    return s;
  }
  // What changed since this session's previous request, to say why llama-server read the prompt again.
  const lastPrompt = new Map(); // chatId -> part hashes [instructions, tool list, message 1, …]
  const hash = (x) => require("crypto").createHash("md5").update(typeof x === "string" ? x : JSON.stringify(x)).digest("hex");
  function promptChange(run, body) {
    const parts = [hash(body.messages[0].content), hash(body.tools || []), ...body.messages.slice(1).map(hash)];
    const prev = lastPrompt.get(run.id);
    lastPrompt.set(run.id, parts);
    if (!prev) return "first request";
    const i = parts.findIndex((p, k) => p !== prev[k]);
    if (i === -1 || i >= prev.length) return null; // only added at the end
    return i === 0 ? "the instructions changed" : i === 1 ? "the tool list changed" : `message ${i - 1} (${body.messages[i - 1].role}) changed`;
  }

  const readChat = async (id) => JSON.parse(await fs.promises.readFile(chatFile(id), "utf8"));
  function emit(run, ev) {
    const line = `data: ${JSON.stringify(ev)}\n\n`;
    for (const c of run.clients) c.write(line);
    if (run.parentRun) onSubEvent(run, ev);
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

  // "[Attached file saved at C:\\…\\report.pdf]" for files the user attached that aren't pictures (read_file reads them).
  function filesNote(files) {
    const list = (files || []).map((f) => f && f.path).filter(Boolean);
    if (!list.length) return "";
    return list.length === 1 ? `[Attached file saved at ${list[0]}]` : `[Attached files saved at:\n${list.map((f) => "- " + f).join("\n")}]`;
  }

  // The conversation as the model gets it. For vision models, images pasted by the user go into their message and
  // images returned by tools follow the tool results as one user message (tool messages can't carry images).
  // Every model (vision or not) is told where pasted images are saved, so it can hand the file to a tool.
  async function modelMessages(run) {
    const all = run.messages;
    run = { ...run, messages: all.slice(lastSummary(all)) }; // compacted turns are replaced by their summary
    const plain = run.messages.map((m) => {
      const base = stripUi(m);
      const note = m.role === "user" && [pathNote(m._images), filesNote(m._files)].filter(Boolean).join("\n");
      return note ? { ...base, content: (typeof base.content === "string" && base.content ? base.content + "\n\n" : "") + note } : base;
    });
    if (!run.vision) return plain;
    const refs = run.messages.flatMap((m) => m._images || []);
    const cut = refs.length <= MAX_IMAGES ? 0 : Math.ceil((refs.length - MAX_IMAGES) / IMAGE_STEP) * IMAGE_STEP;
    const keep = new Set(refs.slice(cut));
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
    if (!run.nCtx) run.nCtx = await nCtx(run.model); // null until the loadout is running
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
    let summary = "", release = null;
    try {
      run.abort = new AbortController();
      release = await ensureEngine(run.model, null, run.abort.signal);
      const r = await fetch(`${llama.url()}/v1/chat/completions`, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: run.abort.signal,
        body: JSON.stringify({ model: run.model, stream: false, max_tokens: 3000, temperature: 0.3, ...((s) => (s === undefined ? {} : { id_slot: s }))(await pickSlot(run, run.slot ?? -1)),
          chat_template_kwargs: { enable_thinking: false }, reasoning_budget_tokens: 0, thinking_budget_tokens: 0,
          messages: [{ role: "system", content: SUMMARY_PROMPT }, { role: "user", content: `Summarize this conversation so far:\n\n${text}` }] }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error?.message || j.error || r.statusText);
      summary = (j.choices?.[0]?.message?.content || "").trim();
    } catch (e) {
      if (!run.stopped) emit(run, { type: "notice", text: "Compaction failed: " + e.message });
      return;
    } finally { run.abort = null; run.cur = null; if (release) release(); }
    if (!summary || run.stopped) return;
    const msg = { role: "user", content: `[Summary of the earlier part of this session, which was compacted to save context]\n\n${summary}`,
      _summary: true, _meta: `Compacted ${older.length} messages (≈${Math.round(size / 1000)}k of ${Math.round(run.nCtx / 1000)}k tokens) · ${((Date.now() - t0) / 1000).toFixed(1)}s` };
    run.messages.splice(keep, 0, msg);
    console.log(`[run] ${run.id} compacted ${older.length} messages at ${size}/${run.nCtx} tokens`);
    emit(run, { type: "compacted", at: keep, msg });
    // The prompt is read again from here on anyway: tools on request the session has used get their full details now
    // (their tool_info results were just summarized away), and keep them in later replies.
    // Groups the model turned on (their enable_tools results may have just been summarized) are listed in the instructions.
    const add = [...run.used].filter((n) => run.lazy.has(n) && !run.promoted.has(n));
    for (const n of add) run.promoted.add(n);
    for (const n of run.lazy.keys()) run.listed.add(n);
    setTools(run);
    setSystem(run);
    if (add.length) console.log(`[run] ${run.id} full details for ${add.length} tools on request: ${add.join(", ")}`);
    await save(run, null, { promoted: [...run.promoted], inPrompt: [...run.loaded] });
  }

  async function step(run) {
    const { model } = run;
    const cur = run.cur = { model, content: "", reasoning: "", phase: "Sending request", pct: null, gen: null }; // gen: {n, t0, tool} generated tokens this step
    const t0 = Date.now();
    let think0 = null, think1 = null, timings = null, failed = false, retry = false, gotChunk = false, lastSave = Date.now();
    let looped = false, finish = null, ended = false, checkedAt = 0, usage = null, ppTotal = 0, changed = null, cached = null;
    const calls = [];
    emit(run, { type: "step", model });
    const phase = (text, pct = null) => {
      if (cur.phase === text && cur.pct === pct) return;
      cur.phase = text; cur.pct = pct;
      emit(run, { type: "phase", text, pct });
    };
    // Once the request is sent and until the first token: "Reading prompt" (or the loadout's state if it went away).
    let polling = true, sent = false, release = null;
    (async () => {
      while (polling && !run.stopped) {
        try {
          const st = sent ? await modelState(model) : undefined;
          if (!polling) break;
          if (st === "failed") phase("Model failed to load (Settings > Loadouts > Log)");
          else if (st === "loading") phase("Loading model");
          else if (sent && !gotChunk) phase("Reading prompt");
        } catch {}
        await sleep(1000);
      }
    })();

    run.abort = new AbortController();
    try {
      // The loadout must be the one running: loading it (and unloading another) if needed, or waiting while another
      // loadout is mid-reply. Held until this request ends.
      release = await ensureEngine(model, (t, pct) => phase(t, pct ?? null), run.abort.signal);
      await syncAgentSpec(run).catch(() => {}); // run_agent's description says how many run at once
      sent = true;
      const body = {
        model, messages: [{ role: "system", content: run.system }, ...(await modelMessages(run))],
        return_progress: true, stream_options: { include_usage: true }, ...samplingFor(model), ...run.think.body, stream: true,
        max_tokens: run.maxTokens,
      };
      if (run.tools.length) body.tools = run.tools;
      if (run.slot === undefined) run.slot = await pickSlot(run);
      if (run.slot !== undefined) body.id_slot = run.slot;
      changed = promptChange(run, body);
      const r = await fetch(`${llama.url()}/v1/chat/completions`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: run.abort.signal,
      });
      if (!r.ok) { const t = await r.text(); let msg = t; try { const j = JSON.parse(t); msg = j.error?.message || j.error || t; } catch {} throw new Error(msg || r.statusText); }
      const dec = new TextDecoder();
      let buf = "";
      run.stream = r.body; // Stop cancels it too: aborting the fetch alone doesn't end a body that's already streaming on older Node 18
      for await (const chunk of r.body) {
        if (run.stopped) break; // leaving the loop cancels the stream, which closes the connection, so llama-server stops generating
        buf += dec.decode(chunk, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") { ended = true; continue; }
          if (!data) continue;
          let j; try { j = JSON.parse(data); } catch { continue; }
          if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
          if (j.timings) timings = j.timings;
          if (j.usage) { usage = { prompt: j.usage.prompt_tokens, completion: j.usage.completion_tokens }; emit(run, { type: "usage", ...usage, model }); }
          if (!gotChunk) { gotChunk = true; polling = false; if (!cur.content) phase("Reading prompt"); }
          const pp = j.prompt_progress;
          if (pp && pp.total && pp.total !== ppTotal) { ppTotal = pp.total; emit(run, { type: "usage", prompt: pp.total, completion: 0, model, reading: true }); } // exact prompt size, early
          if (pp && pp.total && cached === null) cached = { cache: pp.cache || 0, total: pp.total };
          if (pp && pp.total && !cur.content && !cur.reasoning) {
            const done = Math.max(0, pp.processed - (pp.cache || 0)), todo = Math.max(1, pp.total - (pp.cache || 0));
            const k = (n) => n.toLocaleString("en-US");
            phase(pp.cache ? `Reading prompt · ${k(done)}/${k(todo)} new tokens · ${k(pp.cache)} cached` : `Reading prompt · ${k(pp.processed)}/${k(pp.total)} tokens`,
              Math.min(100, Math.round((done / todo) * 100)));
          }
          if (j.choices?.[0]?.finish_reason) finish = j.choices[0].finish_reason;
          const d = j.choices && j.choices[0] && j.choices[0].delta;
          if (!d) continue;
          const ev = { type: "delta" };
          if (d.reasoning_content || d.content || d.tool_calls) { // one streamed chunk = one token (llama-server); prefer its own count when sent
            const g = cur.gen = cur.gen || { n: 0, total: 0, base: 0, t0: Date.now(), tool: null, sent: 0, thinking: false };
            g.total = timings?.predicted_n > g.total ? timings.predicted_n : g.total + 1;
            if (d.reasoning_content && !d.content && !d.tool_calls) g.thinking = true;
            else if (g.thinking) { g.thinking = false; g.base = g.total - 1; g.t0 = Date.now(); } // count and time the reply from where thinking ended
            g.n = g.total - g.base;
          }
          if (d.reasoning_content) {
            if (think0 === null) think0 = Date.now();
            cur.reasoning += d.reasoning_content; ev.r = d.reasoning_content;
            if (!cur.content) phase("Thinking");
          }
          if ((d.content || d.tool_calls) && think0 !== null && think1 === null) think1 = Date.now(); // a tool call also ends thinking
          if (d.content) {
            cur.content += d.content; ev.c = d.content; cur.phase = null;
          }
          if (ev.r || ev.c) { ev.n = cur.gen.n; ev.tot = run.genDone + cur.gen.total; cur.gen.sent = Date.now(); emit(run, ev); }
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
            cur.gen.tool = calls[i].function.name || cur.gen.tool;
          }
          if (d.tool_calls && (!cur.gen.toolSent || Date.now() - cur.gen.sent >= 250)) { // tool-call arguments stream silently otherwise
            cur.gen.sent = Date.now(); cur.gen.toolSent = true;
            emit(run, { type: "delta", n: cur.gen.n, tot: run.genDone + cur.gen.total, tool: cur.gen.tool || "" });
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
      // The reply already finished and the server then dropped the connection without ending the stream (Strata's
      // server does this): Node's fetch reports "terminated", but nothing is missing.
      if ((ended || finish) && !run.stopped && !looped && (e.message === "terminated" || e.cause?.code === "UND_ERR_SOCKET")) e = null;
      if (!e) {} else
      // llama-server couldn't read the model's tool call (e.g. "does not match the expected peg-native format": a stray
      // space or token in the template's tool-call syntax, common with small or heavily quantized models). Sampling
      // differs each time, so the same step is asked again, up to twice in a row, before it counts as a failure.
      if (!run.stopped && !looped && /does not match the expected .*format|failed to parse/i.test(e.message) && (run.unreadable || 0) < 2) {
        retry = true; run.unreadable = (run.unreadable || 0) + 1;
        console.log(`[run] ${run.id} unreadable tool call (${e.message}); asking again (${run.unreadable} of 2)`);
        emit(run, { type: "retry", text: `The model's tool call came out malformed, so it was asked again (${run.unreadable} of 2).` });
      } else if (!run.stopped && !looped) {
        failed = true;
        run.endReason = "an error: " + (e.cause?.code === "ECONNREFUSED" ? "llama-server couldn't be reached" : e.message); // a sub-agent's report says so
        emit(run, { type: "failed", text: (cur.content ? cur.content + "\n\n" : "") + "Error: " + (e.cause?.code === "ECONNREFUSED" ? `Cannot reach llama-server at ${llama.url()}` : e.message) });
      }
    } finally {
      polling = false;
      run.abort = null; run.stream = null;
      if (release) release();
    }
    const toolCalls = calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${Date.now()}_${i}` }));
    { // prompt cache report: how much llama-server reused, and what changed when it read a lot again
      const total = timings?.prompt_n != null && timings?.cache_n != null ? timings.prompt_n + timings.cache_n : cached?.total;
      const hit = timings?.cache_n ?? cached?.cache;
      if (total) console.log(`[run] ${run.id} prompt ${total} tokens, ${hit ?? "?"} cached${run.slot !== undefined ? ` (slot ${run.slot})` : ""}` +
        (hit != null && total - hit > 2000 && changed ? ` · read again: ${changed}` : ""));
    }
    // Reply only: time from its first token (after thinking) and its own token count. Thinking has its own "Thought for" line.
    const g = cur.gen, replied = g && !g.thinking;
    if (g && timings?.predicted_n > g.total) { g.total = timings.predicted_n; g.n = g.total - g.base; }
    run.genDone += g ? g.total : 0; // the whole reply's count (all steps, thinking included) for the footer
    const secs = ((Date.now() - (replied ? g.t0 : t0)) / 1000).toFixed(1);
    const meta = `${model} · ${secs}s` +
      (replied ? ` · ${g.n} tok` + (timings?.predicted_per_second ? ` @ ${timings.predicted_per_second.toFixed(1)} tok/s` : "") : "") +
      (run.stopped ? " · stopped" : looped ? " · stopped: repeating" : finish === "length" ? " · cut off (length limit)" : "");
    const thinkSecs = think0 === null ? null : +(((think1 ?? Date.now()) - think0) / 1000).toFixed(1);
    const tb = run.think.budget, note = (run.think.message || "").trim();
    const budgetHit = !!(cur.reasoning && tb > 0 && (cur.reasoning.length / 3.6 >= tb * 0.9 || (note && cur.reasoning.trim().endsWith(note))));
    if (!retry && !failed) run.unreadable = 0;
    return { content: cur.content, reasoning: cur.reasoning, toolCalls: looped ? [] : toolCalls, usage, meta, failed, retry, thinkSecs, budgetHit, looped, t0 };
  }

  // The instructions: the page's system prompt plus the compact list of tools on request (minus those with full details).
  // Both are built in a fixed order (the order servers list their tools), so the same session state always gives the
  // same prompt: a different order would make llama-server read everything after it again.
  const byOrder = (run) => (a, b) => (run.order.get(a.name) ?? 1e9) - (run.order.get(b.name) ?? 1e9);
  function setSystem(run) {
    run.system = run.baseSystem + lazy.section([...run.lazy.values()].filter((t) => run.listed.has(t.name) && !run.promoted.has(t.name)).sort(byOrder(run)));
  }
  // The tool list: the page's tools, then tools on request that got full details, then tool_info / call_tool.
  function setTools(run) {
    const full = [...run.lazy.values()].filter((t) => run.promoted.has(t.name)).sort(byOrder(run)).map((t) => t.spec);
    run.tools = [...run.baseTools, ...full, ...(run.viaCall ? [lazy.INFO_SPEC, lazy.CALL_SPEC] : [])];
    run.allowed = new Set(run.tools.map((t) => t.function.name));
  }

  // Moves a deferred group's tools into the run (usable from the next step) and remembers it for the chat.
  // A group on request only joins the pool call_tool draws from; its compact list is the result, so the tool list
  // sent with each request doesn't change.
  async function enableTools(run, args) {
    const want = String(args.name || "").trim().toLowerCase();
    const g = [...run.deferred.values()].find((x) => x.name.toLowerCase() === want);
    if (!g) return { status: "error", text: `ERROR: no tool group named "${args.name}". Available: ${[...run.deferred.values()].map((x) => x.name).join(", ") || "none"}.` };
    if (run.loaded.has(g.key)) return { status: "done", text: `${g.name} is already on. ` + (g.tools.length <= 12 ? `Its tools: ${g.tools.map((t) => t.function.name).join(", ")}. ` : "") + `Run them with call_tool (tool_info gives their parameters).` };
    // Its tools join the pool call_tool draws from; the tool list sent with each request stays the same.
    const ts = g.tools.map((s) => run.byName.get(s.function.name)).filter(Boolean).map((t) => ({ ...t, group: g.name }));
    for (const t of ts) run.lazy.set(t.name, t);
    run.loaded.add(g.key);
    emit(run, { type: "loaded", loaded: [...run.loaded] });
    await save(run, null, { loaded: [...run.loaded] });
    console.log(`[run] ${run.id} enabled ${g.key} (${ts.length} tools, through call_tool)`);
    const text = g.lazy ? `${g.name} is on. ${lazy.section(ts).trim()}` // big: names only, details from tool_info
      : `${g.name} is on. Run its tools with call_tool {"name": "<tool>", "arguments": {…}}:\n\n` + lazy.info(ts.map((t) => t.name), run.lazy).text.replace(/\n\nRun one with call_tool.*$/s, "");
    return { status: "done", text: text + (g.note ? "\n\n" + g.note : "") };
  }

  // Shows the questions in the session (a card with the options) and waits for the answers, however long it takes, like an
  // approval. Typing a message instead answers too. Stop cancels.
  async function askUser(run, tc, args) {
    const q = normQuestions(args);
    if (q.error) return { status: "bad arguments", text: "ERROR: " + q.error };
    const answers = await new Promise((resolve) => {
      run.question = { id: tc.id, tc, questions: q.value, resolve };
      emit(run, { type: "question", id: tc.id, tc, questions: q.value });
    });
    run.question = null;
    if (run.stopped || !answers) return { status: "cancelled", text: "Cancelled by user." };
    emit(run, { type: "answered", id: tc.id, answers });
    console.log(`[run] ${run.id} questions answered`);
    return { status: "done", text: answerText(q.value, answers), answers: { questions: q.value, ...answers } };
  }

  // The session's task list: saved with the session and shown above the message box.
  async function todoTool(run, args) {
    const STATUS = { pending: "pending", in_progress: "in_progress", done: "done", completed: "done", complete: "done", todo: "pending", doing: "in_progress" };
    const items = (Array.isArray(args.items) ? args.items : Array.isArray(args.todos) ? args.todos : []).slice(0, 30)
      .map((x) => (typeof x === "string" ? { text: x, status: "pending" } : { text: String(x?.text ?? x?.content ?? x?.task ?? "").trim().slice(0, 200), status: STATUS[String(x?.status || "").toLowerCase()] || "pending" }))
      .filter((x) => x.text);
    if (!items.length) return { status: "bad arguments", text: "ERROR: todo needs items: [{text, status}] with status pending, in_progress or done." };
    emit(run, { type: "todo", items });
    await save(run, null, { todo: items });
    const done = items.filter((x) => x.status === "done").length, cur = items.find((x) => x.status === "in_progress");
    return { status: "done", text: `Task list saved: ${done} of ${items.length} done${cur ? `; in progress: ${cur.text}` : ""}.` };
  }

  // ---------- sub-agents ----------
  // run_agent starts a sub-agent: a separate run with its own session (hidden from the sidebar, opened from its chip)
  // and its own context, working in the background. Its final reply comes back to the main conversation as a report,
  // by itself; while sub-agents work, a main reply that has nothing left to do waits (no model calls) instead of ending.
  const agentsCfg = () => { const a = getConfig().agents || {}; return { maxActive: Math.max(1, Number(a.maxActive) || 1), reportWords: Math.max(50, Number(a.reportWords) || 300), instructions: String(a.instructions || "") }; };
  const activeSubs = (run) => [...run.subs.values()].filter((s) => s.status === "running").length;
  // Running or pending (waiting for a free place): the main reply waits for both.
  const liveSubs = (run) => [...run.subs.values()].filter((s) => s.status === "running" || s.status === "pending").length;
  // How many sub-agents run at once: Settings > Agents, and at most one fewer than the engine's slots (the main reply
  // keeps one). Remembered per loadout, so the number in run_agent's description doesn't change from one message to the
  // next while the engine isn't answering yet (the tool list is at the top of the prompt: prompt cache).
  const agentMaxMemo = new Map(); // loadout id -> { maxActive, max }
  async function agentMax(model) {
    const cfg = agentsCfg(), slots = await nSlots(model).catch(() => null), memo = agentMaxMemo.get(model);
    if (!slots && memo && memo.maxActive === cfg.maxActive) return memo.max;
    const max = slots && slots > 1 ? Math.min(cfg.maxActive, slots - 1) : cfg.maxActive;
    agentMaxMemo.set(model, { maxActive: cfg.maxActive, max });
    return max;
  }
  const agentDesc = (base, max, words) => `${base} At most ${plural(max, "sub-agent")} run${max === 1 ? "s" : ""} at once. You can still start more in the same step: ` +
    `the extra ones are pending and start by themselves, in order, as running ones finish. Each report is at most ${words} words (longer ones are cut): ask for what fits, and have it save longer results to a file.`;
  // run_agent's description says the limit: in the tool list, in the Agents group (enable_tools) and in tool_info.
  // Called before each model request (the engine is up then, so its slots are known); changes only with the setting.
  async function syncAgentSpec(run) {
    if (run.parentRun) return;
    const base = run.agentBase || run.byName.get("run_agent");
    if (!base) return;
    run.agentBase = base;
    const max = await agentMax(run.model), words = agentsCfg().reportWords, key = `${max}/${words}`;
    if (run.agentKey === key) return;
    run.agentKey = key;
    const description = agentDesc(base.description, max, words);
    const fix = (sp) => (sp?.function?.name === "run_agent" ? { ...sp, function: { ...sp.function, description } } : sp);
    run.byName.set("run_agent", { ...base, description, spec: fix(base.spec) });
    run.baseTools = run.baseTools.map(fix);
    for (const g of run.deferred.values()) g.tools = g.tools.map(fix);
    const t = run.lazy.get("run_agent");
    if (t) run.lazy.set("run_agent", { ...t, description, spec: fix(t.spec) });
    setTools(run);
  }
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  function agentInfo(s) {
    if (s.status === "pending" || !s.run) return { id: s.id, alias: s.alias, title: s.title, status: s.status, tokens: 0, ms: Date.now() - s.t0, tc: null };
    const r = s.run, live = s.status === "running", asking = live && r.tool?.status === "approval"; // (set just before the approval wait begins)
    return { id: s.id, alias: s.alias, title: s.title, status: live ? (asking ? "approval" : "running") : s.status,
      tokens: live ? r.genDone + (r.cur?.gen?.total || 0) : s.tokens, ms: (s.end || Date.now()) - s.t0, tc: asking ? r.tool.tc : null };
  }
  const subTokens = (run) => [...run.subs.values()].reduce((n, s) => n + (agentInfo(s).tokens || 0), 0); // its sub-agents' tokens, for the footer
  const relay = (s) => { s.relayAt = Date.now(); if (runs.get(s.parent.id) === s.parent) emit(s.parent, { type: "agent", ...agentInfo(s) }); }; // s.parent: s.run is null while it's pending or starting
  function onSubEvent(run, ev) { // the main session's chip follows the sub-agent: approvals right away, progress about once a second
    const s = run.parentRun.subs.get(run.id);
    if (!s || s.status !== "running" || !s.run) return; // (events while start() hasn't returned yet)
    if (ev.type === "tool" || ev.type === "step" || ((ev.type === "delta" || ev.type === "assistant") && Date.now() - (s.relayAt || 0) > 1000)) relay(s);
  }
  function findSub(run, key) {
    const k = String(key || "").trim().toLowerCase();
    return [...run.subs.values()].find((s) => s.id === k || s.alias === k) || [...run.subs.values()].find((s) => s.title.toLowerCase() === k);
  }
  // Waits (no model calls) until a report or a message arrives, the sub-agents finish, or Stop. Returns true to go on.
  const CHECK_WAIT = 60000; // how long check_agent waits for a running sub-agent
  // The tool a run is waiting for approval on (the real one when it came through call_tool).
  function askedTool(r) {
    const tc = r.tool?.tc;
    if (!tc) return "a tool call";
    let n = tc.function.name;
    if (n === "call_tool") try { n = JSON.parse(tc.function.arguments || "{}").name || n; } catch {}
    return n;
  }
  // While a sub-agent waits for the user's approval, the main reply pauses before its next step: otherwise models treat
  // the wait as "stuck" and redo the work themselves, or tell the sub-agent to skip approval.
  const subAsking = (run) => [...run.subs.values()].some((s) => s.status === "running" && s.run?.approval);
  async function waitForApproval(run) {
    if (!subAsking(run)) return;
    run.waitWhy = "approval";
    emit(run, { type: "waiting", on: true, why: "approval" });
    while (subAsking(run) && !run.stopped) await sleep(300);
    run.waitWhy = null;
    emit(run, { type: "waiting", on: false });
  }
  async function idle(run) {
    emit(run, { type: "waiting", on: true });
    await new Promise((resolve) => { run.wake = resolve; if (run.pending.length || !liveSubs(run) || run.stopped) resolve(); });
    run.wake = null;
    emit(run, { type: "waiting", on: false });
    return !run.stopped && run.pending.length > 0;
  }
  // The main assistant's task list follows its sub-agents: the task that best matches a sub-agent's title becomes
  // in_progress when it starts and done when it finishes (pending again if it was stopped). Models often don't update
  // the list while they wait, so without this it showed the wrong task as underway.
  const STOP_WORDS = new Set(["a", "an", "the", "to", "and", "of", "for", "with", "in", "on", "it", "sub", "agent", "subagent", "agents", "launch", "run", "start", "use", "using"]);
  const taskWords = (t) => new Set(String(t || "").toLowerCase().replace(/sub-?agents?/g, " ").split(/[^a-z0-9]+/).filter((w) => w && !STOP_WORDS.has(w)));
  function bestTask(items, title, skipDone) {
    const want = taskWords(title);
    if (!want.size) return -1;
    let best = -1, score = 0;
    items.forEach((it, i) => {
      if (skipDone && it.status === "done") return;
      // shared words over the shorter of the two: "Draw a red square (fresh canvas)" still matches "Draw a red square"
      const have = taskWords(it.text), hit = have.size ? [...want].filter((w) => have.has(w)).length / Math.min(want.size, have.size) : 0;
      if (hit >= 0.6 && hit > score) { score = hit; best = i; }
    });
    return best;
  }
  async function markTask(run, title, status) {
    let items = null;
    await updateChat(chatFile(run.id), (disk) => {
      if (!disk || !Array.isArray(disk.todo) || !disk.todo.length) return null;
      const i = bestTask(disk.todo, title, true);
      if (i < 0 || disk.todo[i].status === status) return null;
      items = disk.todo.map((it, k) => (k === i ? { ...it, status } : it));
      return { ...disk, todo: items };
    }).catch(() => {});
    if (items && runs.get(run.id) === run) emit(run, { type: "todo", items });
  }

  // The reply is about to end with tasks still not done on its list: models often say "all done" without updating it.
  // Once per reply, ask it to update the list (a hidden note, not shown as your message), then let it end.
  async function todoNudge(run) {
    if (run.todoNudged || run.parentRun || !(run.allowed.has("todo") || run.lazy.has("todo"))) return false;
    let chat = null; try { chat = await readChat(run.id); } catch {}
    const open = (chat?.todo || []).filter((t) => t.status !== "done");
    if (!open.length) return false;
    run.todoNudged = true;
    run.messages.push({ role: "user", _hidden: true, content: `[Note from qqstudio, not the user] Your task list still shows ${open.length} of ${chat.todo.length} not done: ${open.map((t) => `"${t.text}"`).join(", ")}. If they're finished, update the list with todo (mark them done); if not, say what's left. Then end your turn.` });
    await save(run);
    console.log(`[run] ${run.id} reminded it of ${open.length} unfinished task(s)`);
    return true;
  }

  // Starts a pending sub-agent's run (status first, so two finishing at once don't start the same one).
  async function launchSub(run, s) {
    s.status = "running"; s.t0 = Date.now();
    try { s.run = await start(s.body, { parentRun: run }); }
    catch (e) { s.status = "halted"; s.reason = "it couldn't start: " + e.message; s.end = Date.now(); relay(s); console.error(`[run] ${run.id} sub-agent ${s.alias}: ${e.message}`); return; }
    for (const text of s.notes) steer(s.run, { text: `[Message from the main assistant] ${text}` });
    relay(s);
    markTask(run, s.title, "in_progress");
    console.log(`[run] ${run.id} started sub-agent ${s.alias} (${s.id}): ${s.title}`);
  }
  // A place freed up: start pending sub-agents, oldest first.
  async function startNext(run) {
    if (run.stopped || runs.get(run.id) !== run) return;
    const max = await agentMax(run.model);
    for (const s of [...run.subs.values()]) {
      if (activeSubs(run) >= max || run.stopped) break;
      if (s.status === "pending") await launchSub(run, s);
    }
  }
  // A pending sub-agent that won't start (stop_agent, Stop, or the reply ended): a short report says so.
  function cancelPending(run, s, why = "it was cancelled") {
    if (s.status !== "pending") return;
    s.status = "stopped"; s.end = Date.now();
    markTask(run, s.title, "pending");
    const meta = { id: s.id, alias: s.alias, title: s.title, status: "stopped", tokens: 0, ms: s.end - s.t0 };
    run.pending.push({ id: "rep-" + s.id, report: meta, text: `[Sub-agent ${s.alias} "${s.title}" never started: ${why} while it was pending.]` });
    relay(s);
    if (run.wake) run.wake();
  }
  const pendingSub = (id) => { for (const r of runs.values()) { const s = r.subs.get(id); if (s?.status === "pending") return [r, s]; } return null; };

  async function agentTool(run, name, tc, args) {
    if (name === "run_agent") {
      const title = String(args.title || args.name || "").trim().slice(0, 60) || "Sub-agent", task = String(args.task || args.instructions || args.prompt || "").trim();
      if (!task) return { status: "bad arguments", text: "ERROR: run_agent needs task: the full instructions for the sub-agent (it doesn't see this conversation)." };
      const cfg = agentsCfg(), max = await agentMax(run.model);
      if (!newSession) return { status: "error", text: "ERROR: sub-agents aren't available." };
      let parentChat = {}; try { parentChat = await readChat(run.id); } catch {}
      const id = await newSession(run.id, { title, model: run.model, mode: parentChat.mode || "manual", effort: parentChat.effort, thinkBudget: parentChat.thinkBudget, messages: [{ role: "user", content: task }] });
      const note = `\n\nYou are a sub-agent: the main assistant handed you one task (the user message). Do it with your tools; you can't ask the user anything. ` +
        `When you are done, reply with a short report for the main assistant (at most ${cfg.reportWords} words): what you did, what you found, and anything left undone. That reply is passed back automatically.` +
        (cfg.instructions.trim() ? "\n" + cfg.instructions.trim() : "");
      const NO_SUB = new Set([...AGENT_TOOLS, "ask_user"]);
      const body = { chatId: id, model: run.model, system: run.baseSystem + note,
        tools: (run.body.tools || []).filter((t) => !NO_SUB.has(t?.function?.name)),
        deferred: (run.body.deferred || []).filter((g) => g.key !== "cat:Questions" && g.key !== "cat:Agents"), think: run.think };
      // Past the limit it's pending: its session exists (the chip opens it), and it starts when a running one finishes.
      const s = { id, alias: "a" + ++run.agentSeq, title, status: "pending", t0: Date.now(), tokens: 0, run: null, parent: run, body, notes: [] };
      run.subs.set(id, s);
      if (activeSubs(run) < max) await launchSub(run, s);
      else { relay(s); console.log(`[run] ${run.id} sub-agent ${s.alias} (${id}) pending: ${title}`); }
      if (s.status === "running") return { status: "done", agent: { id, alias: s.alias, title },
        text: `Started sub-agent ${s.alias} ("${title}"). This reply now waits until its report arrives here, then continues. Start any other sub-agents you need in this same step.` };
      if (s.status !== "pending") return { status: "error", text: `ERROR: sub-agent ${s.alias} couldn't start: ${s.reason || "unknown error"}.` };
      const line = [...run.subs.values()].filter((x) => x.status === "pending").indexOf(s) + 1;
      return { status: "done", agent: { id, alias: s.alias, title, status: "pending" },
        text: `Sub-agent ${s.alias} ("${title}") is pending: ${plural(max, "sub-agent")} run at once and ${activeSubs(run)} ${activeSubs(run) === 1 ? "is" : "are"} running; it's number ${line} in line. ` +
          `It starts by itself when a place frees up, and its report arrives here. This reply waits for the reports. Start any other sub-agents you need in this same step.` };
    }
    const s = findSub(run, args.id ?? args.agent ?? args.name);
    if (!s) return { status: "error", text: `ERROR: no sub-agent "${args.id ?? ""}". Sub-agents in this reply: ${[...run.subs.values()].map((x) => `${x.alias} (${x.title}, ${x.status})`).join(", ") || "none"}.` };
    if (s.status === "pending") {
      if (name === "check_agent") return { status: "done", text: `${s.alias} "${s.title}" is pending: number ${[...run.subs.values()].filter((x) => x.status === "pending").indexOf(s) + 1} in line, waiting for a running sub-agent to finish. It starts by itself; end your turn to wait.` };
      if (name === "message_agent") {
        const text = String(args.text || args.message || "").trim();
        if (!text) return { status: "bad arguments", text: "ERROR: message_agent needs text." };
        s.notes.push(text);
        return { status: "done", text: `${s.alias} is pending; it gets the message when it starts.` };
      }
      cancelPending(run, s, "stop_agent cancelled it");
      return { status: "done", text: `Cancelled ${s.alias}; it hadn't started.` };
    }
    if (s.status === "running" && !s.run) return { status: "done", text: `${s.alias} "${s.title}" is starting. Its report arrives here by itself; end your turn to wait.` };
    if (name === "check_agent") {
      // A running sub-agent: wait (up to a minute) for it to finish or need the user, instead of answering at once. Small
      // models otherwise call check_agent in a tight loop, and every check is a model request that competes with the
      // sub-agent for the same model, slowing it down until the main assistant decides it's stuck.
      const t0 = Date.now(), tok0 = agentInfo(s).tokens;
      while (s.status === "running" && !s.run?.approval && !run.stopped && !run.pending.length && Date.now() - t0 < CHECK_WAIT) await sleep(500);
      const waited = Math.round((Date.now() - t0) / 1000);
      if (s.status !== "running") return { status: "done", text: `${s.alias} "${s.title}" has ${s.status === "done" ? "finished" : s.status === "halted" ? `stopped before finishing (${s.reason})` : "stopped"}; its report follows in this conversation.` };
      const i = agentInfo(s), last = [...s.run.messages].reverse().find((m) => m.role === "assistant" && m.content);
      return { status: "done", text: `${s.alias} "${s.title}": ${i.status === "approval" ? "waiting for the user's approval" : i.status === "halted" ? `stopped before finishing (${s.reason})` : i.status}, ${plural(i.tokens, "token")} in ${Math.round(i.ms / 1000)}s` +
        (s.run.tool && i.status === "running" ? `, running ${s.run.tool.tc.function.name}` : "") + (last ? `\nLatest message: ${last.content.slice(-400)}` : "") +
        (i.status === "approval" ? `\nIt's waiting for the user to approve ${askedTool(s.run)}. That's the user's decision: don't stop it or do its work yourself. End your turn to wait; its report arrives here by itself.`
          : i.status === "running" ? (waited >= 5 ? `\nWaited ${waited}s: still working normally (${plural(i.tokens - tok0, "new token")}).` : "") +
            "\nIts report arrives here by itself when it finishes. Checking again doesn't speed it up (it shares the model with you): end your turn to wait." : "") };
    }
    if (s.status !== "running") return { status: "error", text: `ERROR: ${s.alias} has already finished (${s.status}); its report is in this conversation.` };
    if (name === "message_agent") {
      const text = String(args.text || args.message || "").trim();
      if (!text) return { status: "bad arguments", text: "ERROR: message_agent needs text." };
      steer(s.run, { text: `[Message from the main assistant] ${text}` });
      return { status: "done", text: `Sent to ${s.alias}; it sees the message after its current step.` };
    }
    // stop_agent. Not while it waits for the user's approval: the user answers that (or stops it), not the main assistant.
    if (s.run?.approval) return { status: "error", text: `ERROR: ${s.alias} is waiting for the user to approve ${askedTool(s.run)}. Only the user can answer or stop it. Don't do its work yourself: end your turn to wait; its report arrives here by itself.` };
    stop(s.run);
    return { status: "done", text: `Stopping ${s.alias}; its report (what it had done so far) will arrive here.` };
  }
  // A sub-agent ended: its last reply goes to the main reply as a report (or into the main session if that reply is over).
  async function finishSub(run) {
    const parent = run.parentRun, s = parent.subs.get(run.id);
    if (!s) return;
    // "halted": a guard (repeated calls, repetition) or an error ended it before it finished, so it wrote no real report.
    s.status = run.stopped ? "stopped" : run.endReason ? "halted" : "done"; s.tokens = run.genDone; s.end = Date.now();
    if (s.status === "halted") s.reason = run.endReason;
    await startNext(parent).catch((e) => console.error(`[run] ${parent.id} next sub-agent: ${e.message}`)); // its place goes to the next pending one
    await markTask(parent, s.title, s.status === "done" ? "done" : "pending");
    const cfg = agentsCfg(), mine = run.messages.slice(run.startLen), last = [...mine].reverse().find((m) => m.role === "assistant" && m.content);
    let report = (last?.content || "").trim();
    const words = report.split(/\s+/);
    if (words.length > cfg.reportWords * 1.2) report = words.slice(0, cfg.reportWords).join(" ") + ` …[report shortened to ${cfg.reportWords} words]`;
    const meta = { id: s.id, alias: s.alias, title: s.title, status: s.status, tokens: s.tokens, ms: s.end - s.t0, ...(s.reason ? { reason: s.reason } : {}) };
    let text;
    if (s.status === "halted") { // what it was doing when it ended, so the main assistant can check or redo it
      const one = (x, n) => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, n);
      const steps = [];
      for (const m of mine.filter((x) => x.role === "assistant" && x.tool_calls?.length).slice(-3))
        for (const tc of m.tool_calls) {
          const res = mine.find((x) => x.role === "tool" && x.tool_call_id === tc.id);
          steps.push(`- ${tc.function.name} ${one(tc.function.arguments, 200)} → ${res ? one(res.content, 200) : "(no result)"}`);
        }
      text = `[Sub-agent ${s.alias} "${s.title}" was stopped before finishing: ${s.reason}. It wrote no final report, so check its work yourself before relying on it.]` +
        (steps.length ? `\nIts last steps:\n${steps.reduce((out, x) => { const p = out[out.length - 1]; if (p && p.x === x) p.n++; else out.push({ x, n: 1 }); return out; }, []).map((p) => p.x + (p.n > 1 ? ` (${p.n} times)` : "")).join("\n")}` : "") + (report ? `\nIts last message: ${report}` : "");
    } else text = `[Sub-agent ${s.alias} "${s.title}" ${s.status === "stopped" ? "was stopped" : "finished"}. Its report:]\n${report || "(it wrote no report)"}`;
    if (runs.get(parent.id) === parent) { // also when the main reply was stopped: it adds the report before it ends
      parent.pending.push({ id: "rep-" + s.id, report: meta, text });
      relay(s);
      if (parent.wake) parent.wake();
    } else await updateChat(chatFile(parent.id), (disk) => (disk ? { ...disk, messages: [...(disk.messages || []), { role: "user", content: text, _agentReport: meta }], unread: true, updated: Date.now() } : null));
  }

  // tool_info for any tool this session offers: tools on request, tools already in the list, and tools of groups not
  // turned on yet (with how to turn them on). A group's name gives all its tools.
  const groupOf = (run, name) => [...run.deferred.values()].find((g) => !run.loaded.has(g.key) && g.tools.some((t) => t.function.name === name || t.function.name.endsWith("__" + name)));
  function toolInfo(run, args) {
    const pool = new Map(run.lazy);
    for (const t of run.tools) { const e = run.byName.get(t.function.name); if (e && !pool.has(e.name)) pool.set(e.name, e); }
    const off = new Map(); // tool name -> group still to turn on
    for (const g of run.deferred.values()) for (const t of g.tools) { const e = run.byName.get(t.function.name); if (e && !pool.has(e.name)) { pool.set(e.name, e); if (!run.loaded.has(g.key)) off.set(e.name, g.name); } }
    for (const n of ["tool_info", "call_tool", "enable_tools"]) pool.delete(n);
    let names = Array.isArray(args.names) ? args.names : String(args.names ?? args.name ?? "").split(/[,\s]+/);
    names = names.flatMap((n) => { // a group name: its tools
      const g = [...run.deferred.values()].find((x) => x.name.toLowerCase() === String(n).trim().toLowerCase());
      return g ? g.tools.map((t) => t.function.name) : [n];
    });
    const r = lazy.info(names, pool);
    const need = [...new Set(names.map((n) => lazy.resolve(n, pool).tool?.name).filter((n) => off.has(n)).map((n) => off.get(n)))];
    return { status: r.ok ? "done" : "error", text: r.text + (r.ok && need.length ? `\n\nTurn on first: ${need.map((g) => `enable_tools {"name": "${g}"}`).join(", ")}.` : "") };
  }

  async function callTool(run, tc) {
    let name = tc.function.name;
    let args;
    try { args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; }
    catch (e) { return { status: "bad arguments", text: `ERROR: arguments were not valid JSON (${e.message}). Call the tool again with valid JSON arguments.` }; }
    if (name === "enable_tools" && run.allowed.has(name)) return enableTools(run, args);
    if (name === "tool_info" && run.allowed.has(name)) return toolInfo(run, args);
    // A tool on request, through call_tool or (when the model skips that) called directly by its name.
    if ((name === "call_tool" && run.allowed.has(name)) || (!run.allowed.has(name) && run.lazy.size && !lazy.resolve(name, run.lazy).error)) {
      const viaCall = name === "call_tool", want = String((viaCall ? args.name : name) ?? "").trim();
      const listed = viaCall && run.allowed.has(want) && !["call_tool", "tool_info"].includes(want); // an ordinary tool, run through call_tool anyway
      // Resolved against the tools on request and the ordinary tools, so a guessed prefix ("agents__run_agent") still works.
      const pool = new Map(run.lazy);
      for (const t of run.tools) { const e = run.byName.get(t.function.name); if (e && !pool.has(e.name) && !["call_tool", "tool_info"].includes(e.name)) pool.set(e.name, e); }
      const r = listed ? { tool: { name: want } } : lazy.resolve(want, pool);
      if (r.error) {
        const g = groupOf(run, want);
        return { status: "error", text: g ? `ERROR: ${want} is in the "${g.name}" tool group, which isn't on yet. Call enable_tools {"name": "${g.name}"} first.` : "ERROR: " + r.error };
      }
      if (viaCall) { const a = lazy.innerArgs(args); if (a.error) return { status: "bad arguments", text: "ERROR: " + a.error }; args = a.value; }
      name = r.tool.name;
      if (!listed) run.used.add(name);
      if (name === "enable_tools") return enableTools(run, args);
    } else if (!run.allowed.has(name)) {
      const g = groupOf(run, name); // a tool from a group the model hasn't turned on yet: say how
      return { status: "error", text: g ? `ERROR: ${name} is in the "${g.name}" tool group, which isn't on yet. Call enable_tools {"name": "${g.name}"} first, then call it.` : `ERROR: the tool "${name}" is not available in this chat.` };
    }
    if (!isEnabled(name)) return { status: "error", text: `ERROR: the tool "${name}" is disabled in Settings > Tools.` };
    if (name === "ask_user") return askUser(run, tc, args);
    if (name === "todo") return todoTool(run, args);
    if (AGENT_TOOLS.has(name)) return run.parentRun ? { status: "error", text: "ERROR: a sub-agent can't use sub-agents." } : agentTool(run, name, tc, args);
    const spec = toolList().find((t) => t.name === name);
    if (spec && spec.approval) {
      let mode = "manual";
      try { mode = (await readChat(run.parentRun ? run.parentRun.id : run.id)).mode || "manual"; } catch {} // a sub-agent follows its main session
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
    const fixed = workspacePaths(run, name, callArgs);
    callArgs = fixed.args;
    const out = await runTool(name, callArgs);
    console.log(`[tool] ${name} ${JSON.stringify(args).slice(0, 200)} (${Date.now() - t0}ms)`);
    let text = String(out.text), images = out.images || [];
    if (fixed.moved.length) text += `\n(File names were taken as being in the workspace folder: ${fixed.moved.join(", ")}.)`;
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

  // MCP tools take relative file names against the server's own folder (its cwd, e.g. C:\mcp\aseprite-mcp), which the
  // model doesn't know about: it then reports paths in the workspace that don't exist. So a relative file name in an
  // MCP tool's arguments is made a full path in the session's workspace folder. Exception: a file that exists only in the
  // server's own folder (made there before this) is left alone, so older work there can still be opened.
  function workspacePaths(run, name, args) {
    const e = run.byName.get(name), moved = [];
    if (!e || !e.server || !args || typeof args !== "object" || Array.isArray(args)) return { args, moved };
    const base = filesDirOf(run.id), cwd = mcpCwd(e.server);
    if (!base) return { args, moved };
    const out = { ...args };
    for (const [k, v] of Object.entries(args)) {
      if (typeof v !== "string" || !/(file|path|output|dest|target|source|src|input)/i.test(k)) continue;
      const s = v.trim();
      if (!/^[^\n<>|?*"]+\.[A-Za-z0-9]{1,8}$/.test(s) || /^[A-Za-z][\w+.-]*:/.test(s) || path.isAbsolute(s) || /^[\\/]/.test(s)) continue; // a relative file name only
      const inWs = path.resolve(base, s);
      if (!fs.existsSync(inWs) && cwd && fs.existsSync(path.resolve(cwd, s))) continue;
      out[k] = inWs;
      moved.push(`${s} → ${inWs}`);
    }
    return { args: out, moved };
  }

  // Ends a reply that can't usefully go on: notes why on its last assistant message (shown with a Continue button).
  async function halt(run, text) {
    run.endReason = text.replace(/^Stopped: /, ""); // a sub-agent's report says why it ended
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
    const all = run.pending.splice(0), items = all.filter((i) => !i.report);
    for (const r of all.filter((i) => i.report)) { // a sub-agent's report: its own message, shown as a report card
      const m = { role: "user", content: r.text, _agentReport: r.report };
      run.messages.push(m);
      emit(run, { type: "agent_report", msg: m });
    }
    if (items.length) {
      const msg = { role: "user", content: items.map((i) => i.text).filter(Boolean).join("\n\n"), _steer: true };
      const imgs = items.flatMap((i) => i.images || []);
      if (imgs.length) msg._images = imgs;
      run.messages.push(msg);
      emit(run, { type: "steer_applied", ids: items.map((i) => i.id), msg, leftover });
    }
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
    if (run.wake) run.wake(); // waiting for sub-agents: a message wakes the reply up
    return item;
  }

  async function loop(run) {
    let lastSig = null, same = 0;
    try {
      for (let s = 0; !run.stopped; s++) {
        await waitForApproval(run);
        if (run.stopped) break;
        await applyPending(run);
        await maybeCompact(run);
        if (run.stopped) break;
        const r = await step(run);
        run.cur = null;
        if (r.retry) continue; // nothing kept from the unreadable attempt; the same step again
        // A step with only thinking (e.g. stopped mid-thought) is still saved, so the page closes it.
        if (r.failed || (!r.content && !r.toolCalls.length && !r.reasoning)) break;
        const msg = { role: "assistant", content: r.content, _meta: r.meta, _t0: r.t0, _at: Date.now() }; // step start/end: "Reasoned for 42s"
        if (r.usage) { msg._usage = { ...r.usage, model: run.model }; msg._ctxFrom = lastSummary(run.messages); } // exact counts from llama-server (context meter, compaction)
        if (r.reasoning) { msg._reasoning = r.reasoning; if (r.thinkSecs != null) msg._thinkSecs = r.thinkSecs; if (r.budgetHit) msg._budgetHit = true; }
        if (r.toolCalls.length) msg.tool_calls = r.toolCalls;
        run.messages.push(msg);
        emit(run, { type: "assistant", msg, tot: run.genDone });
        await save(run);
        if (r.looped) { run.endReason = "it kept repeating the same text"; emit(run, { type: "notice", text: "Stopped: the model kept repeating itself. Try again, or lower its temperature / add a presence penalty in its loadout (Settings > Loadouts)." }); break; }
        if (!r.toolCalls.length) {
          if (run.pending.length && !run.stopped) continue; // a steer arrived as it finished: keep going
          if (liveSubs(run) && !run.stopped) { if (await idle(run)) continue; } // sub-agents still working: wait for a report or a message
          if (!run.stopped && !liveSubs(run) && await todoNudge(run)) continue; // really ending: is its task list up to date?
          break;
        }
        const sig = [];
        for (const tc of r.toolCalls) { // every tool call needs a result, even if cancelled
          const res = run.stopped ? { status: "cancelled", text: "Cancelled by user." } : await callTool(run, tc);
          sig.push(tc.function.name, tc.function.arguments, res.text);
          // Sub-agents still working: every other tool result says so. Otherwise models take a file that already exists
          // (often left from an earlier attempt) as the sub-agent's finished work and report it before it's done.
          const busy = [...run.subs.values()].filter((x) => x.status === "running" || x.status === "pending");
          let real = tc.function.name;
          if (real === "call_tool") try { real = JSON.parse(tc.function.arguments || "{}").name || real; } catch {}
          const note = busy.length && !/(^|__)(run|check|message|stop)_agent$/i.test(real)
            ? `\n\n[${busy.map((x) => `${x.alias} "${x.title}"`).join(", ")} ${busy.length > 1 ? "are" : "is"} still running or pending. What ${busy.length > 1 ? "they make" : "it makes"} may not exist yet, and files with the same name may be left from an earlier attempt: don't use or show ${busy.length > 1 ? "their" : "its"} results until the report arrives here (end your turn to wait).]` : "";
          const tm = { role: "tool", tool_call_id: tc.id, content: res.text + note, _status: res.status, _at: Date.now() };
          if (res.images?.length) tm._images = res.images;
          if (res.answers) tm._answers = res.answers; // the card shows them when the session is opened again
          if (res.agent) tm._agent = res.agent; // run_agent: the chip for the sub-agent it started
          run.messages.push(tm);
          run.tool = null;
          emit(run, { type: "tool_result", msg: tm });
          await save(run);
        }
        // The same calls with the same arguments giving the same results, 3 steps in a row: it's stuck.
        const k = JSON.stringify(sig);
        same = k === lastSig ? same + 1 : 1; lastSig = k;
        if (same >= 3 && !run.stopped) { await halt(run, "Stopped: the same tool call gave the same result 3 times in a row"); break; }
        // Sub-agents running: the reply waits here for a report (or a message from the user) before its next step, rather
        // than working alongside them. Working alongside led models to poll, give up on, or redo the sub-agent's work,
        // and every request competes with the sub-agent for the same model anyway.
        if (liveSubs(run) && !run.stopped) await idle(run);
      }
    } catch (e) {
      console.error(`[run] ${run.id}: ${e.stack || e.message}`);
      run.endReason = "an error: " + e.message;
      emit(run, { type: "failed", text: "Error: " + e.message });
    } finally {
      run.cur = null; run.tool = null;
      for (const s of run.subs.values()) cancelPending(run, s, run.stopped ? "the reply was stopped" : "the reply ended");
      const stat = { tokens: run.genDone, ms: Date.now() - run.t0 }, sub = subTokens(run);
      if (sub) stat.sub = sub; // "(+N from sub-agents)"
      const last = run.messages.slice(run.startLen).reverse().find((m) => m.role === "assistant");
      if (last) last._run = stat; // "Generated N tokens in 3m 40s" under the reply when the session is opened again
      // Stopped with sub-agents still winding down (Stop stops them too): give them a moment, so their reports and the
      // chips' final state land in this reply instead of the chips staying "running" on the page.
      for (let i = 0; i < 50 && activeSubs(run); i++) await sleep(100);
      if (run.pending.length && !run.deleted) await applyPending(run, true).catch(() => {}); // stopped with steers pending: the page starts a new reply with them
      // Stopped by the user: its task list goes too (it described work that's no longer happening).
      const cleared = run.stopped && !run.parentRun && !run.deleted ? { todo: [] } : {};
      if (cleared.todo) emit(run, { type: "todo", items: [] });
      await save(run, null, { ...cleared, ...(run.clients.size ? {} : { unread: true }) }); // nobody watching: mark it for the sidebar
      runs.delete(run.id);
      emit(run, { type: "done", ...stat });
      for (const c of run.clients) c.end();
      console.log(`[run] ${run.id} finished${run.stopped ? " (stopped)" : ""}`);
      if (run.parentRun) finishSub(run).catch((e) => console.error(`[run] report ${run.id}: ${e.message}`));
    }
  }

  function stop(run) {
    if (!run) return;
    run.stopped = true;
    if (run.abort) run.abort.abort();
    if (run.stream) try { run.stream.cancel().catch(() => {}); } catch {} // a locked (being read) body throws: the loop's own check ends it
    if (run.approval) run.approval.resolve(false);
    if (run.question) run.question.resolve(null);
    for (const s of run.subs?.values() || []) if (s.status === "running") stop(s.run); else if (s.status === "pending") cancelPending(run, s, "the reply was stopped"); // the main reply's Stop stops its sub-agents
    if (run.wake) run.wake();
  }

  // Output cap per model call (Settings > Engine): reply tokens on top of the thinking budget. With no thinking cap
  // (Default / Max) it's 4x the reply tokens. 0 = no cap (max_tokens isn't sent).
  function outputCap(budget) {
    const reply = Number(getConfig().replyTokens) || 0;
    if (!reply) return undefined;
    return budget === 0 ? reply : budget > 0 ? budget + reply : reply * 4;
  }

  async function start(body, opts = {}) {
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
    // Tools on request (lazytools.js): large MCP servers are listed by name; details come from tool_info.
    const all = toolList(), byName = new Map(all.map((t) => [t.name, t]));
    const at = lazy.threshold(getConfig()), cost = lazy.serverTokens(all);
    const isLazy = (server) => at > 0 && (cost[server] || 0) >= at;
    const promoted = new Set(Array.isArray(chat.promoted) ? chat.promoted : []);
    const lazyPool = new Map();
    for (let i = tools.length - 1; i >= 0; i--) {
      const t = byName.get(tools[i].function.name);
      if (t && t.server && isLazy(t.server)) { lazyPool.set(t.name, t); tools.splice(i, 1); } // promoted ones are added back by setTools
    }
    // Groups on Auto stay listed (enable_tools) even after the model turned them on, and their tools are served through
    // call_tool, so the instructions and the tool list at the top of the prompt don't change and llama-server's prompt
    // cache stays valid. They move into the prompt itself only at compaction, which reads the prompt again anyway.
    const loaded = new Set(Array.isArray(chat.loaded) ? chat.loaded : []);
    const inPrompt = new Set(Array.isArray(chat.inPrompt) ? chat.inPrompt : []);
    // A group the model turned on counts as on only while the result that listed its tools is still in the conversation.
    // A Retry (or an edit) can drop that result; the group then stayed "already on" while the model had never seen its
    // tools' names, so it guessed them ("agents__create_agent"). Groups moved into the prompt at compaction stay on.
    let unloaded = false;
    for (const k of [...loaded]) {
      const g = deferred.get(k);
      if (!g || inPrompt.has(k)) continue;
      if (!(chat.messages || []).some((m) => m.role === "tool" && !m._partial && String(m.content || "").startsWith(`${g.name} is on.`))) { loaded.delete(k); unloaded = true; }
    }
    const listed = new Set([...lazyPool.keys()]); // tools named in the instructions' "Tools on request" section
    for (const g of deferred.values()) {
      g.lazy = g.key.startsWith("mcp:") && isLazy(g.name);
      if (!loaded.has(g.key)) continue;
      for (const s of g.tools) {
        const t = byName.get(s.function.name);
        if (!t) continue;
        lazyPool.set(t.name, { ...t, group: g.name });
        if (inPrompt.has(g.key)) listed.add(t.name);
      }
    }
    const budget = body.think?.budget;
    const run = {
      id, model: body.model, baseSystem: String(body.system || ""), system: "", baseTools: tools, tools: [], allowed: new Set(),
      vision: visionOf(body.model), imgCache: new Map(),
      lazy: lazyPool, promoted, listed, used: new Set(), byName, order: new Map(all.map((t, i) => [t.name, i])),
      viaCall: lazyPool.size > 0 || deferred.size > 0, // tool_info / call_tool are offered
      think: { body: body.think?.body || {}, budget: body.think?.budget ?? null, message: body.think?.message || "" },
      deferred, loaded,
      maxTokens: outputCap(budget),
      t0: Date.now(), genDone: 0, // for "N tokens in 1m 2s" under the reply
      messages: (chat.messages || []).filter((m) => !m._partial),
      startLen: (chat.messages || []).filter((m) => !m._partial).length,
      clients: new Set(), pending: [], cur: null, tool: null, approval: null, abort: null, stopped: false, deleted: false,
      body, parentRun: opts.parentRun || null, subs: new Map(), agentSeq: 0, wake: null, // sub-agents
    };
    setTools(run);
    setSystem(run);
    runs.set(id, run);
    if (unloaded) { emit(run, { type: "loaded", loaded: [...loaded] }); save(run, null, { loaded: [...loaded] }).catch(() => {}); }
    if (lazyPool.size) console.log(`[run] ${id} ${lazyPool.size - [...lazyPool.keys()].filter((n) => promoted.has(n)).length} tools on request (${[...new Set([...lazyPool.values()].map((t) => t.group || t.server))].join(", ")})`);
    console.log(`[run] ${id} started (${run.model}, ${run.tools.length} tools${deferred.size ? `, ${deferred.size} on Auto` : ""}${run.vision ? ", vision" : ""})`);
    loop(run);
    return run;
  }

  function watch(req, res, id) {
    const run = runs.get(id);
    if (!run) { res.writeHead(204); return res.end(); } // 204 tells EventSource not to reconnect
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const cur = run.cur && { ...run.cur, gen: run.cur.gen && { n: run.cur.gen.n, ms: Date.now() - run.cur.gen.t0, tool: run.cur.gen.tool } };
    const stat = { ms: Date.now() - run.t0, tokens: run.genDone + (run.cur?.gen?.total || 0), sub: subTokens(run) };
    const question = run.question && { id: run.question.id, tc: run.question.tc, questions: run.question.questions };
    const agents = [...run.subs.values()].filter((s) => s.status === "running" || s.status === "pending").map(agentInfo);
    res.write(`data: ${JSON.stringify({ type: "snapshot", messages: run.messages, cur, tool: run.tool, pending: run.pending.filter((p) => !p.report), stat, question, agents, waiting: run.waitWhy || !!run.wake })}\n\n`);
    run.clients.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 15000);
    req.on("close", () => { clearInterval(ping); run.clients.delete(res); });
  }

  // /api/runs routes.
  async function handle(req, res, { readBody, sendJson }) {
    const u = new URL(req.url, "http://x");
    const m = u.pathname.match(/^\/api\/runs(?:\/([^/]+)(?:\/(events|stop|approve|steer|answer))?)?$/);
    if (!m) return sendJson(res, 404, { error: "Not found" });
    const [, id, action] = m;
    try {
      if (!id && req.method === "GET") return sendJson(res, 200, { active: [...runs.keys()] });
      if (!id && req.method === "POST") { const run = await start(JSON.parse(await readBody(req))); return sendJson(res, 200, { ok: true, id: run.id }); }
      if (id && action === "events" && req.method === "GET") return watch(req, res, id);
      if (id && action === "stop" && req.method === "POST") { const p = !runs.get(id) && pendingSub(id); if (p) cancelPending(p[0], p[1], "the user cancelled it"); else stop(runs.get(id)); return sendJson(res, 200, { ok: true }); }
      if (id && action === "steer" && req.method === "POST") {
        const run = runs.get(id);
        if (!run || run.stopped) return sendJson(res, 409, { error: "No reply in progress" }); // the page sends it as a normal message
        return sendJson(res, 200, { ok: true, id: steer(run, JSON.parse(await readBody(req))).id });
      }
      if (id && action === "answer" && req.method === "POST") { // {id, answers: [{choices: [labels], other}]} or {id, text}
        const b = JSON.parse(await readBody(req)), run = runs.get(id);
        if (!run || !run.question || run.question.id !== b.id) return sendJson(res, 409, { error: "No question waiting" });
        const a = b.text ? { text: String(b.text).trim() } : { answers: (Array.isArray(b.answers) ? b.answers : []).map((x) => ({
          choices: (Array.isArray(x?.choices) ? x.choices : []).map(String), other: x?.other ? String(x.other).trim() : "" })) };
        run.question.resolve(a);
        return sendJson(res, 200, { ok: true });
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
    waiting: (id) => { const r = runs.get(id); return r?.approval || [...(r?.subs?.values() || [])].some((s) => s.status === "running" && s.run?.approval) ? "approval" : r?.question ? "question" : false; }, // the sidebar's yellow dot
    stop: (id) => { const p = !runs.get(id) && pendingSub(id); if (p) cancelPending(p[0], p[1], "the user cancelled it"); else stop(runs.get(id)); },
    deleted: (id) => { const r = runs.get(id); if (r) { r.deleted = true; stop(r); } },
    modeChanged: (id, mode) => {
      const r = runs.get(id);
      if (mode !== "auto" || !r) return;
      if (r.approval) r.approval.resolve(true);
      for (const s of r.subs.values()) if (s.status === "running" && s.run?.approval) s.run?.approval.resolve(true); // sub-agents follow the main session
    },
  };
};
