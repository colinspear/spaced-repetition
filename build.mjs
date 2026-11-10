// Build dist/card-catalog.html: one self-contained page (the Artifact host serves single files).
// Inlines CSS, the deck JSON, and the three JS modules with their import/export syntax stripped.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";

const DECK_ORDER = ["gov", "str", "met", "mod", "arc", "lnk", "prv", "evd", "chg", "lrn", "ldr"];
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

const decks = DECK_ORDER.map((d) => JSON.parse(read(`decks/${d}.json`)));

function stripModule(src) {
  // Multi-line `import { a, b } from "./x.js";` blocks and `export` keywords.
  return src
    .replace(/^import\s[\s\S]*?from\s+["'][^"']+["'];\s*$/gm, "")
    .replace(/^export\s+(const|function|async function|let|class)\s/gm, "$1 ");
}
const js = ["src/fsrs.js", "src/engine.js", "src/app.js"].map((p) => `// ---- ${p}\n${stripModule(read(p))}`).join("\n");
const hash = createHash("sha256").update(js + JSON.stringify(decks) + read("src/app.css")).digest("hex").slice(0, 10);
const build = `${new Date().toISOString().slice(0, 10)}-${hash}`;
const page = read("src/page.html")
  .replace("/*__CSS__*/", () => read("src/app.css"))
  .replace("/*__JS__*/", () => js.replace("__DECKS__", () => JSON.stringify(decks)).replace("__BUILD__", build));

if (/^\s*(import|export)\s/m.test(js)) throw new Error("module syntax left in bundle");
mkdirSync(new URL("dist/", import.meta.url), { recursive: true });
writeFileSync(new URL("dist/card-catalog.html", import.meta.url), page);
console.log(`dist/card-catalog.html  ${(page.length / 1024).toFixed(1)} KiB  build ${build}  ${decks.reduce((n, d) => n + d.cards.length, 0)} cards`);
