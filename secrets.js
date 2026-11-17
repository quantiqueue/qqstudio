// Secret masking: recognisable secrets in tool results are replaced with placeholders like [secret:github-token-1]
// before the result is saved to the session or sent to the model. The real values stay in memory only (per session,
// lost when the harness restarts). When the model passes a placeholder to a tool, it is filled back in just before
// the tool runs, so the model can use a secret without ever seeing it and it is never written to disk.

// [kind, pattern, group holding the secret (0 = whole match)]. Specific patterns first.
const PATTERNS = [
  ["private-key", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, 0],
  ["github-token", /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g, 0],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9]{30,255}\b/g, 0],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}/g, 0],
  ["stripe-key", /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g, 0],
  ["openai-key", /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, 0],
  ["huggingface-token", /\bhf_[A-Za-z0-9]{30,}\b/g, 0],
  ["aws-access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, 0],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/g, 0],
  ["slack-token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, 0],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}/g, 0],
  ["bearer-token", /\b(?:Bearer|Basic)\s+([A-Za-z0-9._~+/-]{20,}=*)/g, 1],
  // key = value / key: value / "key": "value" where the key looks like a secret name
  ["secret", /\b([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth)[A-Za-z0-9_.-]*)["']?\s*[=:]\s*(["']?)([^\s"'`,;<>]{8,})\2/gi, 3],
];
// Values that are clearly not secrets (references, placeholders, booleans).
const NOT_SECRET = /^(?:true|false|null|none|undefined|required|optional|string|number|boolean|password|changeme|example\w*|your[_-]?\w*|xxx+|\*+|<.*>|\$\{.*\}|\$[A-Z_]+|%[A-Z_]+%|\[secret:[^\]]+\])$/i;
const looksSecret = (v) => v.length >= 8 && !NOT_SECRET.test(v) && (/\d/.test(v) || (/[a-z]/.test(v) && /[A-Z]/.test(v)) || /[^A-Za-z0-9]/.test(v));

const vaults = new Map(); // session id -> { byValue: Map(value -> placeholder), byPlaceholder: Map(placeholder -> value), n: {kind: count} }
function vaultOf(sid) {
  if (!vaults.has(sid)) vaults.set(sid, { byValue: new Map(), byPlaceholder: new Map(), n: {} });
  return vaults.get(sid);
}
function placeholderFor(v, kind, value) {
  if (v.byValue.has(value)) return v.byValue.get(value);
  v.n[kind] = (v.n[kind] || 0) + 1;
  const ph = `[secret:${kind}-${v.n[kind]}]`;
  v.byValue.set(value, ph); v.byPlaceholder.set(ph, value);
  return ph;
}

// Masks secrets in text. Returns { text, count }.
function mask(sid, text) {
  if (typeof text !== "string" || !text) return { text, count: 0 };
  const v = vaultOf(sid);
  let count = 0;
  // Shield placeholders already in the text (from earlier passes) so no pattern matches inside them.
  const shielded = [];
  let out = text.replace(/\[secret:[a-z0-9-]+-\d+\]/g, (ph) => `\u0000${shielded.push(ph) - 1}\u0000`);
  const shield = (ph) => `\u0000${shielded.push(ph) - 1}\u0000`;
  for (const [kind, rx, group] of PATTERNS) {
    rx.lastIndex = 0;
    out = out.replace(rx, (...m) => {
      const whole = m[0], secret = m[group];
      if (!secret || secret.startsWith("[secret:")) return whole;
      if (kind === "secret" && !looksSecret(secret)) return whole;
      if (/\u0000/.test(secret)) return whole;
      count++;
      const ph = shield(placeholderFor(v, kind, secret));
      return group === 0 ? ph : whole.replace(secret, ph);
    });
  }
  out = out.replace(/\u0000(\d+)\u0000/g, (_, i) => shielded[Number(i)]);
  return { text: out, count };
}

// Fills placeholders back into tool arguments (any string inside). Unknown placeholders (e.g. after a restart)
// are reported so the tool isn't run with a placeholder in place of the secret.
function unmask(sid, value) {
  const v = vaults.get(sid);
  const missing = new Set();
  const fill = (x) => {
    if (typeof x === "string") return x.replace(/\[secret:[a-z0-9-]+-\d+\]/g, (ph) => { const real = v && v.byPlaceholder.get(ph); if (real === undefined) { missing.add(ph); return ph; } return real; });
    if (Array.isArray(x)) return x.map(fill);
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, fill(y)]));
    return x;
  };
  const out = fill(value);
  return { value: out, missing: [...missing] };
}
const forget = (sid) => vaults.delete(sid);

module.exports = { mask, unmask, forget, PATTERNS };
