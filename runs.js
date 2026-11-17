// Server-side agent runs. The loop (model -> tool calls -> model ...) lives here, not in the browser, so a reply
// keeps going when the user switches chats, opens Settings, reloads or closes the tab. Progress is saved to the
// chat file as it streams; any number of pages can watch a run through an event stream and stop it.
const fs = require("fs");
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

module.exports = function createRuns({ llama, runTool, toolList, isEnabled, chatFile, updateChat, statusOf, visionOf, loadImage, imagePathsIn, uploadPath, getConfig, nCtx, nSlots = async () => null, samplingFor = () => ({}), ensureEngine = async () => {}, newSession = null }) {
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
    } finally { run.abort = null; run.cur = null; }
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
    let think0 = null, think1 = null, timings = null, failed = false, gotChunk = false, lastSave = Date.now();
    let looped = false, finish = null, checkedAt = 0, usage = null, ppTotal = 0, changed = null, cached = null;
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
      if (run.slot === undefined) run.slot = await pickSlot(run);
      if (run.slot !== undefined) body.id_slot = run.slot;
      changed = promptChange(run, body);
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
      if (!run.stopped && !looped) {
        failed = true;
        emit(run, { type: "failed", text: (cur.content ? cur.content + "\n\n" : "") + "Error: " + (e.cause?.code === "ECONNREFUSED" ? `Cannot reach llama-server at ${llama.url()}` : e.message) });
      }
    } finally {
      polling = false;
      run.abort = null;
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
    return { content: cur.content, reasoning: cur.reasoning, toolCalls: looped ? [] : toolCalls, usage, meta, failed, thinkSecs, budgetHit, looped, t0 };
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
    if (run.loaded.has(g.key)) return { status: "done", text: `${g.name} is already on. Run its tools with call_tool (tool_info gives their parameters).` };
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
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  function agentInfo(s) {
    const r = s.run, live = s.status === "running", asking = live && r.tool?.status === "approval"; // (set just before the approval wait begins)
    return { id: s.id, alias: s.alias, title: s.title, status: live ? (asking ? "approval" : "running") : s.status,
      tokens: live ? r.genDone + (r.cur?.gen?.total || 0) : s.tokens, ms: (s.end || Date.now()) - s.t0, tc: asking ? r.tool.tc : null };
  }
  const relay = (s) => { s.relayAt = Date.now(); if (runs.get(s.run.parentRun.id) === s.run.parentRun) emit(s.run.parentRun, { type: "agent", ...agentInfo(s) }); };
  function onSubEvent(run, ev) { // the main session's chip follows the sub-agent: approvals right away, progress about once a second
    const s = run.parentRun.subs.get(run.id);
    if (!s || s.status !== "running") return;
    if (ev.type === "tool" || ev.type === "step" || ((ev.type === "delta" || ev.type === "assistant") && Date.now() - (s.relayAt || 0) > 1000)) relay(s);
  }
  function findSub(run, key) {
    const k = String(key || "").trim().toLowerCase();
    return [...run.subs.values()].find((s) => s.id === k || s.alias === k) || [...run.subs.values()].find((s) => s.title.toLowerCase() === k);
  }
  // Waits (no model calls) until a report or a message arrives, the sub-agents finish, or Stop. Returns true to go on.
  async function idle(run) {
    emit(run, { type: "waiting", on: true });
    await new Promise((resolve) => { run.wake = resolve; if (run.pending.length || !activeSubs(run) || run.stopped) resolve(); });
    run.wake = null;
    emit(run, { type: "waiting", on: false });
    return !run.stopped && run.pending.length > 0;
  }
  async function agentTool(run, name, tc, args) {
    if (name === "run_agent") {
      const title = String(args.title || args.name || "").trim().slice(0, 60) || "Sub-agent", task = String(args.task || args.instructions || args.prompt || "").trim();
      if (!task) return { status: "bad arguments", text: "ERROR: run_agent needs task: the full instructions for the sub-agent (it doesn't see this conversation)." };
      const cfg = agentsCfg(), slots = await nSlots(run.model).catch(() => null);
      const max = slots && slots > 1 ? Math.min(cfg.maxActive, slots - 1) : cfg.maxActive, active = activeSubs(run);
      if (active >= max) return { status: "error", text: `ERROR: only ${plural(max, "sub-agent")} can run at a time and ${active} ${active === 1 ? "is" : "are"} running. Their reports arrive here automatically; wait for them (end your turn), or stop one with stop_agent.` };
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
      const s = { id, alias: "a" + ++run.agentSeq, title, status: "running", t0: Date.now(), tokens: 0, run: null };
      s.run = await start(body, { parentRun: run });
      run.subs.set(id, s);
      relay(s);
      console.log(`[run] ${run.id} started sub-agent ${s.alias} (${id}): ${title}`);
      return { status: "done", agent: { id, alias: s.alias, title },
        text: `Started sub-agent ${s.alias} ("${title}"). Its report will arrive in this conversation by itself when it finishes, so you don't need to check on it. Keep working on something else, or end your turn to wait. You can send it a message with message_agent or stop it with stop_agent.` };
    }
    const s = findSub(run, args.id ?? args.agent ?? args.name);
    if (!s) return { status: "error", text: `ERROR: no sub-agent "${args.id ?? ""}". Sub-agents in this reply: ${[...run.subs.values()].map((x) => `${x.alias} (${x.title}, ${x.status})`).join(", ") || "none"}.` };
    if (name === "check_agent") {
      const i = agentInfo(s), last = [...s.run.messages].reverse().find((m) => m.role === "assistant" && m.content);
      return { status: "done", text: `${s.alias} "${s.title}": ${i.status === "approval" ? "waiting for the user's approval" : i.status}, ${plural(i.tokens, "token")} in ${Math.round(i.ms / 1000)}s` +
        (s.run.tool && i.status === "running" ? `, running ${s.run.tool.tc.function.name}` : "") + (last ? `\nLatest message: ${last.content.slice(-400)}` : "") +
        (i.status === "running" || i.status === "approval" ? "\n(Its report arrives here by itself when it finishes.)" : "") };
    }
    if (s.status !== "running") return { status: "error", text: `ERROR: ${s.alias} has already finished (${s.status}); its report is in this conversation.` };
    if (name === "message_agent") {
      const text = String(args.text || args.message || "").trim();
      if (!text) return { status: "bad arguments", text: "ERROR: message_agent needs text." };
      steer(s.run, { text: `[Message from the main assistant] ${text}` });
      return { status: "done", text: `Sent to ${s.alias}; it sees the message after its current step.` };
    }
    stop(s.run); // stop_agent
    return { status: "done", text: `Stopping ${s.alias}; its report (what it had done so far) will arrive here.` };
  }
  // A sub-agent ended: its last reply goes to the main reply as a report (or into the main session if that reply is over).
  async function finishSub(run) {
    const parent = run.parentRun, s = parent.subs.get(run.id);
    if (!s) return;
    s.status = run.stopped ? "stopped" : "done"; s.tokens = run.genDone; s.end = Date.now();
    const cfg = agentsCfg(), last = run.messages.slice(run.startLen).reverse().find((m) => m.role === "assistant" && m.content);
    let report = (last?.content || "").trim();
    const words = report.split(/\s+/);
    if (words.length > cfg.reportWords * 1.2) report = words.slice(0, cfg.reportWords).join(" ") + ` …[report shortened to ${cfg.reportWords} words]`;
    const meta = { id: s.id, alias: s.alias, title: s.title, status: s.status, tokens: s.tokens, ms: s.end - s.t0 };
    const text = `[Sub-agent ${s.alias} "${s.title}" ${s.status === "stopped" ? "was stopped" : "finished"}. Its report:]\n${report || "(it wrote no report)"}`;
    if (runs.get(parent.id) === parent && !parent.stopped) {
      parent.pending.push({ id: "rep-" + s.id, report: meta, text });
      relay(s);
      if (parent.wake) parent.wake();
    } else await updateChat(chatFile(parent.id), (disk) => (disk ? { ...disk, messages: [...(disk.messages || []), { role: "user", content: text, _agentReport: meta }], unread: true, updated: Date.now() } : null));
  }

  async function callTool(run, tc) {
    let name = tc.function.name;
    let args;
    try { args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; }
    catch (e) { return { status: "bad arguments", text: `ERROR: arguments were not valid JSON (${e.message}). Call the tool again with valid JSON arguments.` }; }
    if (name === "enable_tools" && run.allowed.has(name)) return enableTools(run, args);
    if (name === "tool_info" && run.allowed.has(name)) { const r = lazy.info(args.names ?? args.name, run.lazy); return { status: r.ok ? "done" : "error", text: r.text }; }
    // A tool on request, through call_tool or (when the model skips that) called directly by its name.
    if ((name === "call_tool" && run.allowed.has(name)) || (!run.allowed.has(name) && run.lazy.size && !lazy.resolve(name, run.lazy).error)) {
      const viaCall = name === "call_tool";
      const r = lazy.resolve(viaCall ? args.name : name, run.lazy);
      if (r.error) return { status: "error", text: "ERROR: " + r.error };
      if (viaCall) { const a = lazy.innerArgs(args); if (a.error) return { status: "bad arguments", text: "ERROR: " + a.error }; args = a.value; }
      name = r.tool.name;
      run.used.add(name);
    } else if (!run.allowed.has(name)) return { status: "error", text: `ERROR: the tool "${name}" is not available in this chat.` };
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
        await applyPending(run);
        await maybeCompact(run);
        if (run.stopped) break;
        const r = await step(run);
        run.cur = null;
        // A step with only thinking (e.g. stopped mid-thought) is still saved, so the page closes it.
        if (r.failed || (!r.content && !r.toolCalls.length && !r.reasoning)) break;
        const msg = { role: "assistant", content: r.content, _meta: r.meta, _t0: r.t0, _at: Date.now() }; // step start/end: "Reasoned for 42s"
        if (r.usage) { msg._usage = { ...r.usage, model: run.model }; msg._ctxFrom = lastSummary(run.messages); } // exact counts from llama-server (context meter, compaction)
        if (r.reasoning) { msg._reasoning = r.reasoning; if (r.thinkSecs != null) msg._thinkSecs = r.thinkSecs; if (r.budgetHit) msg._budgetHit = true; }
        if (r.toolCalls.length) msg.tool_calls = r.toolCalls;
        run.messages.push(msg);
        emit(run, { type: "assistant", msg, tot: run.genDone });
        await save(run);
        if (r.looped) { emit(run, { type: "notice", text: "Stopped: the model kept repeating itself. Try again, or lower its temperature / add a presence penalty for this model in models.ini." }); break; }
        if (!r.toolCalls.length) {
          if (run.pending.length && !run.stopped) continue; // a steer arrived as it finished: keep going
          if (activeSubs(run) && !run.stopped) { if (await idle(run)) continue; } // sub-agents still working: wait for a report or a message
          break;
        }
        const sig = [];
        for (const tc of r.toolCalls) { // every tool call needs a result, even if cancelled
          const res = run.stopped ? { status: "cancelled", text: "Cancelled by user." } : await callTool(run, tc);
          sig.push(tc.function.name, tc.function.arguments, res.text);
          const tm = { role: "tool", tool_call_id: tc.id, content: res.text, _status: res.status, _at: Date.now() };
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
      }
    } catch (e) {
      console.error(`[run] ${run.id}: ${e.stack || e.message}`);
      emit(run, { type: "failed", text: "Error: " + e.message });
    } finally {
      run.cur = null; run.tool = null;
      const stat = { tokens: run.genDone, ms: Date.now() - run.t0 };
      const last = run.messages.slice(run.startLen).reverse().find((m) => m.role === "assistant");
      if (last) last._run = stat; // "Generated N tokens in 3m 40s" under the reply when the session is opened again
      if (run.pending.length && !run.deleted) await applyPending(run, true).catch(() => {}); // stopped with steers pending: the page starts a new reply with them
      await save(run, null, run.clients.size ? {} : { unread: true }); // nobody watching: mark it for the sidebar
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
    if (run.approval) run.approval.resolve(false);
    if (run.question) run.question.resolve(null);
    for (const s of run.subs?.values() || []) if (s.status === "running") stop(s.run); // the main reply's Stop stops its sub-agents
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
    const stat = { ms: Date.now() - run.t0, tokens: run.genDone + (run.cur?.gen?.total || 0) };
    const question = run.question && { id: run.question.id, tc: run.question.tc, questions: run.question.questions };
    const agents = [...run.subs.values()].filter((s) => s.status === "running").map(agentInfo);
    res.write(`data: ${JSON.stringify({ type: "snapshot", messages: run.messages, cur, tool: run.tool, pending: run.pending.filter((p) => !p.report), stat, question, agents, waiting: !!run.wake })}\n\n`);
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
      if (id && action === "stop" && req.method === "POST") { stop(runs.get(id)); return sendJson(res, 200, { ok: true }); }
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
    waiting: (id) => { const r = runs.get(id); return r?.approval || [...(r?.subs?.values() || [])].some((s) => s.status === "running" && s.run.approval) ? "approval" : r?.question ? "question" : false; }, // the sidebar's yellow dot
    stop: (id) => stop(runs.get(id)),
    deleted: (id) => { const r = runs.get(id); if (r) { r.deleted = true; stop(r); } },
    modeChanged: (id, mode) => {
      const r = runs.get(id);
      if (mode !== "auto" || !r) return;
      if (r.approval) r.approval.resolve(true);
      for (const s of r.subs.values()) if (s.status === "running" && s.run.approval) s.run.approval.resolve(true); // sub-agents follow the main session
    },
  };
};
