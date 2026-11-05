// Browser smoke test for dist/card-catalog.html against a mock of the Artifact runtime
// (db, sample, downloads). Drives the main flows and fails on any console error.
//   node build.mjs && node tools/smoke.mjs [--shots DIR]
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const page_url = new URL("../dist/card-catalog.html", import.meta.url).href;
const shotsDir = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : null;

// Runs inside the page before any script: a minimal in-memory stand-in for claude.use().
function installMock() {
  const docs = new Map();
  const snap = (path) => ({ id: path.split("/").pop(), exists: docs.has(path), data: () => (docs.has(path) ? structuredClone(docs.get(path)) : undefined), metadata: { fromCache: false, hasPendingWrites: false } });
  const db = {
    doc: (path) => ({ path, get: async () => snap(path), set: async (d) => { docs.set(path, structuredClone(d)); }, delete: async () => docs.delete(path) }),
    collection: (col) => ({
      get: async () => {
        const ds = [...docs.keys()].filter((k) => k.startsWith(col + "/") && k.split("/").length === col.split("/").length + 1).sort().map(snap);
        return { docs: ds, size: ds.length, empty: !ds.length };
      },
    }),
  };
  const replies = [];
  const sample = async () => ({ text: "ok", truncated: false });
  sample.json = async (prompt) => {
    replies.push(prompt.slice(0, 60));
    if (prompt.startsWith("Grade one")) return { points: [{ i: 1, verdict: "hit", note: "named accountability" }, { i: 2, verdict: "miss", note: "steward role missing" }], wrong: "", feedback: "You defined the owner but not the steward.", rating: 2 };
    if (prompt.startsWith("Turn this note")) return { cards: [{ kind: "fact", prompt: "Which tenant setting exposes DAX in scans?", answer: "Enhance admin API responses with DAX and mashup expressions." }, { kind: "concept", prompt: "Why stitch lineage by server identity?", answer: "Connectors name servers differently.", points: ["alias vs FQDN", "match identities"] }] };
    if (prompt.startsWith("A learner keeps missing")) return { diagnosis: "You swap steward and custodian.", explanation: "Steward = meaning; custodian = machinery.", hook: "Stewards argue about definitions; custodians argue about backups.", contrast_card: { prompt: "Who restores a deleted table?", answer: "The custodian." }, rewrite: null };
    return {};
  };
  const saved = [];
  const downloads = { save: async (r) => { saved.push(r.filename); return { status: "saved" }; } };
  window.__mock = { docs, replies, saved };
  window.claude = { use: async (name) => ({ db, sample, downloads })[name] ?? null };
}

const browser = await chromium.launch();
const errors = [];
async function newPage(opts, mock = true, seed = null) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && !/fonts\.(googleapis|gstatic)/.test(m.text() + (m.location()?.url || "")) && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  if (mock) await page.addInitScript(installMock);
  if (seed) await page.addInitScript(seed);
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.goto(page_url);
  await page.waitForSelector(".index-card, .panel.done");
  return page;
}

// 1. Review flow on a phone, with Claude grading.
const phone = await newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
assert.match(await phone.textContent(".store"), /Saved to your account/);
const first = await phone.textContent(".callno");
assert.equal(first.trim(), "GOV·01", "first new card comes from the first deck");
if (shotsDir) await phone.screenshot({ path: `${shotsDir}/phone-front.png`, fullPage: true });
await phone.fill("#answer-box", "The owner is accountable for the asset and approves definitions.");
await phone.click('[data-act="grade"]');
await phone.waitForSelector(".grade");
assert.match(await phone.textContent(".grade"), /steward/);
assert.equal(await phone.getAttribute(".rate-btn.suggested", "data-r"), "2");
await phone.click('.rate-btn.r1');
await phone.waitForFunction(() => window.__mock.docs.has("cards/gov-01"));
const day = await phone.evaluate(() => [...window.__mock.docs.keys()].find((k) => k.startsWith("reviews/")));
assert.ok(day, "review log written");
const log = await phone.evaluate((k) => window.__mock.docs.get(k).items[0], day);
assert.equal(log.c, "gov-01"); assert.equal(log.r, 1); assert.equal(log.g, 2); assert.ok(log.d > 0 && log.a.includes("owner"));
// Undo restores the card
await phone.click("#toast-act");
assert.equal((await phone.textContent(".callno")).trim(), "GOV·01");
assert.equal(await phone.evaluate((k) => window.__mock.docs.get(k).items.length, day), 0);
await phone.click('.rate-btn.r1');
// next card: concept, reveal without Claude, rate Good
await phone.waitForSelector('[data-act="reveal"]');
await phone.click('[data-act="reveal"]');
await phone.click('.rate-btn.r3');
// third card is a fact (MOD-01): no answer box until "Type it"
assert.equal(await phone.$("#answer-box"), null);
await phone.keyboard.press("Space");
await phone.waitForSelector(".rate");
if (shotsDir) await phone.screenshot({ path: `${shotsDir}/phone-back.png`, fullPage: true });
await phone.keyboard.press("3");

// 2. Catalog, explain, add, patterns, tuning, export (desktop, dark).
const desk = await newPage({ viewport: { width: 1180, height: 900 }, colorScheme: "dark", deviceScaleFactor: 1 });
await desk.evaluate(() => (location.hash = "catalog"));
await desk.click('[data-deck="gov"]');
await desk.click('[data-act="open"][data-id="gov-01"]');
assert.match(await desk.textContent(".cdetail"), /Custodian/);
await desk.evaluate(() => (location.hash = "add"));
await desk.fill("#add-note", "Lineage across Power BI and SQL Server needs matching server names.");
await desk.click('[data-act="draft"]');
await desk.waitForSelector(".drafts form");
assert.equal(await desk.locator(".drafts form").count(), 2);
await desk.locator('.drafts form button[type="submit"]').first().click();
assert.equal(await desk.locator(".drafts form").count(), 1);
assert.ok(await desk.evaluate(() => [...window.__mock.docs.keys()].some((k) => k.startsWith("custom/u-"))));
await desk.evaluate(() => (location.hash = "patterns"));
await desk.waitForSelector("text=What you keep missing");
await desk.click('form[data-form="flag"] button[type="submit"]');
assert.ok(await desk.evaluate(() => [...window.__mock.docs.keys()].some((k) => k.startsWith("flags/"))));
await desk.evaluate(() => (location.hash = "tuning"));
await desk.waitForSelector("table");
await desk.click('[data-act="export"]');
await desk.waitForFunction(() => window.__mock.saved.length === 1);
await desk.fill("#set-new", "7");
await desk.click('form[data-form="settings"] button[type="submit"]');
assert.equal(await desk.evaluate(() => window.__mock.docs.get("config/scheduler").newPerDay), 7);
if (shotsDir) { await desk.evaluate(() => (location.hash = "review")); await desk.waitForSelector(".index-card"); await desk.click('[data-act="reveal"]'); await desk.screenshot({ path: `${shotsDir}/desktop-dark.png` }); }

// 3. Explain flow for a missed card (seeded memory with misses).
const ex = await newPage({ viewport: { width: 800, height: 900 } }, true, () => {
  const now = Date.now();
  window.__mock.docs.set("cards/gov-01", { state: 2, step: null, stability: 2, difficulty: 7, due: now - 86400000, lastReview: now - 3 * 86400000, reps: 4, lapses: 1, agains: 2, suspended: false });
});
assert.equal((await ex.textContent(".callno")).trim(), "GOV·01", "overdue review comes before new cards");
await ex.evaluate(() => (location.hash = "catalog"));
await ex.click('[data-deck="gov"]');
await ex.click('[data-act="open"][data-id="gov-01"]');
await ex.click('.cdetail [data-act="explain"]');
await ex.waitForSelector(".tailored");
await ex.click('[data-act="contrast"]');
assert.ok(await ex.evaluate(() => window.__mock.docs.has("explanations/gov-01")));

// 4. No runtime at all (GitHub Pages / saved file): local mode still works.
const local = await newPage({ viewport: { width: 390, height: 800 } }, false);
assert.match(await local.textContent(".store"), /This browser only/);
await local.click('[data-act="reveal"]');
await local.click(".rate-btn.r3");
await local.waitForTimeout(400);
assert.ok(await local.evaluate(() => JSON.parse(localStorage.getItem("card-catalog:v1")).mem.length === 1));

await browser.close();
assert.deepEqual(errors, [], "console errors");
console.log("smoke ok: review+grade+undo, keyboard, catalog, draft, flag, tuning, export, explain, local mode");
