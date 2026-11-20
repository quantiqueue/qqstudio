// Syntax-checks the inline <script> blocks in public/*.html: a slip there breaks the page while the server starts fine.
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm");
const dir = path.join(__dirname, "..", "..", "public");
let bad = 0;
for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".html"))) {
  const html = fs.readFileSync(path.join(dir, f), "utf8");
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  blocks.forEach((code, i) => {
    try { new vm.Script(code, { filename: `${f} <script> #${i + 1}` }); }
    catch (e) { bad++; console.error(`${f} <script> #${i + 1}: ${e.message}`); }
  });
  console.log(`${f}: ${blocks.length} script block(s) checked`);
}
process.exit(bad ? 1 : 0);
