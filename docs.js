// Text from documents for read_file: PDF, Word (.docx), Excel (.xlsx), PowerPoint (.pptx), OpenDocument (.odt/.ods/.odp).
// No dependencies: Office files are zip + XML; PDFs are parsed just enough to pull out page text (compressed streams,
// object streams, fonts with ToUnicode maps). Scanned PDFs (images only) and encrypted ones give no text.
const fs = require("fs/promises");
const zlib = require("zlib");

const DOC_EXT = /\.(pdf|docx|xlsx|pptx|odt|ods|odp)$/i;
const cache = new Map(); // file -> { mtimeMs, text }, a few recent ones (reading in parts re-uses the extraction)

async function extract(file) {
  const st = await fs.stat(file);
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.text;
  const buf = await fs.readFile(file);
  const ext = file.toLowerCase().split(".").pop();
  const text = ext === "pdf" ? pdfText(buf) : officeText(buf, ext);
  cache.set(file, { mtimeMs: st.mtimeMs, text });
  if (cache.size > 8) cache.delete(cache.keys().next().value);
  return text;
}

// ---------- XML helpers ----------
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unxml = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === "#") { try { return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)); } catch { return m; } }
  return ENT[e] ?? m;
});
const tidy = (s) => s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

// ---------- zip (in memory: stored and deflate entries) ----------
function zipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a valid Office file (no zip directory)");
  const count = buf.readUInt16LE(eocd + 10), out = new Map();
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && buf.readUInt32LE(p) === 0x02014b50; n++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32), lho = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    out.set(name, () => {
      const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28), data = buf.subarray(start, start + csize);
      return (method === 8 ? zlib.inflateRawSync(data) : data).toString("utf8");
    });
  }
  return out;
}
const byNumber = (re) => (a, b) => Number(a.match(re)?.[1] || 0) - Number(b.match(re)?.[1] || 0);

function officeText(buf, ext) {
  const z = zipEntries(buf), get = (n) => (z.has(n) ? z.get(n)() : "");
  if (ext === "docx") {
    const parts = ["word/document.xml", ...[...z.keys()].filter((n) => /^word\/(footnotes|endnotes)\.xml$/.test(n))];
    return tidy(parts.map((n) => wordXml(get(n))).join("\n\n"));
  }
  if (ext === "pptx") {
    const slides = [...z.keys()].filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort(byNumber(/slide(\d+)/));
    return tidy(slides.map((n, i) => {
      const notes = get(n.replace("slides/slide", "notesSlides/notesSlide"));
      return `--- Slide ${i + 1} ---\n${drawingXml(get(n))}${notes ? "\n[Notes] " + drawingXml(notes).replace(/^\d+\s*$/m, "") : ""}`;
    }).join("\n\n"));
  }
  if (ext === "xlsx") {
    const shared = [...get("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => unxml([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")));
    const names = [...get("xl/workbook.xml").matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => unxml(m[1]));
    const sheets = [...z.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort(byNumber(/sheet(\d+)/));
    return tidy(sheets.map((n, i) => {
      const rows = [...get(n).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map((r) => {
        const cells = [];
        for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const ref = (c[1].match(/\br="([A-Z]+)\d+"/) || [])[1], t = (c[1].match(/\bt="(\w+)"/) || [])[1], body = c[2] || "";
          const v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
          const val = t === "s" ? shared[Number(v)] ?? "" : t === "inlineStr" ? unxml([...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join("")) : unxml(v ?? "");
          const col = ref ? [...ref].reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1 : cells.length;
          while (cells.length < col) cells.push("");
          cells[col] = val;
        }
        return cells.join("\t");
      });
      return `--- Sheet: ${names[i] || "Sheet" + (i + 1)} ---\n${rows.join("\n")}`;
    }).join("\n\n"));
  }
  // OpenDocument: everything is in content.xml
  let x = get("content.xml").replace(/<table:table-cell\b[\s\S]*?<\/table:table-cell>/g, (c) => c.replace(/<\/text:p>(?![\s\S]*<\/text:p>)/, "").replace(/<\/text:p>/g, " ") + "\t");
  return tidy(unxml(x.replace(/<text:tab\/>/g, "\t").replace(/<text:line-break\/>/g, "\n").replace(/\t?<\/table:table-row>/g, "\n")
    .replace(/<\/(text:p|text:h)>/g, "\n").replace(/<[^>]+>/g, "")));
}
function wordXml(x) {
  // Table cells: their paragraphs joined with a space, cells separated by tabs, one row per line.
  x = x.replace(/<w:tc\b[\s\S]*?<\/w:tc>/g, (c) => c.replace(/<\/w:p>(?![\s\S]*<\/w:p>)/, "").replace(/<\/w:p>/g, " ") + "\t");
  return unxml(x.replace(/<w:tab\/>/g, "\t").replace(/<w:(br|cr)\b[^>]*\/>/g, "\n").replace(/\t?<\/w:tr>/g, "\n")
    .replace(/<\/w:p>/g, "\n").replace(/<w:delText\b[\s\S]*?<\/w:delText>/g, "").replace(/<[^>]+>/g, ""));
}
const drawingXml = (x) => unxml(x.replace(/<a:br\b[^>]*\/>/g, "\n").replace(/<\/a:p>/g, "\n").replace(/<[^>]+>/g, "")).trim();

// ---------- PDF ----------
function pdfText(buf) {
  const src = buf.toString("latin1");
  if (/\/Encrypt\s+\d+\s+\d+\s+R/.test(src)) throw new Error("this PDF is encrypted; its text can't be read");
  const objs = new Map(); // id -> { dict, stream? (Buffer, decoded) }
  const objRe = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = objRe.exec(src))) {
    const start = m.index + m[0].length;
    const end = src.indexOf("endobj", start);
    if (end < 0) break;
    const body = src.slice(start, end);
    const si = body.search(/\bstream\r?\n/);
    const o = { dict: si >= 0 ? body.slice(0, si) : body };
    if (si >= 0) {
      const dataStart = start + si + body.slice(si).match(/^stream\r?\n/)[0].length;
      const len = Number((o.dict.match(/\/Length\s+(\d+)\b(?!\s+\d+\s+R)/) || [])[1]); // a direct length (not "12 0 R")
      const dataEnd = len && dataStart + len <= end ? dataStart + len : src.lastIndexOf("endstream", end);
      o.raw = buf.subarray(dataStart, dataEnd);
    }
    objs.set(Number(m[1]), o);
    objRe.lastIndex = end;
  }
  const stream = (o) => {
    if (!o || !o.raw) return null;
    if (o.data) return o.data;
    // Filters are applied in order (e.g. [/ASCII85Decode /FlateDecode]); images (DCT, JPX) and rarer ones: no text.
    const fv = value(o.dict, "Filter"), filters = [...fv.matchAll(/\/(\w+)/g)].map((x) => x[1]);
    let d = o.raw;
    for (const f of filters) {
      if (f === "FlateDecode" || f === "Fl") { try { d = zlib.inflateSync(d); } catch { try { d = zlib.inflateRawSync(d.subarray(2)); } catch { return null; } } }
      else if (f === "ASCII85Decode" || f === "A85") d = ascii85(d);
      else if (f === "ASCIIHexDecode" || f === "AHx") { const h = d.toString("latin1").replace(/[^0-9a-fA-F]/g, ""); d = Buffer.from(h.length % 2 ? h + "0" : h, "hex"); }
      else return null;
    }
    return (o.data = d);
  };
  // Objects inside object streams (PDF 1.5+): page and font dictionaries often live there.
  for (const o of [...objs.values()]) {
    if (!/\/Type\s*\/ObjStm/.test(o.dict)) continue;
    const d = stream(o); if (!d) continue;
    const s = d.toString("latin1"), n = Number((o.dict.match(/\/N\s+(\d+)/) || [])[1]), first = Number((o.dict.match(/\/First\s+(\d+)/) || [])[1]);
    const head = s.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n; i++) {
      const id = head[2 * i], off = first + head[2 * i + 1], next = i + 1 < n ? first + head[2 * i + 3] : s.length;
      if (!objs.has(id)) objs.set(id, { dict: s.slice(off, next) });
    }
  }
  const ref = (s, key) => Number(((s || "").match(new RegExp("/" + key + "\\s+(\\d+)\\s+\\d+\\s+R")) || [])[1]) || null;
  const deref = (s, key) => { const r = ref(s, key); return r ? objs.get(r)?.dict || "" : value(s, key); };
  // The value after /Key: a balanced << >> dictionary or [ ] array, else up to the next token.
  function value(s, key) {
    const i = (s || "").search(new RegExp("/" + key + "(?![A-Za-z0-9])"));
    if (i < 0) return "";
    let j = i + key.length + 1;
    while (/\s/.test(s[j])) j++;
    const open = s.startsWith("<<", j) ? "<<" : s[j] === "[" ? "[" : null;
    if (!open) return (s.slice(j).match(/^\/?[^/\s<>[\]]+(?:\s+\d+\s+R)?/) || [""])[0]; // a name (/FlateDecode), number or reference
    const close = open === "<<" ? ">>" : "]";
    let depth = 0, k = j;
    for (; k < s.length; k++) {
      if (s.startsWith(open, k)) { depth++; k += open.length - 1; } else if (s.startsWith(close, k)) { depth--; k += close.length - 1; if (!depth) break; }
    }
    return s.slice(j, k + 1);
  }
  // Pages in reading order, through the page tree (else file order).
  const pages = [];
  const root = [...objs.values()].find((o) => /\/Type\s*\/Catalog/.test(o.dict));
  (function walk(id, inherited, depth) {
    const o = objs.get(id); if (!o || depth > 50) return;
    const rr = ref(o.dict, "Resources"); // /Resources 30 0 R, or an inline << >> dictionary, or inherited from the parent
    const res = (rr ? objs.get(rr)?.dict : value(o.dict, "Resources")) || inherited;
    if (/\/Type\s*\/Page(?!s)/.test(o.dict)) return pages.push({ o, res });
    for (const k of (value(o.dict, "Kids").match(/(\d+)\s+\d+\s+R/g) || [])) walk(Number(k.split(/\s+/)[0]), res, depth + 1);
  })(root ? ref(root.dict, "Pages") : null, "", 0);
  if (!pages.length) for (const o of objs.values()) if (/\/Type\s*\/Page(?!s)/.test(o.dict)) pages.push({ o, res: value(o.dict, "Resources") });

  const cmaps = new Map();
  const fontsOf = (res) => {
    const fd = deref(res, "Font"), out = {};
    for (const f of fd.matchAll(/\/([^\s/<>[\]]+)\s+(\d+)\s+\d+\s+R/g)) out[f[1]] = fontInfo(Number(f[2]));
    return out;
  };
  function fontInfo(id) {
    if (cmaps.has(id)) return cmaps.get(id);
    const d = objs.get(id)?.dict || "", tu = ref(d, "ToUnicode");
    const info = { map: null, bytes: /\/Subtype\s*\/Type0/.test(d) ? 2 : 1 };
    const cm = tu && stream(objs.get(tu));
    if (cm) {
      const map = new Map(), s = cm.toString("latin1"), hexs = (h) => { let out = ""; for (let i = 0; i + 4 <= h.length; i += 4) out += String.fromCharCode(parseInt(h.slice(i, i + 4), 16)); return out || String.fromCharCode(parseInt(h, 16)); };
      for (const b of s.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) for (const e of b[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) { map.set(parseInt(e[1], 16), hexs(e[2])); info.bytes = e[1].length / 2; }
      for (const b of s.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) for (const e of b[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g)) {
        const lo = parseInt(e[1], 16), hi = parseInt(e[2], 16); info.bytes = e[1].length / 2;
        if (e[3][0] === "[") [...e[3].matchAll(/<([0-9a-fA-F]*)>/g)].forEach((x, k) => map.set(lo + k, hexs(x[1])));
        else { const base = e[3].slice(1, -1); for (let c = lo; c <= hi && c - lo < 65536; c++) map.set(c, hexs((parseInt(base, 16) + c - lo).toString(16).padStart(base.length, "0"))); }
      }
      info.map = map;
    }
    cmaps.set(id, info);
    return info;
  }
  const decodeStr = (bytes, font) => {
    if (!font || !font.map) return String.fromCharCode(...bytes);
    let out = "";
    for (let i = 0; i + font.bytes <= bytes.length; i += font.bytes) {
      const code = font.bytes === 2 ? (bytes[i] << 8) | bytes[i + 1] : bytes[i];
      out += font.map.get(code) ?? "";
    }
    return out;
  };

  const out = [];
  pages.forEach((pg, n) => {
    const fonts = fontsOf(pg.res);
    const contents = value(pg.o.dict, "Contents");
    const ids = (contents.match(/(\d+)\s+\d+\s+R/g) || []).map((x) => Number(x.split(/\s+/)[0]));
    const parts = [];
    for (const id of ids) {
      const o = objs.get(id);
      if (o && !o.raw && /^\s*\[/.test(o.dict)) { for (const x of o.dict.match(/(\d+)\s+\d+\s+R/g) || []) { const d = stream(objs.get(Number(x.split(/\s+/)[0]))); if (d) parts.push(d); } }
      else { const d = stream(o); if (d) parts.push(d); }
    }
    out.push(`--- Page ${n + 1} ---\n` + contentText(Buffer.concat(parts), fonts, decodeStr));
  });
  const text = tidy(out.join("\n\n"));
  if (text.replace(/--- Page \d+ ---/g, "").trim().length < 20)
    throw new Error("no text found in this PDF (it may be scanned images); try OCR, e.g. with run_script");
  return text;
}

function ascii85(buf) {
  const s = buf.toString("latin1").replace(/^\s*<~/, "").replace(/~>[\s\S]*$/, "").replace(/\s+/g, "");
  const out = [];
  let group = [];
  for (const ch of s) {
    if (ch === "z" && !group.length) { out.push(0, 0, 0, 0); continue; }
    group.push(ch.charCodeAt(0) - 33);
    if (group.length === 5) { let v = 0; for (const g of group) v = v * 85 + g; out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); group = []; }
  }
  if (group.length) {
    const n = group.length; while (group.length < 5) group.push(84);
    let v = 0; for (const g of group) v = v * 85 + g;
    out.push(...[(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].slice(0, n - 1));
  }
  return Buffer.from(out);
}

// Text drawn by a page's content stream: strings shown with Tj/TJ/'/", line breaks from T*/Td/TD/Tm.
function contentText(buf, fonts, decodeStr) {
  const s = buf, n = s.length;
  let i = 0, font = null, line = "", lastY = null;
  const lines = [], stack = [];
  const flush = () => { if (line.trim()) lines.push(line.replace(/\s+$/, "")); line = ""; };
  const isWs = (c) => c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;
  const isDelim = (c) => isWs(c) || c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 47 || c === 37 || c === 123 || c === 125;
  while (i < n) {
    const c = s[i];
    if (isWs(c)) { i++; continue; }
    if (c === 37) { while (i < n && s[i] !== 10 && s[i] !== 13) i++; continue; } // comment
    if (c === 40) { // (literal string)
      const bytes = []; let depth = 1; i++;
      while (i < n && depth) {
        let b = s[i++];
        if (b === 92) {
          const e = s[i++];
          const esc = { 110: 10, 114: 13, 116: 9, 98: 8, 102: 12 }[e];
          if (esc !== undefined) b = esc;
          else if (e >= 48 && e <= 55) { let o = e - 48; for (let k = 0; k < 2 && s[i] >= 48 && s[i] <= 55; k++) o = o * 8 + s[i++] - 48; b = o & 255; }
          else if (e === 13 || e === 10) { if (e === 13 && s[i] === 10) i++; continue; }
          else b = e;
        } else if (b === 40) depth++;
        else if (b === 41 && !--depth) break;
        bytes.push(b);
      }
      stack.push({ str: bytes }); continue;
    }
    if (c === 60 && s[i + 1] !== 60) { // <hex string>
      let j = i + 1, h = "";
      while (j < n && s[j] !== 62) { if (!isWs(s[j])) h += String.fromCharCode(s[j]); j++; }
      if (h.length % 2) h += "0";
      const bytes = []; for (let k = 0; k < h.length; k += 2) bytes.push(parseInt(h.slice(k, k + 2), 16));
      stack.push({ str: bytes }); i = j + 1; continue;
    }
    if (c === 91) { stack.push({ mark: true }); i++; continue; }
    if (c === 93) { const arr = []; while (stack.length && !stack[stack.length - 1].mark) arr.unshift(stack.pop()); stack.pop(); stack.push({ arr }); i++; continue; }
    if (c === 60 || c === 62) { i += 2; continue; } // << >> (inline dicts, e.g. marked content)
    let j = i; i++;
    while (i < n && !isDelim(s[i])) i++;
    const tok = s.toString("latin1", j, i);
    if (c === 47) { stack.push({ name: tok.slice(1) }); continue; }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) { stack.push({ num: Number(tok) }); continue; }
    const nums = () => stack.filter((x) => x.num !== undefined).map((x) => x.num);
    switch (tok) {
      case "BI": { const e = s.indexOf("EI", i); i = e < 0 ? n : e + 2; break; } // inline image
      case "Tf": { const nm = stack.find((x) => x.name); font = nm ? fonts[nm.name] : null; break; }
      case "Tj": case "'": case '"': { const st = stack.find((x) => x.str); if (tok !== "Tj") flush(); if (st) line += decodeStr(st.str, font); break; }
      case "TJ": {
        const a = stack.find((x) => x.arr);
        if (a) for (const el of a.arr) { if (el.str) line += decodeStr(el.str, font); else if (el.num !== undefined && el.num < -200 && !line.endsWith(" ")) line += " "; }
        break;
      }
      case "T*": flush(); break;
      case "Td": case "TD": { const v = nums(); const ty = v[v.length - 1] || 0, tx = v[v.length - 2] || 0; if (Math.abs(ty) > 0.5) flush(); else if (tx > 1 && line && !line.endsWith(" ")) line += " "; break; }
      case "Tm": { const v = nums(); const y = v[v.length - 1]; if (lastY !== null && Math.abs(y - lastY) > 0.5) flush(); else if (line && !line.endsWith(" ")) line += " "; lastY = y; break; }
      case "ET": if (line && !line.endsWith(" ")) line += " "; break;
    }
    stack.length = 0;
  }
  flush();
  return lines.join("\n");
}

module.exports = { DOC_EXT, extract };
