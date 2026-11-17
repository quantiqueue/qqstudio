// Tools on request: an MCP server whose tool definitions are large (e.g. Aseprite: 116 tools, ~25k tokens) isn't sent
// in full. The model gets a compact list (name + first line of each description) and two fixed tools: tool_info returns
// the full details of the tools it names, call_tool runs one. The tool list sent with every request then stays small
// and doesn't change when a server is turned on, so llama-server's prompt cache stays valid.
const DEFAULT_AT = 3000; // tokens; a server at or above this is "on request" (0 = always send full details)

const estTokens = (x) => Math.ceil(JSON.stringify(x).length / 3.5);
// Estimated tokens of each server's enabled tools, from toolList() entries.
function serverTokens(list) {
  const out = {};
  for (const t of list) if (t.server && t.enabled) out[t.server] = (out[t.server] || 0) + estTokens(t.spec);
  return out;
}
function threshold(cfg) {
  const v = cfg && cfg.lazyToolsAt;
  return v === undefined || v === null ? DEFAULT_AT : Math.max(0, Math.round(Number(v)) || 0);
}

const shortName = (t) => (t.server && t.name.startsWith(t.server + "__") ? t.name.slice(t.server.length + 2) : t.name);
function firstLine(desc) {
  const s = String(desc || "").trim().split(/\n/)[0];
  const m = s.match(/^.+?[.!?](?=\s|$)/);
  let out = (m ? m[0] : s).replace(/\.$/, "");
  if (out.length > 90) out = out.slice(0, 87).replace(/\s+\S*$/, "") + "…";
  return out;
}
// "## aseprite (116 tools, names start with "aseprite__")\n- create_canvas: Create a new sprite\n…"
// label: the MCP server, or the built-in category (e.g. "System") for a group the model turned on.
function compactList(label, tools) {
  const server = tools[0] && tools[0].server;
  return `## ${label} (${tools.length} tool${tools.length === 1 ? "" : "s"}${server ? `, names start with "${server}__"` : ""})\n` +
    tools.map((t) => `- ${shortName(t)}${t.description ? ": " + firstLine(t.description) : ""}`).join("\n");
}
const HOW = "These tools are listed by name only. Before using one for the first time, call tool_info with the tool names you need " +
  "to get their parameters, then call call_tool with the tool's name and its arguments.";
// The section added to the instructions for the given on-request tools (toolList() entries), grouped by server.
function section(tools) {
  if (!tools.length) return "";
  const by = new Map();
  for (const t of tools) { const k = t.group || t.server || t.category; if (!by.has(k)) by.set(k, []); by.get(k).push(t); }
  return `\n\nTools on request. ${HOW}\n\n` + [...by].map(([s, ts]) => compactList(s, ts)).join("\n\n");
}

const INFO_SPEC = { type: "function", function: {
  name: "tool_info",
  description: "Get the full description and parameters of tools listed under \"Tools on request\". Ask for several at once.",
  parameters: { type: "object", properties: { names: { type: "array", items: { type: "string" }, description: "Tool names, e.g. [\"aseprite__draw_pixels\"]" } }, required: ["names"] },
} };
const CALL_SPEC = { type: "function", function: {
  name: "call_tool",
  description: "Run a tool listed under \"Tools on request\". Get its parameters with tool_info first.",
  parameters: { type: "object", properties: {
    name: { type: "string", description: "The tool's name, e.g. \"aseprite__draw_pixels\"" },
    arguments: { type: "object", description: "The tool's arguments, as described by tool_info" },
  }, required: ["name", "arguments"] },
} };

// Finds an on-request tool by full name ("aseprite__draw_pixels") or, when unambiguous, short name ("draw_pixels").
function resolve(name, pool) {
  const n = String(name || "").trim();
  if (pool.has(n)) return { tool: pool.get(n) };
  const short = [...pool.values()].filter((t) => shortName(t) === n || t.name.toLowerCase() === n.toLowerCase());
  if (short.length === 1) return { tool: short[0] };
  const key = n.toLowerCase().replace(/^.*__/, "");
  const near = [...pool.values()].filter((t) => key && shortName(t).toLowerCase().includes(key)).slice(0, 8).map((t) => t.name);
  return { error: short.length > 1 ? `"${n}" matches several tools: ${short.map((t) => t.name).join(", ")}. Use the full name.`
    : `no tool named "${n}" is available.${near.length ? " Similar: " + near.join(", ") + "." : ""}` };
}
// call_tool's arguments as small models write them: {name, arguments:{…}}, arguments as a JSON string, or flattened.
function innerArgs(a) {
  let v = a.arguments ?? a.args ?? a.parameters;
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { return { error: "call_tool's arguments must be a JSON object." }; } }
  if (v === undefined) { const { name, ...rest } = a; v = rest; }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { error: "call_tool's arguments must be a JSON object." };
  return { value: v };
}
// tool_info's result text.
function info(names, pool) {
  const list = Array.isArray(names) ? names : String(names || "").split(/[,\s]+/);
  const out = [], errs = [];
  for (const n of list.filter(Boolean)) {
    const r = resolve(n, pool);
    if (r.error) { errs.push(r.error); continue; }
    const f = r.tool.spec.function;
    out.push(`### ${f.name}\n${(f.description || "").trim()}\nParameters: ${JSON.stringify(f.parameters || { type: "object", properties: {} })}`);
  }
  if (!out.length) return { ok: false, text: "ERROR: " + (errs.join(" ") || "give the tool names in names.") };
  return { ok: true, text: out.join("\n\n") + (errs.length ? "\n\nNot found: " + errs.join(" ") : "") + "\n\nRun one with call_tool {\"name\": \"<tool>\", \"arguments\": {…}}." };
}

module.exports = { DEFAULT_AT, estTokens, serverTokens, threshold, shortName, firstLine, compactList, section, INFO_SPEC, CALL_SPEC, resolve, innerArgs, info };
