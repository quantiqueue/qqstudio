// Web tools: search (DuckDuckGo HTML, no key), fetch page as text, download to disk.
const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");
const { Readable } = require("stream");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
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

async function web_search({ query, max_results = 8 }) {
  if (!query) throw new Error("query is required");
  const r = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ q: query }).toString(),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`search failed: HTTP ${r.status}`);
  const html = await r.text();
  const results = [];
  const blocks = html.split(/class="result\s/).slice(1);
  for (const b of blocks) {
    if (results.length >= Math.min(Number(max_results) || 8, 20)) break;
    const a = b.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    let url = decode(a[1]);
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    if (url.startsWith("//")) url = "https:" + url;
    if (/duckduckgo\.com\/y\.js/.test(url)) continue; // ads
    const title = decode(a[2].replace(/<[^>]+>/g, "")).trim();
    const sn = b.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(a|div)>/);
    const snippet = sn ? decode(sn[1].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim() : "";
    results.push(`${results.length + 1}. ${title}\n   ${url}\n   ${snippet}`);
  }
  if (!results.length) return /anomaly|captcha/i.test(html) ? "Search was blocked by DuckDuckGo (rate limit). Try again shortly." : "No results.";
  return `Results for "${query}":\n\n${results.join("\n\n")}\n\nUse fetch_url to read a result.`;
}

async function image_search({ query, max_results = 8 }) {
  if (!query) throw new Error("query is required");
  const q = encodeURIComponent(query);
  const page = await (await get(`https://duckduckgo.com/?q=${q}&iax=images&ia=images`)).text();
  const m = page.match(/vqd=["']?([\d-]+)["']?/);
  if (!m) throw new Error("Image search unavailable (DuckDuckGo did not return a search token; possibly rate-limited)");
  const r = await fetch(`https://duckduckgo.com/i.js?l=us-en&o=json&q=${q}&vqd=${m[1]}&f=,,,,,&p=1`, {
    headers: { "User-Agent": UA, Referer: "https://duckduckgo.com/", Accept: "application/json" },
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`image search failed: HTTP ${r.status}`);
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

async function download_file({ url, path: dest }, resolveSafe) {
  const u = checkUrl(url);
  if (!dest) throw new Error("path is required");
  let target = resolveSafe(dest);
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

module.exports = { web_search, image_search, fetch_url, download_file, htmlToText, http_request };
