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
  const sample = async (input, opts = {}) => {
    const last = Array.isArray(input) ? input[input.length - 1].content : input;
    replies.push(String(last).slice(0, 60));
    const text = Array.isArray(input) ? "Because **each fact** lives in one place.\n- one\n- two" : "### Why it matters\nStoring a fact once means **one** place to change it.\n- Update anomaly\n- Insert anomaly";
    opts.onText?.({ text, delta: text });
    return { text, truncated: false };
  };
  sample.json = async (prompt, opts = {}) => {
    replies.push(prompt.slice(0, 60) + (opts.modelTier ? ` [${opts.modelTier}]` : ""));
    if (prompt.startsWith("Grade one") && prompt.includes("CARD (fact")) return { points: [{ i: 1, verdict: "hit", note: "" }], wrong: "", feedback: "Right.", rating: 3 };
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
assert.match(await phone.textContent(".verdict"), /Partly right/);
// Claude's rating is applied by default; overriding shows the four plain-language choices
assert.equal(await phone.getAttribute(".rate-btn.next", "data-r"), "2");
await phone.click('[data-act="override"]');
assert.equal(await phone.locator(".rate-btn").count(), 4);
assert.match(await phone.textContent(".rate-btn.r1"), /Didn't know/);
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
assert.equal(await phone.getAttribute(".rate-btn.next", "data-r"), "2", "undo restores Claude's rating");
await phone.click('[data-act="override"]');
await phone.click('.rate-btn.r1');
// next card is a fact: it gets graded too (quick tier), and Next accepts Claude's rating
assert.equal((await phone.textContent(".callno")).trim(), "MET·01");
assert.ok(await phone.isDisabled('[data-act="grade"]'), "grading needs an answer");
await phone.fill("#answer-box", "The business glossary");
await phone.click('[data-act="grade"]');
await phone.waitForSelector(".rate-btn.next");
assert.ok(await phone.evaluate(() => window.__mock.replies.some((r) => r.includes("[quick]"))), "facts graded on the quick tier");
// Why this timing? explains the schedule for this card
await phone.click(".why-timing summary");
assert.match(await phone.textContent(".why-timing"), /first time answering this card[\s\S]*counts as "Knew it"/);
// Go deeper streams, saves, and takes follow-ups
await phone.click('[data-act="deep"]');
await phone.waitForSelector(".deep .md-h");
assert.match(await phone.textContent(".deep"), /Why it matters/);
await phone.fill('input[name="q"]', "Why not just one table?");
await phone.click('form[data-form="followup"] button[type="submit"]');
await phone.waitForSelector(".fq .q");
assert.equal(await phone.evaluate(() => window.__mock.docs.get("deepdives/met-01").followups.length), 1);
if (shotsDir) await phone.screenshot({ path: `${shotsDir}/phone-graded.png`, fullPage: true });
// Study: open the card there, keep asking, come back to the same review card
assert.match(await phone.textContent(".deep-note"), /waits until you press Next/);
await phone.click('.row [data-act="study-open"]');
await phone.waitForSelector(".study-detail .deep");
assert.match(await phone.textContent(".panel"), /Your review is paused on/);
await phone.fill('.study-detail input[name="q"]', "Give me an example");
await phone.click('.study-detail form[data-form="followup"] button[type="submit"]');
await phone.waitForFunction(() => window.__mock.docs.get("deepdives/met-01").followups.length === 2);
if (shotsDir) await phone.screenshot({ path: `${shotsDir}/study-phone.png`, fullPage: true });
assert.equal(await phone.evaluate(() => window.__mock.docs.get("study/met-01").removed), false);
await phone.evaluate(() => (location.hash = "review"));
await phone.waitForSelector(".rate-btn.next");
assert.equal((await phone.textContent(".callno")).trim(), "MET·01", "review card waited");
await phone.click(".rate-btn.next");
assert.match(await phone.textContent(".status"), /1 done · \d+ to go · 1 coming back/);
await phone.click('[data-act="reveal"]');
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

// Guide: chart is drawn from the real scheduler, has a hover readout, and a table view
const guide = await newPage({ viewport: { width: 390, height: 900 }, deviceScaleFactor: 1 });
await guide.evaluate(() => (location.hash = "guide"));
await guide.waitForSelector("#curve svg .ln.s1");
assert.ok((await guide.getAttribute("#curve svg .ln.s1", "d")).length > 500);
assert.equal(await guide.locator("#curve .dot").count(), await guide.locator(".guide table").first().locator("tbody tr").count() - 1);
await guide.locator("#curve").scrollIntoViewIfNeeded();
const box = await guide.locator("#curve svg").boundingBox();
await guide.mouse.move(box.x + box.width * 0.5, box.y + 60);
await guide.waitForSelector(".curve-tip:not([hidden])");
assert.match(await guide.textContent(".curve-tip"), /Day \d+[\s\S]*With reviews[\s\S]*Without reviews/);
assert.equal(await guide.locator(".tab").count(), 5);
assert.equal(await guide.locator(".guide-link.on").count(), 1);
if (shotsDir) await guide.screenshot({ path: `${shotsDir}/guide-phone.png`, fullPage: true });
const guideDark = await newPage({ viewport: { width: 1100, height: 900 }, colorScheme: "dark", deviceScaleFactor: 1 });
await guideDark.evaluate(() => (location.hash = "guide"));
await guideDark.waitForSelector("#curve svg");
await guideDark.locator("#curve").scrollIntoViewIfNeeded();
const b2 = await guideDark.locator("#curve svg").boundingBox();
await guideDark.mouse.move(b2.x + b2.width * 0.3, b2.y + 80);
if (shotsDir) await guideDark.screenshot({ path: `${shotsDir}/guide-dark.png` });

// Reload keeps the card in progress, including a half-typed answer
const rl = await newPage({ viewport: { width: 390, height: 800 } });
const rlCard = (await rl.textContent(".callno")).trim();
await rl.fill("#answer-box", "half-typed thought");
await rl.waitForTimeout(500);
await rl.reload();
await rl.waitForSelector("#answer-box");
assert.equal((await rl.textContent(".callno")).trim(), rlCard);
assert.equal(await rl.inputValue("#answer-box"), "half-typed thought");
// Study later from the back of a card
await rl.click('[data-act="reveal"]');
await rl.click('[data-act="study-save"]');
assert.match(await rl.textContent('.tab[href="#study"]'), /Study 1/);

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
