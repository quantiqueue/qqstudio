// Server-side agent runs. The loop (model -> tool calls -> model ...) lives here, not in the browser, so a reply
// keeps going when the user switches chats, opens Settings, reloads or closes the tab. Progress is saved to the
// chat file as it streams; any number of pages can watch a run through an event stream and stop it.
const fs = require("fs");

const MAX_STEPS = 25;
const MAX_IMAGES = 4; // most recent images re-sent to a vision model on each step; older ones become a short note
const SAVE_EVERY_MS = 1500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripUi = (m) => Object.fromEntries(Object.entries(m).filter(([k]) => !k.startsWith("_")));

module.exports = function createRuns({ llama, runTool, toolList, isEnabled, chatFile, updateChat, statusOf, visionOf, loadImage, imagePathsIn, uploadPath }) {
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

  async function step(run) {
    const { model } = run;
    const cur = run.cur = { model, content: "", reasoning: "", phase: "Sending request", pct: null };
    const t0 = Date.now();
    let think0 = null, think1 = null, timings = null, failed = false, gotChunk = false, lastSave = Date.now();
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
      const body = {
        model, messages: [{ role: "system", content: run.system }, ...(await modelMessages(run))],
        return_progress: true, stream_options: { include_usage: true }, ...run.think.body, stream: true,
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
          if (j.usage) emit(run, { type: "usage", prompt: j.usage.prompt_tokens, completion: j.usage.completion_tokens, model });
          if (!gotChunk) { gotChunk = true; polling = false; if (!cur.content) phase("Reading prompt"); }
          const pp = j.prompt_progress;
          if (pp && pp.total && !cur.content && !cur.reasoning) {
            const done = Math.max(0, pp.processed - (pp.cache || 0)), todo = Math.max(1, pp.total - (pp.cache || 0));
            phase(`Reading prompt · ${pp.processed}/${pp.total} tokens`, Math.min(100, Math.round((done / todo) * 100)));
          }
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
      if (!run.stopped) {
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
      (run.stopped ? " · stopped" : "");
    const thinkSecs = think0 === null ? null : +(((think1 ?? Date.now()) - think0) / 1000).toFixed(1);
    const tb = run.think.budget, note = (run.think.message || "").trim();
    const budgetHit = !!(cur.reasoning && tb > 0 && (cur.reasoning.length / 3.6 >= tb * 0.9 || (note && cur.reasoning.trim().endsWith(note))));
    return { content: cur.content, reasoning: cur.reasoning, toolCalls, meta, failed, thinkSecs, budgetHit };
  }

  async function callTool(run, tc) {
    const name = tc.function.name;
    let args;
    try { args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; }
    catch (e) { return { status: "bad arguments", text: `ERROR: arguments were not valid JSON (${e.message}). Call the tool again with valid JSON arguments.` }; }
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
    const out = await runTool(name, args);
    console.log(`[tool] ${name} ${JSON.stringify(args).slice(0, 200)} (${Date.now() - t0}ms)`);
    let text = String(out.text), images = out.images || [];
    const failed = text.startsWith("ERROR");
    // MCP tools that write an image (e.g. Aseprite export_frame) only return its path: pick it up so it's shown and seen.
    if (!failed && !images.length && name.includes("__")) images = imagePathsIn(text);
    if (run.vision && images.length && !failed) text += `\n(${images.length > 1 ? "These images are" : "This image is"} attached to the conversation so you can see ${images.length > 1 ? "them" : "it"}.)`;
    return { status: failed ? "error" : "done", text, images };
  }

  async function loop(run) {
    try {
      for (let s = 0; s < MAX_STEPS && !run.stopped; s++) {
        const r = await step(run);
        run.cur = null;
        if (r.failed || (!r.content && !r.toolCalls.length)) break;
        const msg = { role: "assistant", content: r.content, _meta: r.meta };
        if (r.reasoning) { msg._reasoning = r.reasoning; if (r.thinkSecs != null) msg._thinkSecs = r.thinkSecs; if (r.budgetHit) msg._budgetHit = true; }
        if (r.toolCalls.length) msg.tool_calls = r.toolCalls;
        run.messages.push(msg);
        emit(run, { type: "assistant", msg });
        await save(run);
        if (!r.toolCalls.length) break;
        for (const tc of r.toolCalls) { // every tool call needs a result, even if cancelled
          const res = run.stopped ? { status: "cancelled", text: "Cancelled by user." } : await callTool(run, tc);
          const tm = { role: "tool", tool_call_id: tc.id, content: res.text, _status: res.status };
          if (res.images?.length) tm._images = res.images;
          run.messages.push(tm);
          run.tool = null;
          emit(run, { type: "tool_result", msg: tm });
          await save(run);
        }
        if (s === MAX_STEPS - 1) emit(run, { type: "notice", text: `Stopped after ${MAX_STEPS} steps.` });
      }
    } catch (e) {
      console.error(`[run] ${run.id}: ${e.stack || e.message}`);
      emit(run, { type: "failed", text: "Error: " + e.message });
    } finally {
      run.cur = null; run.tool = null;
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

  async function start(body) {
    const id = body.chatId;
    if (!id || !chatFile(id)) throw Object.assign(new Error("Bad chat id"), { status: 400 });
    if (runs.has(id)) throw Object.assign(new Error("This chat already has a reply in progress."), { status: 409 });
    let chat;
    try { chat = await readChat(id); } catch { throw Object.assign(new Error("Chat not found (save it first)"), { status: 404 }); }
    if (!body.model) throw Object.assign(new Error("No model selected"), { status: 400 });
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const run = {
      id, model: body.model, system: String(body.system || ""), tools, vision: visionOf(body.model), imgCache: new Map(),
      allowed: new Set(tools.map((t) => t && t.function && t.function.name).filter(Boolean)),
      think: { body: body.think?.body || {}, budget: body.think?.budget ?? null, message: body.think?.message || "" },
      messages: (chat.messages || []).filter((m) => !m._partial),
      clients: new Set(), cur: null, tool: null, approval: null, abort: null, stopped: false, deleted: false,
    };
    runs.set(id, run);
    console.log(`[run] ${id} started (${run.model}, ${tools.length} tools${run.vision ? ", vision" : ""})`);
    loop(run);
    return run;
  }

  function watch(req, res, id) {
    const run = runs.get(id);
    if (!run) { res.writeHead(204); return res.end(); } // 204 tells EventSource not to reconnect
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`data: ${JSON.stringify({ type: "snapshot", messages: run.messages, cur: run.cur, tool: run.tool })}\n\n`);
    run.clients.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 15000);
    req.on("close", () => { clearInterval(ping); run.clients.delete(res); });
  }

  // /api/runs routes.
  async function handle(req, res, { readBody, sendJson }) {
    const u = new URL(req.url, "http://x");
    const m = u.pathname.match(/^\/api\/runs(?:\/([^/]+)(?:\/(events|stop|approve))?)?$/);
    if (!m) return sendJson(res, 404, { error: "Not found" });
    const [, id, action] = m;
    try {
      if (!id && req.method === "GET") return sendJson(res, 200, { active: [...runs.keys()] });
      if (!id && req.method === "POST") { const run = await start(JSON.parse(await readBody(req))); return sendJson(res, 200, { ok: true, id: run.id }); }
      if (id && action === "events" && req.method === "GET") return watch(req, res, id);
      if (id && action === "stop" && req.method === "POST") { stop(runs.get(id)); return sendJson(res, 200, { ok: true }); }
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
    waiting: (id) => !!runs.get(id)?.approval,
    stop: (id) => stop(runs.get(id)),
    deleted: (id) => { const r = runs.get(id); if (r) { r.deleted = true; stop(r); } },
    modeChanged: (id, mode) => { const r = runs.get(id); if (mode === "auto" && r && r.approval) r.approval.resolve(true); },
  };
};
