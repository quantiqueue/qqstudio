// A value worked out from a folder's contents (a scan), kept until something in the folder changes. On Windows and
// macOS a watcher on the folder tree says when; elsewhere (Linux on Node 18 has no recursive watch) the value is redone
// after a few seconds. Either way it is redone after maxAge, and invalidate() is for qqstudio's own changes.
// Scans read the disk, which is slow while Strata generates (100-1,600 ms per read on the user's PC), and the pages
// poll: a scan per poll stalled the server and the pages waited (Settings, the sidebar, a workspace's files).
// compute(dir) may return a value or a promise. Scans of one folder at a time; callers asking meanwhile share it.
const fs = require("fs");
const WATCHABLE = process.platform === "win32" || process.platform === "darwin";

function dirCache(compute, { maxAge = 60000, unwatchedAge = 5000 } = {}) {
  const entries = new Map(); // dir -> { at, value, pending, watcher, changedAt }
  function watch(e, dir) {
    if (!WATCHABLE || e.watcher) return;
    try {
      e.watcher = fs.watch(dir, { recursive: true }, () => { e.at = 0; e.changedAt = Date.now(); });
      e.watcher.on("error", () => { try { e.watcher.close(); } catch {} e.watcher = null; e.at = 0; }); // e.g. the folder was removed
      e.watcher.unref();
    } catch { e.watcher = null; } // not there yet: tried again at the next scan
  }
  function get(dir) {
    let e = entries.get(dir);
    if (!e) entries.set(dir, (e = { at: 0, value: undefined, pending: null, watcher: null, changedAt: 0 }));
    if (e.at && Date.now() - e.at <= (e.watcher ? maxAge : unwatchedAge)) return e.value;
    if (e.pending) return e.pending;
    watch(e, dir);
    const started = Date.now();
    // A change during the scan may be missing from it: keep the result for this caller, but scan again next time.
    const keep = (v) => { e.value = v; e.at = e.changedAt >= started ? 0 : Date.now(); return v; };
    const v = compute(dir);
    if (!v || typeof v.then !== "function") return keep(v);
    const p = v.then((x) => { keep(Promise.resolve(x)); return x; }).finally(() => { if (e.pending === p) e.pending = null; });
    e.pending = p;
    return p;
  }
  function invalidate(dir) {
    for (const [d, e] of entries) if (dir == null || d === dir) { e.at = 0; e.changedAt = Date.now(); }
  }
  return { get, invalidate };
}

module.exports = { dirCache };
