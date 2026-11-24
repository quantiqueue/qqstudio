// Web tools: search (DuckDuckGo HTML, then Bing; no key), fetch page as text, download to disk.
const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");
const { Readable } = require("stream");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PAGE_CHARS = 12000;          // chars of page text per fetch_url call
const MAX_DOWNLOAD = 2 * 1024 ** 3; // 2 GB

function checkUrl(u) {
  let url;
  try { url = new URL(u); } catch { throw new Error(`Invalid URL: ${u}`); }
  if (!/^https?:$/.test(url.protocol)) throw new Error("Only http(s) URLs are allowed");
  return url;
}

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", reg: "®", trade: "™" };
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === "#") { const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(n); } catch { return m; } }
    return ENT[e.toLowerCase()] ?? m;
  });
}

function htmlToText(html, base) {
  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "").trim();
  let body = (html.match(/<body[^>]*>([\s\S]*)<\/body>/i) || [, html])[1];
  body = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|template|iframe|canvas)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<(nav|footer|aside)[^>]*>[\s\S]*?<\/\1>/gi, (m) => (m.length > 4000 ? "" : m)); // drop big chrome blocks

  const links = [];
  const seen = new Set();
  body = body.replace(/<a\b[^>]*href\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, href, inner) => {
    const text = decode(inner.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    let abs;
    try { abs = new URL(decode(href), base).href; } catch { return text; }
    if (!/^https?:/.test(abs) || !text) return text;
    if (!seen.has(abs) && links.length < 60) { seen.add(abs); links.push({ text: text.slice(0, 80), url: abs }); }
    return text;
  });

  const text = decode(
    body
      .replace(/<h([1-6])[^>]*>/gi, (m, n) => "\n\n" + "#".repeat(+n) + " ")
      .replace(/<li[^>]*>/gi, "\n- ")
      .replace(/<(br|hr)\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|article|header|tr|table|ul|ol|h[1-6]|blockquote|pre)>/gi, "\n")
      .replace(/<(td|th)[^>]*>/gi, " | ")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text, links };
}

async function get(url, ms = 20000) {
  return fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9" }, redirect: "follow", signal: AbortSignal.timeout(ms) });
}

// Keyless search, done the way Strata does it (app/host/server/web-search-ddg.mjs): DuckDuckGo's HTML page with Bing's
// result page as the second source, asked politely. DuckDuckGo refuses a program that asks fast (two searches in about a
// second pass, the third gets an "anomaly" page, then every page is refused for minutes), so:
//   - the request has a browser's shape (Accept, Accept-Language, Referer/Origin, Sec-Fetch-*; nothing hidden);
//   - one request at a time per source, 2.5-4 s apart, at most 8 a minute;
//   - the same question within 30 minutes is answered from a cache;
//   - a source that refuses is left alone for 1, 2, 4 ... up to 10 minutes (or its Retry-After), since asking again only
//     extends the block, and the next source is tried;
//   - a timeout or server error gets one retry after a pause;
//   - when every source refuses, the model is told plainly not to retry.
const PACE = { gap: 2500, jitter: 1500, perMinute: 8, cooldown: 60000, cooldownMax: 600000, retryPause: 1500 };
const CACHE_MS = 30 * 60 * 1000, CACHE_SIZE = 120;
const SEARCH_LIMITED = "Web search is unavailable right now: DuckDuckGo and Bing are refusing automated searches for a few minutes. Don't retry this search. Carry on with what you know and tell the user in one sentence that web search was unavailable.";
const SEARCH_UNREACHABLE = "The search couldn't reach DuckDuckGo or Bing (network error or timeout). Don't retry this search now. Carry on with what you know and say that web search was unavailable.";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const source = (name) => ({ name, chain: Promise.resolve(), last: 0, starts: [], until: 0, strikes: 0 });
const SOURCES = { ddg: source("DuckDuckGo"), bing: source("Bing") };
const searchCache = new Map();

// Waits for this source's turn. Returns false when the wait would be over 30 s (8 a minute already used).
function turn(s) {
  const run = s.chain.then(async () => {
    const spacing = PACE.gap + Math.floor(Math.random() * PACE.jitter);
    for (;;) {
      const t = Date.now();
      while (s.starts.length && t - s.starts[0] > 60000) s.starts.shift();
      const wait = s.last ? Math.max(spacing - (t - s.last), s.starts.length >= PACE.perMinute ? 60000 - (t - s.starts[0]) : 0) : 0;
      if (wait <= 0) break;
      if (wait > 30000) return false;
      await sleep(wait);
    }
    s.last = Date.now();
    s.starts.push(s.last);
    return true;
  });
  s.chain = run.catch(() => {});
  return run;
}
function refuse(s, res) {
  s.strikes++;
  const ra = Number(res && res.headers && res.headers.get("retry-after"));
  const after = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, PACE.cooldownMax) : 0;
  s.until = Date.now() + Math.max(after, Math.min(PACE.cooldown * 2 ** (s.strikes - 1), PACE.cooldownMax));
}
function accepted(s) { s.strikes = 0; s.until = 0; }
const cooling = (s) => s.until > Date.now();

function browserHeaders(origin, extra) {
  return {
    "User-Agent": UA, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9",
    "Upgrade-Insecure-Requests": "1", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin", "Sec-Fetch-User": "?1",
    ...(origin ? { Referer: origin + "/", Origin: origin } : {}), ...(extra || {}),
  };
}

// One page request in the source's turn, with one retry after a timeout, network error or server error.
// Returns {res, status, html}, {limited: true} (no turn within 30 s) or {failure}.
async function ask(s, url, init) {
  let failure;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!(await turn(s))) return { limited: true };
    try {
      const res = await fetch(url, { redirect: "follow", ...init, signal: AbortSignal.timeout(15000) });
      const html = await res.text();
      if (res.status < 500) return { res, status: res.status, html };
      failure = new Error(`HTTP ${res.status}`);
    } catch (e) { failure = e; }
    if (attempt === 0) await sleep(PACE.retryPause + Math.floor(Math.random() * 1000));
  }
  return { failure };
}

function ddgBlocked(status, html) {
  if ([202, 403, 418, 429].includes(status)) return true;
  return /anomaly-modal|anomaly\.js|unusual traffic|are you a (?:robot|human)|captcha|challenge-form/i.test(html.slice(0, 60000)) && !/class="result__a"/.test(html);
}
function bingBlocked(status, html) {
  if ([403, 429, 503].includes(status)) return true;
  const t = html.slice(0, 80000);
  if (/\bclass="[^"]*\bb_algo\b/.test(t)) return false;
  return /captcha|unusual traffic|are you a robot|verify you are (?:a )?human|\bcf-chl|challenge-platform/i.test(t);
}

function parseDdg(html) {
  const out = [];
  for (const b of html.split(/class="result\s/).slice(1)) {
    const a = b.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    let url = decode(a[1]);
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    if (url.startsWith("//")) url = "https:" + url;
    if (/duckduckgo\.com\/y\.js/.test(url) || /^result--ad/.test(b)) continue; // ads
    const sn = b.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(a|div)>/);
    out.push({ url, title: decode(a[2].replace(/<[^>]+>/g, "")).trim(), snippet: sn ? decode(sn[1].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim() : "" });
  }
  return out;
}

// Bing wraps result links in its own redirect (/ck/a?...&u=a1<base64url of the real address>).
function bingTarget(href) {
  try {
    const url = new URL(decode(href).trim(), "https://www.bing.com/");
    if (/(^|\.)bing\.com$/i.test(url.hostname)) {
      const u = url.searchParams.get("u");
      if (!u || !/^a1/.test(u)) return null;
      const real = new URL(Buffer.from(u.slice(2).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
      return /^https?:$/.test(real.protocol) ? real.href : null;
    }
    return /^https?:$/.test(url.protocol) ? url.href : null;
  } catch { return null; }
}
function parseBing(html) {
  const out = [];
  for (const block of html.split(/<li\b[^>]*\bclass="[^"]*\bb_algo\b[^"]*"/i).slice(1)) {
    const end = block.search(/<li\b[^>]*\bclass="[^"]*\bb_(?:algo|ans|ad|pag)\b/i);
    const body = end > 0 ? block.slice(0, end) : block;
    const h2 = /<h2\b[^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(body);
    if (!h2) continue;
    const href = (/\bhref="([^"]*)"/i.exec(h2[1]) || [])[1];
    const url = href ? bingTarget(href) : null;
    const title = decode(h2[2].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    if (!url || !title) continue;
    const sn = /<p\b[^>]*class="[^"]*\bb_lineclamp\d*\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(body)
      || /<div\b[^>]*class="[^"]*\bb_caption\b[^"]*"[^>]*>[\s\S]*?<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(body);
    out.push({ url, title, snippet: sn ? decode(sn[1].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim() : "" });
  }
  return out;
}

// Each returns {rows}, {refused}, {limited} or {failure}.
async function searchDdg(query) {
  const s = SOURCES.ddg, origin = "https://html.duckduckgo.com";
  const p = await ask(s, origin + "/html/", { method: "POST", headers: browserHeaders(origin, { "Content-Type": "application/x-www-form-urlencoded" }),
    body: new URLSearchParams({ q: query, b: "", kl: "wt-wt", df: "" }).toString() });
  if (p.limited || p.failure) return p;
  if (ddgBlocked(p.status, p.html)) { refuse(s, p.res); return { refused: true }; }
  accepted(s);
  return { rows: parseDdg(p.html) };
}
async function searchBing(query) {
  const s = SOURCES.bing;
  const p = await ask(s, "https://www.bing.com/search?" + new URLSearchParams({ q: query, setlang: "en" }), { headers: browserHeaders(null) });
  if (p.limited || p.failure) return p;
  if (bingBlocked(p.status, p.html)) { refuse(s, p.res); return { refused: true }; }
  accepted(s);
  return { rows: parseBing(p.html) };
}

async function web_search({ query, max_results = 8 }) {
  query = String(query || "").trim().slice(0, 400);
  if (!query) throw new Error("query is required");
  const want = Math.min(Number(max_results) || 8, 20);
  const key = query.toLowerCase().replace(/\s+/g, " ");
  let hit = searchCache.get(key);
  if (!hit || Date.now() - hit.at > CACHE_MS) {
    hit = null;
    let unreachable = false;
    for (const [s, run] of [[SOURCES.ddg, searchDdg], [SOURCES.bing, searchBing]]) {
      if (cooling(s)) continue; // asking again during a block only extends it
      const r = await run(query);
      if (r.failure) { unreachable = true; continue; }
      if (r.refused || r.limited) continue;
      hit = { at: Date.now(), rows: r.rows, from: s.name };
      searchCache.set(key, hit);
      if (searchCache.size > CACHE_SIZE) searchCache.delete(searchCache.keys().next().value);
      break;
    }
    if (!hit) return unreachable ? SEARCH_UNREACHABLE : SEARCH_LIMITED;
  }
  const rows = hit.rows.slice(0, want);
  if (!rows.length) return "No results.";
  const list = rows.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n\n");
  return `Results for "${query}"${hit.from === "Bing" ? " (from Bing)" : ""}:\n\n${list}\n\nUse fetch_url to read a result.`;
}

async function image_search({ query, max_results = 8 }) {
  if (!query) throw new Error("query is required");
  const q = encodeURIComponent(query), s = SOURCES.ddg;
  const limited = "Image search is unavailable right now: DuckDuckGo is refusing automated searches for a few minutes. Don't retry it. Tell the user in one sentence that image search was unavailable.";
  // Same source as web_search: its turn, its cool-down after a refusal.
  if (cooling(s) || !(await turn(s))) return limited;
  const p = await get(`https://duckduckgo.com/?q=${q}&iax=images&ia=images`);
  const page = await p.text();
  const m = page.match(/vqd=["']?([\d-]+)["']?/);
  if (!m) { if (ddgBlocked(p.status, page) || p.status < 500) refuse(s, p); return limited; }
  if (!(await turn(s))) return limited;
  const r = await fetch(`https://duckduckgo.com/i.js?l=us-en&o=json&q=${q}&vqd=${m[1]}&f=,,,,,&p=1`, {
    headers: { "User-Agent": UA, Referer: "https://duckduckgo.com/", Accept: "application/json" },
    signal: AbortSignal.timeout(20000),
  });
  if ([202, 403, 418, 429].includes(r.status)) { refuse(s, r); return limited; }
  if (!r.ok) throw new Error(`image search failed: HTTP ${r.status}`);
  accepted(s);
  const items = ((await r.json()).results || []).slice(0, Math.min(Number(max_results) || 8, 24));
  if (!items.length) return "No images found.";
  const text = items.map((it, i) =>
    `${i + 1}. ${it.title || "(untitled)"} — ${it.width}x${it.height}\n   image: ${it.image}\n   page: ${it.url}`).join("\n");
  return {
    text: `Image results for "${query}" are now shown to the user as thumbnails:\n\n${text}\n\nReply with a short sentence (the user already sees the images). Only call show_image if the user wants one shown large.`,
    images: items.map((it) => ({ src: it.thumbnail || it.image, full: it.image, link: it.url, caption: it.title })),
  };
}

async function fetch_url({ url, offset = 0 }) {
  const u = checkUrl(url);
  const r = await get(u.href);
  const type = (r.headers.get("content-type") || "").toLowerCase();
  const head = `URL: ${r.url}\nStatus: ${r.status}\nContent-Type: ${type || "unknown"}\n`;
  const isText = /text\/|json|xml|javascript|csv|yaml|markdown/.test(type) || !type;
  if (!isText) {
    const len = r.headers.get("content-length");
    r.body?.cancel?.();
    return head + `\nThis is a binary file${len ? ` (${(len / 1048576).toFixed(1)} MB)` : ""}. Use download_file to save it.`;
  }
  const raw = await r.text();
  let title = "", text = raw, links = [];
  if (/html/.test(type) || /^\s*<(!doctype|html)/i.test(raw)) ({ title, text, links } = htmlToText(raw, r.url));
  const start = Math.max(0, Number(offset) || 0);
  const chunk = text.slice(start, start + PAGE_CHARS);
  const more = start + PAGE_CHARS < text.length
    ? `\n\n[showing chars ${start}-${start + chunk.length} of ${text.length}; call fetch_url again with offset=${start + PAGE_CHARS} for more]` : "";
  const linkList = start === 0 && links.length ? `\n\nLinks on page:\n${links.map((l, i) => `[${i + 1}] ${l.text} -> ${l.url}`).join("\n")}` : "";
  return head + (title ? `Title: ${title}\n` : "") + "\n" + chunk + more + linkList;
}

async function download_file({ url, path: dest }, resolvePath) {
  const u = checkUrl(url);
  if (!dest) throw new Error("path is required");
  let target = resolvePath(dest);
  try { if (fs.statSync(target).isDirectory()) target = path.join(target, decodeURIComponent(path.basename(u.pathname)) || "download"); } catch {}
  if (fs.existsSync(target)) throw new Error(`File already exists: ${target}`);
  const r = await get(u.href, 10 * 60 * 1000);
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
  const len = Number(r.headers.get("content-length") || 0);
  if (len > MAX_DOWNLOAD) throw new Error(`File too large (${(len / 1048576).toFixed(0)} MB, limit 2048 MB)`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let bytes = 0;
  const src = Readable.fromWeb(r.body);
  src.on("data", (c) => { bytes += c.length; if (bytes > MAX_DOWNLOAD) src.destroy(new Error("Download exceeded 2048 MB limit")); });
  try { await pipeline(src, fs.createWriteStream(target)); }
  catch (e) { try { fs.unlinkSync(target); } catch {} throw e; }
  return `Downloaded ${(bytes / 1048576).toFixed(2)} MB from ${r.url}\nSaved to ${target}\nContent-Type: ${r.headers.get("content-type") || "unknown"}`;
}

// http_request: any method, headers and body; returns the status, the main headers and the body (JSON pretty-printed).
const MAX_BODY = 5 * 1024 * 1024, BODY_CHARS = 20000;
async function http_request({ url, method = "GET", headers = {}, json, body, timeout = 30 }) {
  const u = checkUrl(url), m = String(method || "GET").toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(m)) throw new Error(`unsupported method ${m}`);
  const h = { "User-Agent": UA, Accept: "application/json, text/plain, */*", ...(headers && typeof headers === "object" ? headers : {}) };
  const hasType = Object.keys(h).some((k) => k.toLowerCase() === "content-type");
  let data;
  if (json !== undefined) { data = typeof json === "string" ? json : JSON.stringify(json); if (!hasType) h["Content-Type"] = "application/json"; }
  else if (body !== undefined) { data = typeof body === "string" ? body : JSON.stringify(body); if (!hasType && typeof body !== "string") h["Content-Type"] = "application/json"; }
  const ms = Math.min(Math.max(Number(timeout) || 30, 1), 120) * 1000;
  const r = await fetch(u, { method: m, headers: h, body: m === "GET" || m === "HEAD" ? undefined : data, redirect: "follow", signal: AbortSignal.timeout(ms) });
  const keep = ["content-type", "content-length", "location", "retry-after", "x-ratelimit-remaining", "x-ratelimit-reset", "www-authenticate"];
  const hdrs = keep.map((k) => (r.headers.get(k) ? `${k}: ${r.headers.get(k)}` : "")).filter(Boolean).join("\n");
  let text = "";
  if (m !== "HEAD") {
    const buf = Buffer.from(await r.arrayBuffer()).subarray(0, MAX_BODY);
    const ct = r.headers.get("content-type") || "";
    const textual = /json|text|xml|javascript|html|form|yaml|csv/i.test(ct) || (!ct && !buf.subarray(0, 4000).includes(0));
    if (!textual) text = `(binary body: ${buf.length} bytes of ${ct || "unknown type"}; use download_file to save it)`;
    else {
      text = buf.toString("utf8");
      if (/json/i.test(ct)) { try { text = JSON.stringify(JSON.parse(text), null, 2); } catch {} }
      if (text.length > BODY_CHARS) text = text.slice(0, BODY_CHARS) + `\n...[truncated, ${text.length - BODY_CHARS} more chars]`;
    }
  }
  return `HTTP ${r.status} ${r.statusText}${r.redirected ? ` (redirected to ${r.url})` : ""}${hdrs ? "\n" + hdrs : ""}\n\n${text || "(empty body)"}`;
}

module.exports = { web_search, image_search, fetch_url, download_file, htmlToText, http_request, _search: { PACE, SOURCES, searchCache } };
