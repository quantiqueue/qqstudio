// CI: qqstudio run against a strict fake OpenAI-compatible endpoint (no model needed). Checks the request it sends
// (key, model, only standard fields), a task done with task_complete (--json, --logs, the file written in --cwd),
// a task that never calls task_complete (exit 3), a 429 retried, a wrong key (exit 1), and, off Windows, SIGTERM
// during a wait (exit 2 with the transcript saved). Run from the repo root: node .github/scripts/headless-test.js
"use strict";
const http = require("http"), fs = require("fs"), os = require("os"), path = require("path"), { spawn } = require("child_process");

const KEY = "sk-ci-test";
const STANDARD = new Set(["model", "messages", "tools", "tool_choice", "stream", "stream_options", "max_tokens", "temperature", "top_p", "presence_penalty", "frequency_penalty", "seed", "stop", "reasoning_effort"]);
const seen = []; // every chat request: { kw, model, bad, effort, maxTokens }
let rateHits = 0;

const plans = {
  DONE: [["write_file", { path: "hello.txt", content: "hello from ci" }], ["read_file", { path: "hello.txt" }], ["task_complete", { summary: "Wrote hello.txt and read it back." }]],
  WAIT: [["run_background", { command: `node -e "setTimeout(() => {}, 60000)"` }], ["check_background", { id: "bg1", wait: 300 }]],
};
const server = http.createServer((req, res) => {
  let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
    if (req.url !== "/v1/chat/completions") { res.writeHead(404); return res.end("not found"); }
    if (req.headers.authorization !== "Bearer " + KEY) { res.writeHead(401, { "Content-Type": "application/json" }); return res.end('{"error":{"message":"bad key"}}'); }
    const j = JSON.parse(b || "{}"), msgs = j.messages || [];
    const kw = (String((msgs.find((m) => m.role === "user") || {}).content || "").match(/[A-Z]{3,}/) || ["?"])[0];
    const bad = Object.keys(j).filter((k) => !STANDARD.has(k));
    if (j.stream) seen.push({ kw, model: j.model, bad, effort: j.reasoning_effort, maxTokens: j.max_tokens, usage: !!(j.stream_options && j.stream_options.include_usage) });
    if (bad.length) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: { message: "unknown fields: " + bad.join(", ") } })); }
    if (kw === "RATE" && rateHits++ === 0) { res.writeHead(429, { "Retry-After": "1" }); return res.end("slow down"); }
    if (!j.stream) { res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify({ choices: [{ message: { content: "Title" } }] })); }
    const step = msgs.filter((m) => m.role === "assistant").length;
    const plan = (plans[kw === "RATE" ? "DONE" : kw] || [])[step];
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (d) => res.write("data: " + JSON.stringify(d) + "\n\n");
    send({ choices: [{ delta: { reasoning: "Thinking. " } }] });
    if (plan) {
      const args = JSON.stringify(plan[1]), half = Math.floor(args.length / 2);
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c" + step, type: "function", function: { name: plan[0], arguments: args.slice(0, half) } }] } }] });
      send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(half) } }] } }] });
      send({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
    } else { send({ choices: [{ delta: { content: "Some progress." } }] }); send({ choices: [{ delta: {}, finish_reason: "stop" }] }); }
    send({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } });
    res.end("data: [DONE]\n\n");
  });
});

let failed = 0;
const check = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) failed++; };

function run(args, { key = KEY, signalAfter = 0 } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "qqrun-ci-"));
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.resolve("bin/qqstudio.js"), "run", ...args], { cwd, env: { ...process.env, QQSTUDIO_API_KEY: key, OPENAI_API_KEY: "" } });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    const kill = setTimeout(() => p.kill("SIGKILL"), 90000);
    if (signalAfter) setTimeout(() => p.kill("SIGTERM"), signalAfter);
    p.on("close", (code) => { clearTimeout(kill); resolve({ code, out, err, cwd }); });
  });
}

server.listen(0, "127.0.0.1", async () => {
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  const logs = fs.mkdtempSync(path.join(os.tmpdir(), "qqrun-ci-logs-"));
  try {
    // A task done with task_complete
    let r = await run(["--base-url", base, "--model", "ci/model", "--effort", "high", "--json", "--logs", logs, "--no-web", "--", "DONE write a file"]);
    const evs = r.out.trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
    const done = evs.find((e) => e.type === "done") || {};
    check(r.code === 0, `done: exit 0 (got ${r.code})${r.code ? "\n" + r.err : ""}`);
    check(done.reason === "complete" && /hello\.txt/.test(done.summary || ""), "done: --json ends with reason complete and the summary");
    check(fs.existsSync(path.join(r.cwd, "hello.txt")) && fs.readFileSync(path.join(r.cwd, "hello.txt"), "utf8") === "hello from ci", "done: hello.txt written in the task folder");
    check(["session.json", "events.jsonl", "qqstudio.log"].every((f) => fs.existsSync(path.join(logs, f))), "done: --logs has session.json, events.jsonl, qqstudio.log");
    const sess = JSON.parse(fs.readFileSync(path.join(logs, "session.json"), "utf8"));
    check(sess.messages.some((m) => m._complete), "done: the transcript ends with task_complete");
    check(sess.messages.some((m) => m._reasoning === "Thinking. "), "done: thinking sent as \"reasoning\" is kept");
    const reqs = seen.filter((s) => s.kw === "DONE");
    check(reqs.length === 3 && reqs.every((s) => s.model === "ci/model" && !s.bad.length && s.effort === "high" && s.usage && s.maxTokens === undefined),
      "done: every request has the model, effort high, usage asked, no max_tokens, no extra fields " + JSON.stringify(reqs[0] || {}));
    check(!(evs.find((e) => e.type === "start") || { tools: [] }).tools.some((t) => /web|fetch|download|http_request|ask_user/.test(t)), "done: --no-web and no ask_user in the tools");

    // A model that never calls task_complete
    r = await run(["--base-url", base, "--model", "m", "--", "TEXT only talk"]);
    check(r.code === 3, `no task_complete: exit 3 after the nudges (got ${r.code})`);
    check(seen.filter((s) => s.kw === "TEXT").length === 3, "no task_complete: 3 requests (2 nudges)");

    // A rate limit, retried
    r = await run(["--base-url", base, "--model", "m", "--reply-tokens", "500", "--", "RATE limited"]);
    check(r.code === 0, `429: retried, then done (got ${r.code})`);
    check(seen.filter((s) => s.kw === "RATE").every((s) => s.maxTokens === 500), "429: --reply-tokens sent as max_tokens");

    // A wrong key
    r = await run(["--base-url", base, "--model", "m", "--", "DONE x"], { key: "nope" });
    check(r.code === 1 && /401/.test(r.err), `wrong key: exit 1 with HTTP 401 (got ${r.code})`);

    // SIGTERM during a wait (Windows has no SIGTERM to catch: a kill there ends the process at once)
    if (process.platform !== "win32") {
      const L2 = fs.mkdtempSync(path.join(os.tmpdir(), "qqrun-ci-logs-"));
      r = await run(["--base-url", base, "--model", "m", "--logs", L2, "--", "WAIT for it"], { signalAfter: 5000 });
      check(r.code === 2, `SIGTERM: exit 2 (got ${r.code})`);
      check(fs.existsSync(path.join(L2, "session.json")), "SIGTERM: the transcript was saved");
    }
  } catch (e) { check(false, "the test itself: " + (e.stack || e.message)); }
  server.close();
  console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
  process.exit(failed ? 1 : 0);
});
