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
    if (prompt.startsWith("Grade one")) window.__mock.lastGrade = prompt;
    if (prompt.startsWith("Grade one") && prompt.includes("CARD (fact")) return { points: [{ i: 1, verdict: "hit", note: "" }], wrong: "", feedback: "Right.", rating: 3 };
    if (prompt.startsWith("Grade one")) return { points: [{ i: 1, verdict: "hit", note: "named accountability" }, { i: 2, verdict: "miss", note: "steward role missing" }], wrong: "", feedback: "You defined the owner but not the steward.", rating: 2 };
    if (prompt.startsWith("Write a fresh scenario")) return { prompt: "A hospital's lab team says naming a steward is extra work. What do you propose?" };
    if (prompt.startsWith("Assess an explanation")) return { accurate: { ok: true, note: "Correct." }, clear: { ok: false, note: "Uses 'steward' without defining it." }, fit: { ok: true, note: "Tied to cost." }, feedback: "Define steward in one phrase.", better: "Someone already answers questions about this data. We name them." };
    if (prompt.startsWith("Rewrite this spaced-repetition card")) { window.__mock.lastRewrite = prompt; return { kind: "judgment", prompt: "A team keeps two definitions of one metric. What do you do?", answer: "Name them distinctly and pick one for shared reporting.", points: ["distinct names", "one authoritative"], why: "Asks for application instead of recall." }; }
    if (prompt.startsWith("Draft new spaced-repetition cards")) { window.__mock.lastDeckDraft = prompt; return { cards: [{ kind: "concept", prompt: "Why separate policy from standard?", answer: "So details can change without re-approval.", points: ["stable policy", "changeable standard"], source: "Governance practice" }, { kind: "fact", prompt: "What does RACI's A require?", answer: "Exactly one accountable person." }] }; }
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
// the new deck order puts a strategy concept card next: answer it without Claude
assert.equal((await phone.textContent(".callno")).trim(), "STR·01");
await phone.click('[data-act="reveal"]');
await phone.click(".rate-btn.r3");
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
assert.match(await phone.textContent(".status"), /2 done · \d+ to go · 1 coming back/);
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

// Level calibration: mark, note, rewrite, accept; deck drafting carries the marks to Claude
const lv = await newPage({ viewport: { width: 800, height: 900 } });
await lv.click('[data-act="reveal"]');
const lvId = await lv.evaluate(() => document.querySelector('[data-act="level"]').dataset.id);
await lv.click('[data-act="level"][data-level="basic"]');
assert.equal(await lv.evaluate((id) => window.__mock.docs.get(`feedback/${id}`).level, lvId), "basic");
await lv.fill('form[data-form="level-note"] input', "I know the roles; test when they conflict");
await lv.click('form[data-form="level-note"] button[type="submit"]');
assert.match(await lv.evaluate((id) => window.__mock.docs.get(`feedback/${id}`).note, lvId), /conflict/);
await lv.click('[data-act="rewrite-level"]');
await lv.waitForSelector(".rewrite");
assert.match(await lv.evaluate(() => window.__mock.lastRewrite), /too basic[\s\S]*test when they conflict/);
await lv.click('[data-act="rewrite-accept"]');
const added = await lv.evaluate(() => [...window.__mock.docs.entries()].filter(([k]) => k.startsWith("custom/")).map(([, v]) => v));
assert.equal(added.length, 1);
assert.equal(added[0].replaces, lvId); assert.equal(added[0].verify, true); assert.equal(added[0].kind, "judgment");
assert.equal(await lv.evaluate((id) => window.__mock.docs.get(`cards/${id}`).suspended, lvId), true);
// clicking the same level again clears it
await lv.click('[data-act="level"][data-level="basic"]');
assert.equal(await lv.evaluate((id) => window.__mock.docs.get(`feedback/${id}`).level, lvId), null);
await lv.click('[data-act="level"][data-level="detailed"]');
await lv.evaluate(() => (location.hash = "catalog"));
const lvDeck = await lv.evaluate((id) => id.split("-")[0], lvId);
await lv.click(`[data-deck="${lvDeck}"]`);
assert.match(await lv.textContent(".panel"), /Your level marks here: 1 too detailed/);
await lv.click('[data-act="deck-draft"]');
await lv.waitForSelector(".drafts form");
assert.match(await lv.evaluate(() => window.__mock.lastDeckDraft), /Too detailed: trivia they don't need/);
assert.equal(await lv.inputValue(".drafts form input[name='source']"), "Governance practice");
await lv.locator('.drafts form button[type="submit"]').first().click();
const drafted = await lv.evaluate(() => [...window.__mock.docs.values()].filter((v) => v.origin === "Drafted by Claude for your level"));
assert.equal(drafted.length, 1); assert.equal(drafted[0].verify, true); assert.equal(drafted[0].source, "Governance practice");

// Focus a deck: the card on screen stays, the next new card comes from that deck
const fx = await newPage({ viewport: { width: 800, height: 900 } });
const onScreen = (await fx.textContent(".callno")).trim();
await fx.evaluate(() => (location.hash = "catalog"));
await fx.click('[data-deck="arc"]');
await fx.click('[data-act="focus-deck"]');
assert.deepEqual(await fx.evaluate(() => window.__mock.docs.get("config/scheduler").focusDecks), ["arc"]);
await fx.evaluate(() => (location.hash = "review"));
await fx.waitForSelector(".index-card");
assert.equal((await fx.textContent(".callno")).trim(), onScreen, "card on screen is kept");
await fx.click('[data-act="reveal"]');
await fx.click(".rate-btn.r3");
assert.equal((await fx.textContent(".callno")).trim(), "ARC·01");

// Same-day relearning: a second Partly comes back again today, and Claude diagnoses it first
const capPage = await newPage({ viewport: { width: 800, height: 900 } }, true, () => {
  const now = Date.now(), d = new Date(now - 4 * 3600000), p = (n) => String(n).padStart(2, "0");
  const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const item = (m) => ({ c: "gov-01", k: "concept", r: 2, t: now - m * 60000, st: 1, s: 1.29, e: 0, p: 1, i: null, d: 60000 });
  window.__mock.docs.set("cards/gov-01", { state: 1, step: 0, stability: 1.2931, difficulty: 5.1, due: now - 1000, lastReview: now - 10 * 60000, reps: 1, lapses: 0, agains: 0, suspended: false });
  window.__mock.docs.set(`reviews/${day}`, { day, items: [item(10)] });
  window.__seedDay = day; window.__item = item;
});
assert.equal((await capPage.textContent(".callno")).trim(), "GOV·01", "the retry comes up first");
await capPage.fill("#answer-box", "The owner is accountable.");
await capPage.click('[data-act="grade"]');
await capPage.waitForSelector(".tailored");
assert.match(await capPage.textContent(".tailored"), /swap steward and custodian/, "second shaky answer gets a diagnosis");
assert.match(await capPage.textContent(".rate-btn.next"), /20m/, "a second Partly comes back again today, 20 minutes later");
await capPage.click(".rate-btn.next");
assert.equal(await capPage.evaluate(() => window.__mock.docs.get("cards/gov-01").state), 1);
// Fourth showing of the day: whatever the rating short of a full recall, it goes to tomorrow
const lastPage = await newPage({ viewport: { width: 800, height: 900 } }, true, () => {
  const now = Date.now(), d = new Date(now - 4 * 3600000), p = (n) => String(n).padStart(2, "0");
  const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const item = (m) => ({ c: "gov-01", k: "concept", r: 2, t: now - m * 60000, st: 1, s: 1.29, e: 0, p: 1, i: null, d: 60000 });
  window.__mock.docs.set("cards/gov-01", { state: 1, step: 0, stability: 1.2931, difficulty: 7, due: now - 1000, lastReview: now - 20 * 60000, reps: 3, lapses: 0, agains: 0, suspended: false });
  window.__mock.docs.set(`reviews/${day}`, { day, items: [item(60), item(50), item(20)] });
});
await lastPage.click('[data-act="reveal"]');
assert.match(await lastPage.textContent(".rate-btn.r2"), /1d/);
await lastPage.click(".rate-btn.r2");
assert.match(await lastPage.textContent("#toast"), /comes back tomorrow/);
assert.equal(await lastPage.evaluate(() => window.__mock.docs.get("cards/gov-01").state), 2);

// Fresh scenario on a judgment card seen before, graded against the same key points; then teach-back in Study
const vp = await newPage({ viewport: { width: 800, height: 900 } }, true, () => {
  const now = Date.now();
  window.__mock.docs.set("cards/gov-08", { state: 2, step: null, stability: 3, difficulty: 6, due: now - 86400000, lastReview: now - 4 * 86400000, reps: 2, lapses: 0, agains: 0, suspended: false });
});
await vp.waitForSelector(".variant-note");
assert.match(await vp.textContent(".prompt"), /hospital's lab team/);
await vp.fill("#answer-box", "Name the person who already answers questions and shrink the ask.");
await vp.click('[data-act="grade"]');
await vp.waitForSelector(".grade");
assert.match(await vp.evaluate(() => window.__mock.lastGrade), /SCENARIO: A hospital's lab team[\s\S]*Name the person who already answers/);
assert.match(await vp.textContent(".variant-note"), /The card's own question: A department head says/);
await vp.click('[data-act="study-save"]');
await vp.click('[data-act="override"]');
await vp.click(".rate-btn.r3");
const vday = await vp.evaluate(() => [...window.__mock.docs.keys()].find((k) => k.startsWith("reviews/")));
assert.equal(await vp.evaluate((k) => window.__mock.docs.get(k).items[0].v, vday), 1);
await vp.evaluate(() => (location.hash = "study"));
await vp.click('.cardlist [data-act="study-open"][data-id="gov-08"]');
await vp.selectOption("#ta-gov-08", "a new analyst on your team");
await vp.fill("#tt-gov-08", "Someone already answers questions about this data, so we name them steward.");
await vp.click('form[data-form="teach"] button[type="submit"]');
await vp.waitForSelector(".teach-result");
assert.match(await vp.textContent(".teach-result"), /to a new analyst on your team[\s\S]*Clear: not yet[\s\S]*A stronger version/);
assert.equal(await vp.evaluate(() => window.__mock.docs.get("teachbacks/gov-08").items.length), 1);

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
