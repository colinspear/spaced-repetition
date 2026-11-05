// Card Catalog UI. Built into one page by build.mjs (imports are stripped there;
// fsrs.js and engine.js are concatenated ahead of this file).
import { State, DAY } from "./fsrs.js";
import {
  mergeConfig, dayKey, blankMemory, isNew, isLearning, schedulerFor, buildQueue, nextCard, applyRating,
  previewIntervals, fmtInterval, calibration, fitScale, forecast, currentR, isPersistentMiss, isLeech,
} from "./engine.js";

const DECKS = __DECKS__;
const BUILD = "__BUILD__";
const INBOX = { deck: "inb", code: "INB", title: "Inbox", blurb: "Cards you added, or accepted from Claude.", cards: [] };
const DECK_META = new Map([...DECKS, INBOX].map((d) => [d.deck, d]));
const LEARNER =
  "a data management leader in a mid-size US city government: chairs a citywide data governance committee and analyst community, " +
  "implements a data catalog over on-prem SQL Server, SSIS and Power BI, and trains city staff. Economist by training. " +
  "Wants terse, precise, non-sycophantic explanations; skip basics they already know.";
const LS_KEY = "card-catalog:v1";
const RATING = { 1: "Again", 2: "Hard", 3: "Good", 4: "Easy" };
const VIEWS = ["review", "catalog", "add", "patterns", "tuning"];
const VIEW_LABEL = { review: "Review", catalog: "Catalog", add: "Add", patterns: "Patterns", tuning: "Tuning" };

const S = {
  mode: "loading", // loading | db | local | unreachable
  db: null, sample: null, downloads: null, claudeOff: false,
  config: mergeConfig(null), sched: null,
  cards: [], byId: new Map(),
  mem: new Map(), logs: new Map(), expl: new Map(), custom: new Map(), flags: [], insights: null,
  view: "review", session: null, unsaved: false,
  cat: { deck: null, q: "", open: null, flagFor: null },
  add: { note: "", deck: "inb", drafts: [], busy: false, err: "", manual: { kind: "fact", prompt: "", answer: "", points: "" } },
  pat: { busy: false, err: "", topic: "" },
  busy: new Set(), errs: new Map(),
};

// ---------- small utilities ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\n/g, "<br>");
const pct = (x) => (x == null || Number.isNaN(x) ? "–" : `${Math.round(x * 100)}%`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = (p) => `${p}-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, "0")}`;
const clone = (x) => (x == null ? x : structuredClone(x));
function withTimeout(p, ms = 10000) {
  let t;
  return Promise.race([p, new Promise((_, rej) => (t = setTimeout(() => rej({ code: "timeout" }), ms)))]).finally(() => clearTimeout(t));
}
const deckCode = (deck) => DECK_META.get(deck)?.code || deck.toUpperCase();
const callNumber = (c) => (c.custom && !/^[a-z]{3}-\d+$/.test(c.id) ? `${deckCode(c.deck)}·${c.id.slice(-4).toUpperCase()}` : c.id.toUpperCase().replace("-", "·"));
const roll = () => S.config.rolloverHour;
const today = () => dayKey(Date.now(), roll());

let toastTimer;
function toast(msg, action) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button" id="toast-act">${esc(action.label)}</button>` : ""}`;
  el.hidden = false;
  if (action) document.getElementById("toast-act").onclick = () => { el.hidden = true; action.fn(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), action ? 6000 : 3000);
}

// ---------- persistence ----------
const pendingW = new Map();
const inflightW = new Set();
function persist(path, data) {
  if (S.mode === "db") {
    pendingW.set(path, clone(data));
    if (!inflightW.has(path)) drain(path);
  } else if (S.mode === "local") saveLocalSoon();
}
async function drain(path) {
  inflightW.add(path);
  while (pendingW.has(path)) {
    const data = pendingW.get(path);
    pendingW.delete(path);
    try {
      await S.db.doc(path).set(data);
    } catch (e) {
      if (e?.code === "unavailable") {
        await sleep(800 + Math.random() * 1200);
        try { await S.db.doc(path).set(data); continue; } catch (e2) { writeFailed(e2); continue; }
      }
      writeFailed(e);
    }
  }
  inflightW.delete(path);
}
function writeFailed(e) {
  S.unsaved = true;
  toast(e?.code === "quota_exceeded"
    ? "Storage is full. Export your data from Tuning, then resolve old flags."
    : "A change didn't save. It's still on this screen; export from Tuning before closing.");
  renderStatus();
}
let localTimer;
function saveLocalSoon() {
  clearTimeout(localTimer);
  localTimer = setTimeout(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        mem: [...S.mem], logs: [...S.logs], expl: [...S.expl], custom: [...S.custom], flags: S.flags, config: S.config, insights: S.insights,
      }));
    } catch { S.unsaved = true; renderStatus(); }
  }, 250);
}
function loadLocal() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    S.mem = new Map(d.mem || []); S.logs = new Map(d.logs || []); S.expl = new Map(d.expl || []);
    S.custom = new Map(d.custom || []); S.flags = d.flags || []; S.config = mergeConfig(d.config); S.insights = d.insights || null;
  } catch { /* private window or blocked storage: start empty */ }
}
async function loadDb() {
  const col = async (name) => (await withTimeout(S.db.collection(name).get())).docs;
  const [cards, reviews, expl, custom, flags, cfg, ins] = await Promise.all([
    col("cards"), col("reviews"), col("explanations"), col("custom"), col("flags"),
    withTimeout(S.db.doc("config/scheduler").get()), withTimeout(S.db.doc("insights/latest").get()),
  ]);
  S.mem = new Map(cards.map((d) => [d.id, clone(d.data())]));
  S.logs = new Map(reviews.map((d) => [d.id, clone(d.data().items || [])]));
  S.expl = new Map(expl.map((d) => [d.id, clone(d.data())]));
  S.custom = new Map(custom.map((d) => [d.id, clone(d.data())]));
  S.flags = flags.map((d) => ({ id: d.id, ...clone(d.data()) }));
  S.config = mergeConfig(cfg.exists ? clone(cfg.data()) : null);
  S.insights = ins.exists ? clone(ins.data()) : null;
}

function assembleCards() {
  const map = new Map();
  for (const d of DECKS) for (const c of d.cards) map.set(c.id, { ...c, deck: d.deck });
  for (const [id, cu] of S.custom) {
    if (cu.deleted) { map.delete(id); continue; }
    const base = map.get(id);
    map.set(id, { ...(base || {}), ...cu, id, deck: cu.deck || base?.deck || "inb", custom: !base, edited: !!base });
  }
  S.cards = [...map.values()];
  S.byId = map;
}

// ---------- Claude ----------
function claudeReady() { return !!S.sample && !S.claudeOff; }
function sampleError(e) {
  switch (e?.code) {
    case "not_granted": case "sampling_disabled": case "not_declared": case "capability_disabled": case "capability_removed":
      S.claudeOff = true;
      return "Claude isn't available on this page right now, so grade yourself.";
    case "rate_limited": return "Too many Claude requests just now. Try again in a minute.";
    case "session_expired": return "Sign in to Claude again, then retry.";
    case "invalid_json": return "Claude's reply didn't parse. Try again.";
    case "refused": return "Claude declined this one.";
    case "prompt_too_large": return "Too much text for one request. Shorten it.";
    case "cancelled": return "";
    default: return "Couldn't reach Claude. Try again.";
  }
}
async function ask(key, prompt, opts = {}) {
  S.busy.add(key); S.errs.delete(key); render();
  const t = performance.now();
  try {
    return await S.sample.json(prompt, { modelTier: "default", ...opts });
  } catch (e) {
    const msg = sampleError(e);
    if (msg) S.errs.set(key, msg);
    return null;
  } finally {
    S.busy.delete(key);
    if (S.session?.current && key.endsWith(S.session.current)) S.session.waitMs += performance.now() - t;
    render();
  }
}
function attemptsFor(id) {
  const out = [];
  for (const [day, items] of S.logs) for (const l of items) if (l.c === id) out.push({ day, ...l });
  return out.sort((a, b) => a.t - b.t);
}
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
function cardBlock(c) {
  return `CARD (${c.kind}, deck "${DECK_META.get(c.deck)?.title || c.deck}"): ${c.prompt}\nREFERENCE ANSWER: ${c.answer}` +
    (c.points?.length ? `\nKEY POINTS:\n${c.points.map((p, i) => `${i + 1}. ${p}`).join("\n")}` : "") +
    (c.why ? `\nNOTE: ${c.why}` : "");
}
function gradePrompt(c, typed) {
  return `Grade one spaced-repetition answer. The learner is ${LEARNER}
Grade substance, not wording. Be strict but fair. Partial credit is allowed.

${cardBlock(c)}

LEARNER'S ANSWER:
"""${typed}"""

Rating scale: 1 = missed the core idea or stated something false; 2 = core idea present but important points missing or shaky; 3 = core idea and most points; 4 = complete and precise.
Reply with only JSON:
{"points":[{"i":1,"verdict":"hit|partial|miss","note":"at most 12 words"}],"wrong":"a false claim in their answer, or empty string","feedback":"at most 50 words, second person, no praise padding","rating":3}
Include one entry in "points" per key point${c.points?.length ? "" : " (treat the reference answer as a single point)"}.`;
}
function explainPrompt(c, attempts) {
  const tries = attempts.map((a) => `- ${a.day}, rated ${RATING[a.r]}${a.g ? ` (grader suggested ${RATING[a.g]})` : ""}: ${a.a ? `"${clip(a.a, 500)}"` : "(answered in their head; no typed answer)"}`).join("\n");
  const near = S.cards.filter((x) => x.deck === c.deck && x.id !== c.id && !x.retired).slice(0, 8)
    .map((x) => `- ${x.id}: ${clip(x.prompt, 140)} => ${clip(x.answer, 160)}`).join("\n");
  return `A learner keeps missing this spaced-repetition card. Find the specific misconception behind their attempts and fix it.
Learner: ${LEARNER}

${cardBlock(c)}

THEIR ATTEMPTS (oldest first):
${tries || "- none recorded"}

OTHER CARDS IN THE SAME DECK (look for interference or confusable pairs):
${near || "- none"}

Write for someone who knows the field. No definitions of basics, no pep talk. If attempts have no typed text, infer the likely confusion from the card and its neighbours and say that you are inferring.
Reply with only JSON:
{"diagnosis":"1-2 sentences: what they get wrong and why it is tempting","explanation":"at most 120 words","hook":"one memorable handle: a sharp contrast, a concrete city example, or a mnemonic","contrast_card":{"prompt":"...","answer":"..."},"rewrite":null}
Set "contrast_card" to null unless a discrimination card would help. Set "rewrite" to {"prompt","answer"} only if the card itself is ambiguous or overloaded.`;
}
function patternsPrompt(missed) {
  const body = missed.map(({ c, m, tries }) =>
    `[${c.id}] deck=${c.deck} kind=${c.kind} agains=${m.agains} lapses=${m.lapses}\nQ: ${clip(c.prompt, 220)}\nA: ${clip(c.answer, 260)}\nTheir attempts: ${tries.filter((t) => t.r <= 2).map((t) => (t.a ? `"${clip(t.a, 160)}"` : "(untyped)")).slice(-3).join(" | ") || "(untyped)"}`).join("\n\n");
  return `Here is a learner's miss history in a spaced-repetition collection. Look for patterns across cards, not card-by-card fixes.
Learner: ${LEARNER}
Deck keys: ${[...DECK_META.values()].map((d) => `${d.deck}=${d.title}`).join("; ")}

MISSED CARDS:
${body}

Reply with only JSON:
{"summary":"at most 80 words","patterns":[{"title":"...","cards":["id"],"explanation":"at most 70 words"}],"confusions":[{"a":"id","b":"id","why":"..."}],"new_cards":[{"deck":"gov","kind":"fact","prompt":"...","answer":"...","points":[]}],"rewrite_or_retire":[{"id":"...","why":"..."}]}
At most 4 patterns and 5 new cards. Concept and judgment cards need 2-5 points.`;
}
function draftPrompt(note) {
  return `Turn this note into spaced-repetition cards for the learner.
Learner: ${LEARNER}
Rules: each card tests one idea; the prompt is precise and has one consistent answer; no yes/no prompts; nothing they would not need at work; prefer why/how/when over bare what when the note supports it. Use only what the note states or directly implies. Add no outside facts.
Kinds: "fact" (short recall), "concept" (explain in a few sentences; give 2-5 points), "judgment" (a realistic scenario needing a decision; give 3-5 points).

NOTE:
"""${note}"""

Reply with only JSON: {"cards":[{"kind":"fact","prompt":"...","answer":"...","points":[]}]}
At most 5 cards. If nothing in the note is worth remembering, reply {"cards":[]}.`;
}
const str = (x, n = 2000) => (typeof x === "string" ? x.slice(0, n) : "");
function cleanCard(x) {
  if (!x || typeof x !== "object") return null;
  const kind = ["fact", "concept", "judgment"].includes(x.kind) ? x.kind : "fact";
  const prompt = str(x.prompt, 400).trim(), answer = str(x.answer, 1500).trim();
  if (!prompt || !answer) return null;
  const points = Array.isArray(x.points) ? x.points.map((p) => str(p, 200).trim()).filter(Boolean).slice(0, 6) : [];
  return { kind, prompt, answer, points, deck: DECK_META.has(x.deck) ? x.deck : undefined };
}

// ---------- session ----------
function todayCounts() {
  const items = S.logs.get(today()) || [];
  return { reviews: items.filter((l) => l.st === State.Review).length, news: items.filter((l) => l.st === 0).length };
}
function startSession() {
  const now = Date.now();
  const q = buildQueue({ cards: S.cards, mem: S.mem, now, config: S.config, today: todayCounts(), sched: S.sched });
  S.session = { queue: q.queue, counts: q.counts, lastId: null, current: null, reviewed: 0, passed: 0, undo: null };
  advance(false);
}
function advance(doRender = true) {
  const sess = S.session;
  const nx = nextCard({ queue: sess.queue, cards: S.cards, mem: S.mem, now: Date.now(), lastId: sess.lastId });
  Object.assign(sess, { current: nx?.id || null, from: nx?.from, phase: "front", typed: "", grade: null, typing: false, t0: performance.now(), waitMs: 0, hiddenMs: 0 });
  if (doRender) render();
}
function remaining() {
  const sess = S.session;
  const learning = S.cards.filter((c) => isLearning(S.mem.get(c.id)) && !S.mem.get(c.id).suspended && !sess.queue.includes(c.id)).length;
  return sess.queue.length + learning;
}
function reveal() { if (S.session.current) { S.session.phase = "back"; render(); } }
async function grade() {
  const sess = S.session, c = S.byId.get(sess.current);
  if (!c || !sess.typed.trim() || !claudeReady()) return;
  const g = await ask(`grade:${c.id}`, gradePrompt(c, sess.typed.trim()));
  if (S.session !== sess || sess.current !== c.id) return;
  if (g) {
    const pts = Array.isArray(g.points) ? g.points : [];
    sess.grade = {
      points: pts.map((p) => ({ i: Number(p?.i) || 0, verdict: ["hit", "partial", "miss"].includes(p?.verdict) ? p.verdict : "miss", note: str(p?.note, 140) })),
      wrong: str(g.wrong, 300), feedback: str(g.feedback, 500), rating: [1, 2, 3, 4].includes(Number(g.rating)) ? Number(g.rating) : null,
    };
    sess.phase = "back";
  }
  render();
}
function rate(r) {
  const sess = S.session, c = S.byId.get(sess.current);
  if (!c || sess.phase !== "back") return;
  const now = Date.now();
  const prev = S.mem.get(c.id);
  const res = applyRating({ mem: prev, card: c, rating: r, now, config: S.config, sched: S.sched });
  res.log.d = Math.round(Math.min(Math.max(performance.now() - sess.t0 - sess.waitMs - sess.hiddenMs, 300), 600000));
  if (sess.typed.trim()) res.log.a = sess.typed.trim().slice(0, 600);
  if (sess.grade?.rating) res.log.g = sess.grade.rating;
  S.mem.set(c.id, res.mem);
  persist(`cards/${c.id}`, res.mem);
  const key = dayKey(now, roll());
  const items = S.logs.get(key) || [];
  items.push(res.log);
  S.logs.set(key, items);
  persist(`reviews/${key}`, { day: key, items });
  sess.undo = { id: c.id, prev: clone(prev), key, queue: sess.queue.slice(), reviewed: sess.reviewed, passed: sess.passed, typed: sess.typed, grade: sess.grade };
  sess.queue = sess.queue.filter((id) => id !== c.id);
  sess.reviewed++;
  if (r > 1) sess.passed++;
  sess.lastId = c.id;
  toast(`${RATING[r]}. Next in ${fmtInterval(res.intervalMs)}.`, { label: "Undo", fn: undoLast });
  advance();
}
function undoLast() {
  const sess = S.session, u = sess?.undo;
  if (!u) return;
  const restored = u.prev || blankMemory(Date.now());
  S.mem.set(u.id, restored);
  persist(`cards/${u.id}`, restored);
  const items = S.logs.get(u.key) || [];
  for (let i = items.length - 1; i >= 0; i--) if (items[i].c === u.id) { items.splice(i, 1); break; }
  persist(`reviews/${u.key}`, { day: u.key, items });
  Object.assign(sess, { queue: u.queue, reviewed: u.reviewed, passed: u.passed, undo: null, current: u.id, phase: "back", typed: u.typed, grade: u.grade, t0: performance.now(), waitMs: 0, hiddenMs: 0 });
  render();
}
async function explain(id) {
  const c = S.byId.get(id);
  if (!c || !claudeReady()) return;
  const x = await ask(`explain:${id}`, explainPrompt(c, attemptsFor(id)));
  if (!x) return;
  const cc = cleanCard(x.contrast_card ? { ...x.contrast_card, kind: "fact" } : null);
  const rw = cleanCard(x.rewrite ? { ...x.rewrite, kind: c.kind, points: c.points } : null);
  const rec = { diagnosis: str(x.diagnosis, 600), explanation: str(x.explanation, 1400), hook: str(x.hook, 300), contrast: cc, rewrite: rw, at: Date.now(), attempts: attemptsFor(id).length };
  S.expl.set(id, rec);
  persist(`explanations/${id}`, rec);
  render();
}
function addCustom(card, origin, deck) {
  const id = uid("u");
  const rec = { id, deck: deck || card.deck || "inb", kind: card.kind, prompt: card.prompt, answer: card.answer, points: card.points || [], source: card.source || `${origin}, ${today()}`, origin, createdAt: Date.now() };
  S.custom.set(id, rec);
  persist(`custom/${id}`, rec);
  assembleCards();
  return id;
}
function useRewrite(id) {
  const x = S.expl.get(id);
  if (!x?.rewrite) return;
  const base = S.byId.get(id);
  const rec = { ...(S.custom.get(id) || {}), prompt: x.rewrite.prompt, answer: x.rewrite.answer, points: base.points || [], origin: "rewrite", editedAt: Date.now() };
  S.custom.set(id, rec);
  persist(`custom/${id}`, rec);
  x.rewrite = null;
  persist(`explanations/${id}`, x);
  assembleCards();
  toast("Card rewritten. Its review history is kept.");
  render();
}
function addContrast(id) {
  const x = S.expl.get(id);
  if (!x?.contrast) return;
  addCustom({ ...x.contrast, deck: S.byId.get(id).deck }, `Contrast card for ${id}`);
  x.contrast = null;
  persist(`explanations/${id}`, x);
  toast("Contrast card added. It shows up as a new card.");
  render();
}
function setSuspended(id, on) {
  const m = { ...(S.mem.get(id) || blankMemory(Date.now())), suspended: on };
  S.mem.set(id, m);
  persist(`cards/${id}`, m);
  if (on && S.session) S.session.queue = S.session.queue.filter((q) => q !== id);
  if (on && S.session?.current === id) advance(false);
  render();
}
function saveFlag(card, reason, note) {
  const f = { id: uid("f"), card: card || null, reason, note: str(note, 1000), at: Date.now(), resolved: false, build: BUILD };
  S.flags.push(f);
  persist(`flags/${f.id}`, f);
  toast("Flag saved. Claude reads these when you ask it to review your learning.");
}

// ---------- rendering ----------
function render() {
  const root = document.getElementById("app");
  if (!root) return;
  if (S.mode === "loading") { root.innerHTML = `<p class="loading">Opening the catalog…</p>`; return; }
  if (S.mode === "unreachable") {
    root.innerHTML = `<section class="panel"><h2>Your saved reviews can't be reached yet</h2><p>Check your connection, then try again. Nothing has been lost.</p><button type="button" class="btn primary" data-act="retry-load">Try again</button></section>`;
    return;
  }
  const v = S.view;
  root.innerHTML = `${nav()}<div id="status-slot">${statusLine()}</div><main id="view">${{ review: viewReview, catalog: viewCatalog, add: viewAdd, patterns: viewPatterns, tuning: viewTuning }[v]()}</main>`;
  const ta = document.getElementById("answer-box");
  if (ta && S.session?.typing) ta.focus();
}
function renderStatus() { const el = document.getElementById("status-slot"); if (el) el.innerHTML = statusLine(); }
function nav() {
  return `<header class="top"><div class="brand"><span class="brand-mark" aria-hidden="true"></span><span>Card Catalog</span></div>
<nav class="tabs" aria-label="Views">${VIEWS.map((v) => `<a href="#${v}" class="tab${S.view === v ? " on" : ""}"${S.view === v ? ' aria-current="page"' : ""}>${VIEW_LABEL[v]}</a>`).join("")}</nav></header>`;
}
function statusLine() {
  const store = S.mode === "db" ? "Saved to your account" : "This browser only";
  const c = S.session?.counts;
  const due = c ? `<span><b>${remaining()}</b> left today</span>${c.backlog ? `<span class="warn-chip" title="Cards over today's review cap wait without penalty. The ones losing ground fastest are shown first."><b>${c.backlog}</b> waiting</span>` : ""}` : "";
  return `<div class="status"><span class="mono">${esc(today())}</span>${due}<span class="store${S.mode === "db" ? "" : " local"}">${store}</span>${S.unsaved ? `<span class="warn-chip">Unsaved changes</span>` : ""}${claudeReady() ? "" : `<span class="muted-chip">Claude off</span>`}</div>`;
}
function kindChip(c) { return `<span class="chip kind-${c.kind}">${c.kind}</span>`; }
function cardHead(c) {
  const d = DECK_META.get(c.deck);
  return `<div class="card-head"><span class="callno">${esc(callNumber(c))}</span>${kindChip(c)}<span class="deck-name">${esc(d?.title || c.deck)}</span>${c.verify ? `<span class="chip verify" title="Not fully certain. Check the source before relying on it.">verify</span>` : ""}${c.edited ? `<span class="chip">edited</span>` : ""}</div>`;
}
function viewReview() {
  const sess = S.session;
  const c = sess?.current && S.byId.get(sess.current);
  if (!c) return doneScreen();
  const m = S.mem.get(c.id);
  const typedKinds = c.kind !== "fact";
  const busyGrade = S.busy.has(`grade:${c.id}`);
  const front = `<article class="index-card" aria-label="Card ${esc(callNumber(c))}">${cardHead(c)}
<div class="ruled"><p class="prompt">${fmt(c.prompt)}</p></div>
${sess.phase === "front" ? frontControls(c, typedKinds, busyGrade) : backSide(c, m)}
</article>`;
  const left = remaining();
  const done = sess.reviewed;
  const total = done + left;
  return `${front}<div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}"><span style="width:${total ? (done / total) * 100 : 0}%"></span></div>
<p class="hint mono">${done} done · ${left} left${sess.from === "learning" || sess.from === "ahead" ? " · relearning step" : isNew(m) ? " · new card" : ""}</p>`;
}
function frontControls(c, typedKinds, busy) {
  const sess = S.session;
  const showBox = typedKinds || sess.typing;
  const err = S.errs.get(`grade:${c.id}`);
  return `<div class="answer-zone">
${showBox ? `<label class="lbl" for="answer-box">${c.kind === "judgment" ? "What would you do?" : c.kind === "concept" ? "Explain it" : "Your answer"}</label>
<textarea id="answer-box" rows="${c.kind === "fact" ? 2 : 5}" placeholder="${c.kind === "fact" ? "Type it, or just think it" : "Write it out. Claude grades it against the key points."}">${esc(sess.typed)}</textarea>` : ""}
<div class="row">
${typedKinds && claudeReady() ? `<button type="button" class="btn primary" data-act="grade" ${busy ? "disabled" : ""}>${busy ? "Claude is reading…" : "Check with Claude"}</button>` : ""}
<button type="button" class="btn${typedKinds && claudeReady() ? "" : " primary"}" data-act="reveal">Show answer</button>
${!typedKinds && !sess.typing ? `<button type="button" class="btn ghost" data-act="type">Type it</button>` : ""}
</div>${err ? `<p class="err">${esc(err)}</p>` : ""}<p class="keys">Space shows the answer · 1–4 rate · Ctrl+Enter checks with Claude</p></div>`;
}
function backSide(c, m) {
  const sess = S.session;
  const g = sess.grade;
  const prev = previewIntervals({ mem: m, card: c, now: Date.now(), config: S.config });
  const x = S.expl.get(c.id);
  const missed = (m?.agains || 0) >= 1;
  const busyX = S.busy.has(`explain:${c.id}`);
  const errX = S.errs.get(`explain:${c.id}`);
  const points = c.points?.length
    ? `<ol class="points">${c.points.map((p, i) => { const v = g?.points?.find((q) => q.i === i + 1); return `<li class="${v ? "v-" + v.verdict : ""}"><span>${fmt(p)}</span>${v ? `<em>${esc(v.verdict)}${v.note ? ": " + esc(v.note) : ""}</em>` : ""}</li>`; }).join("")}</ol>` : "";
  return `<div class="back">
${sess.typed.trim() ? `<div class="yours"><span class="lbl">You wrote</span><p>${fmt(sess.typed.trim())}</p></div>` : ""}
${g ? `<div class="grade"><span class="lbl">Claude's read</span><p>${esc(g.feedback)}</p>${g.wrong ? `<p class="wrong"><b>Not right:</b> ${esc(g.wrong)}</p>` : ""}</div>` : ""}
<div class="answer"><span class="lbl">Answer</span><p>${fmt(c.answer)}</p>${points}${c.why ? `<p class="why">${fmt(c.why)}</p>` : ""}</div>
${x ? explanationBlock(c, x) : ""}
<p class="source">Source: ${esc(c.source || "—")}</p>
<div class="row small">
${claudeReady() && (missed || x) ? `<button type="button" class="btn ${isPersistentMiss(m) && !x ? "primary" : "ghost"}" data-act="explain" data-id="${c.id}" ${busyX ? "disabled" : ""}>${busyX ? "Claude is diagnosing…" : x ? "Re-diagnose" : `You've missed this ${m.agains}×. Explain it to me`}</button>` : ""}
<button type="button" class="btn ghost" data-act="flag-open" data-id="${c.id}">Flag</button>
<button type="button" class="btn ghost" data-act="suspend" data-id="${c.id}">Suspend</button>
</div>${errX ? `<p class="err">${esc(errX)}</p>` : ""}
${S.cat.flagFor === c.id ? flagForm(c.id) : ""}
</div>
<div class="rate" role="group" aria-label="How well did you recall it?">
${[1, 2, 3, 4].map((r) => `<button type="button" class="rate-btn r${r}${g?.rating === r ? " suggested" : ""}" data-act="rate" data-r="${r}"><span>${RATING[r]}</span><small class="mono">${fmtInterval(prev[r])}</small></button>`).join("")}
</div>${g?.rating ? `<p class="hint">Claude suggests <b>${RATING[g.rating]}</b>. You decide.</p>` : ""}`;
}
function explanationBlock(c, x) {
  return `<div class="tailored"><span class="lbl">Aimed at your misses · ${esc(new Date(x.at).toLocaleDateString())}</span>
${x.diagnosis ? `<p><b>${esc(x.diagnosis)}</b></p>` : ""}<p>${fmt(x.explanation)}</p>${x.hook ? `<p class="hook">${fmt(x.hook)}</p>` : ""}
${x.contrast || x.rewrite ? `<div class="row small">${x.contrast ? `<button type="button" class="btn ghost" data-act="contrast" data-id="${c.id}">Add contrast card: “${esc(clip(x.contrast.prompt, 60))}”</button>` : ""}${x.rewrite ? `<button type="button" class="btn ghost" data-act="rewrite" data-id="${c.id}">Use Claude's rewrite of this card</button>` : ""}</div>` : ""}</div>`;
}
function flagForm(id) {
  const reasons = id ? ["Wrong", "Unclear", "Not useful for my work", "Too easy", "Other"] : ["Topic I want covered"];
  return `<form class="flag" data-form="flag" data-id="${id || ""}"><span class="lbl">${id ? "What's wrong with this card?" : "Suggest a topic"}</span>
<div class="row small">${reasons.map((r, i) => `<label class="pill"><input type="radio" name="reason" value="${esc(r)}" ${i === 0 ? "checked" : ""}> ${esc(r)}</label>`).join("")}</div>
<textarea id="flag-note-${id || "topic"}" name="note" rows="2" placeholder="${id ? "Optional: what should it say?" : "What do you keep needing to know at work?"}"></textarea>
<div class="row small"><button class="btn primary" type="submit">Save flag</button>${id ? `<button class="btn ghost" type="button" data-act="flag-close">Cancel</button>` : ""}</div></form>`;
}
function doneScreen() {
  const sess = S.session;
  const now = Date.now();
  const f = forecast({ cards: S.cards, mem: S.mem, now, config: S.config, days: 8 });
  const left = S.cards.filter((c) => isNew(S.mem.get(c.id)) && !c.retired).length;
  const items = S.logs.get(today()) || [];
  const passed = items.filter((l) => l.r > 1).length;
  const msg = items.length ? `${items.length} reviews today, ${pct(passed / items.length)} recalled.` : left ? "Nothing due right now." : "Nothing due, and no new cards left.";
  const backlog = sess.counts.backlog;
  return `<section class="panel done"><h2>${items.length ? "Done for today" : "All caught up"}</h2><p>${msg}</p>
${backlog ? `<p>${backlog} overdue cards are waiting beyond today's cap of ${S.config.reviewsPerDay}. They lose little by waiting: the ones decaying fastest are shown first each day. New cards stay paused until the backlog clears.</p>` : ""}
<p class="mono strip">${f.map((n, i) => `<span><small>${i === 0 ? "today" : i === 1 ? "tmrw" : "+" + i}</small>${n}</span>`).join("")}</p>
<p class="muted">${left} new cards in the catalog. ${S.config.newPerDay} are introduced per day.</p>
<div class="row"><a class="btn" href="#add">Turn a work note into cards</a><a class="btn ghost" href="#patterns">See what you keep missing</a></div></section>`;
}

function deckStats(deck) {
  const cs = S.cards.filter((c) => c.deck === deck && !c.retired);
  const now = Date.now();
  let n = 0, rSum = 0, fresh = 0, learning = 0, susp = 0, misses = 0;
  for (const c of cs) {
    const m = S.mem.get(c.id);
    if (m?.suspended) susp++;
    if (isNew(m)) { fresh++; continue; }
    if (isLearning(m)) learning++;
    misses += m.agains || 0;
    const r = currentR(m, now, S.config, S.sched);
    if (r != null) { n++; rSum += r; }
  }
  return { total: cs.length, fresh, learning, susp, misses, meanR: n ? rSum / n : null };
}
function viewCatalog() {
  const q = S.cat.q.trim().toLowerCase();
  const decks = [...DECK_META.values()].filter((d) => d.deck !== "inb" || S.cards.some((c) => c.deck === "inb"));
  const list = q
    ? S.cards.filter((c) => `${c.id} ${c.prompt} ${c.answer}`.toLowerCase().includes(q))
    : S.cat.deck ? S.cards.filter((c) => c.deck === S.cat.deck) : [];
  return `<section class="panel"><div class="row between"><h2>Catalog</h2><label class="search"><span class="sr">Search cards</span><input id="cat-q" type="search" placeholder="Search prompts and answers" value="${esc(S.cat.q)}"></label></div>
<div class="drawers">${decks.map((d) => { const s = deckStats(d.deck); return `<button type="button" class="drawer${S.cat.deck === d.deck && !q ? " on" : ""}" data-act="deck" data-deck="${d.deck}"><span class="callno">${d.code}</span><span class="dname">${esc(d.title)}</span><span class="dmeta mono">${s.total} cards · ${s.fresh} new · recall ${pct(s.meanR)}${s.misses ? ` · ${s.misses} misses` : ""}</span></button>`; }).join("")}</div>
${S.cat.deck && !q ? `<p class="blurb">${esc(DECK_META.get(S.cat.deck)?.blurb || "")}</p>` : ""}
${list.length ? `<ul class="cardlist">${list.map(cardRow).join("")}</ul>` : q ? `<p class="muted">No cards match “${esc(S.cat.q)}”.</p>` : `<p class="muted">Open a drawer to browse its cards.</p>`}</section>`;
}
function cardRow(c) {
  const m = S.mem.get(c.id);
  const st = m?.suspended ? "suspended" : isNew(m) ? "new" : isLearning(m) ? "learning" : `due ${new Date(m.due).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  const r = currentR(m, Date.now(), S.config, S.sched);
  const open = S.cat.open === c.id;
  return `<li class="crow${open ? " open" : ""}"><button type="button" class="crow-head" data-act="open" data-id="${c.id}" aria-expanded="${open}"><span class="callno">${esc(callNumber(c))}</span><span class="cprompt">${esc(clip(c.prompt, 110))}</span><span class="cmeta mono">${st}${r != null ? ` · ${pct(r)}` : ""}${m?.agains ? ` · ${m.agains}×` : ""}</span></button>
${open ? `<div class="cdetail">${cardHead(c)}<p class="prompt sm">${fmt(c.prompt)}</p><p>${fmt(c.answer)}</p>${c.points?.length ? `<ol class="points">${c.points.map((p) => `<li><span>${fmt(p)}</span></li>`).join("")}</ol>` : ""}${c.why ? `<p class="why">${fmt(c.why)}</p>` : ""}
${S.expl.get(c.id) ? explanationBlock(c, S.expl.get(c.id)) : ""}<p class="source">Source: ${esc(c.source || "—")}${m && !isNew(m) ? ` · ${m.reps} reviews, ${m.lapses} lapses${m.stability ? `, stability ${m.stability.toFixed(1)}d` : ""}` : ""}</p>
<div class="row small"><button type="button" class="btn ghost" data-act="${m?.suspended ? "unsuspend" : "suspend"}" data-id="${c.id}">${m?.suspended ? "Unsuspend" : "Suspend"}</button><button type="button" class="btn ghost" data-act="flag-open" data-id="${c.id}">Flag</button>${claudeReady() && m?.agains ? `<button type="button" class="btn ghost" data-act="explain" data-id="${c.id}" ${S.busy.has("explain:" + c.id) ? "disabled" : ""}>${S.busy.has("explain:" + c.id) ? "Diagnosing…" : "Explain my misses"}</button>` : ""}</div>
${S.errs.get("explain:" + c.id) ? `<p class="err">${esc(S.errs.get("explain:" + c.id))}</p>` : ""}${S.cat.flagFor === c.id ? flagForm(c.id) : ""}</div>` : ""}</li>`;
}

function deckOptions(sel) {
  return [...DECK_META.values()].map((d) => `<option value="${d.deck}" ${d.deck === sel ? "selected" : ""}>${esc(d.code)} · ${esc(d.title)}</option>`).join("");
}
function viewAdd() {
  const a = S.add;
  const busy = S.busy.has("draft");
  return `<section class="panel"><h2>Turn a work note into cards</h2>
<p class="muted">Paste something you learned: a meeting takeaway, a policy excerpt, a fix you found. Claude drafts cards from it, and you edit or discard them. Your notes and cards stay in this private artifact.</p>
<label class="lbl" for="add-note">Note</label><textarea id="add-note" rows="6" placeholder="e.g. The catalog's SQL Server scan only sees view definitions; procedure lineage needs query-log capture…">${esc(a.note)}</textarea>
<div class="row"><label class="lbl inline" for="add-deck">Deck</label><select id="add-deck">${deckOptions(a.deck)}</select>
${claudeReady() ? `<button type="button" class="btn primary" data-act="draft" ${busy || !a.note.trim() ? "disabled" : ""}>${busy ? "Drafting…" : "Draft cards"}</button>` : `<span class="muted">Claude is off. Use the manual form below.</span>`}</div>
${S.errs.get("draft") ? `<p class="err">${esc(S.errs.get("draft"))}</p>` : ""}
${a.drafts.length ? `<div class="drafts">${a.drafts.map((d, i) => draftEditor(d, i)).join("")}</div>` : a.drafted ? `<p class="muted">Nothing in that note seemed worth a card.</p>` : ""}
</section>
<section class="panel"><h2>Write a card yourself</h2>${draftEditor({ ...a.manual, points: a.manual.points }, "m")}</section>`;
}
function draftEditor(d, i) {
  const pts = Array.isArray(d.points) ? d.points.join("\n") : d.points || "";
  return `<form class="draft" data-form="draft" data-i="${i}">
<div class="row small"><label class="lbl inline" for="dk-${i}">Kind</label><select id="dk-${i}" name="kind">${["fact", "concept", "judgment"].map((k) => `<option ${k === d.kind ? "selected" : ""}>${k}</option>`).join("")}</select></div>
<label class="lbl" for="dp-${i}">Prompt</label><textarea id="dp-${i}" name="prompt" rows="2">${esc(d.prompt)}</textarea>
<label class="lbl" for="da-${i}">Answer</label><textarea id="da-${i}" name="answer" rows="3">${esc(d.answer)}</textarea>
<label class="lbl" for="dpt-${i}">Key points, one per line (concept and judgment cards are graded against these)</label><textarea id="dpt-${i}" name="points" rows="3">${esc(pts)}</textarea>
<div class="row small"><button class="btn primary" type="submit">Add to ${esc(DECK_META.get(S.add.deck)?.code || "INB")}</button>${i !== "m" ? `<button class="btn ghost" type="button" data-act="discard" data-i="${i}">Discard</button>` : ""}</div></form>`;
}

function viewPatterns() {
  const missed = S.cards.map((c) => ({ c, m: S.mem.get(c.id) })).filter(({ m }) => m?.agains > 0).sort((a, b) => b.m.agains - a.m.agains);
  const ins = S.insights;
  const busy = S.busy.has("patterns");
  return `<section class="panel"><h2>What you keep missing</h2>
${ins ? insightsBlock(ins) : `<p class="muted">No analysis yet. Once a few cards have misses, ask Claude to look for patterns across them.</p>`}
${claudeReady() ? `<div class="row"><button type="button" class="btn primary" data-act="patterns" ${busy || missed.length < 3 ? "disabled" : ""}>${busy ? "Claude is reading your history…" : "Analyze my misses"}</button>${missed.length < 3 ? `<span class="muted">Needs misses on at least 3 cards (${missed.length} so far).</span>` : ""}</div>` : ""}
${S.errs.get("patterns") ? `<p class="err">${esc(S.errs.get("patterns"))}</p>` : ""}</section>
<section class="panel"><h2>Persistent misses</h2>${missed.length ? `<ul class="cardlist">${missed.slice(0, 30).map(({ c, m }) => `<li class="crow"><button type="button" class="crow-head" data-act="goto" data-id="${c.id}"><span class="callno">${esc(callNumber(c))}</span><span class="cprompt">${esc(clip(c.prompt, 110))}</span><span class="cmeta mono">${m.agains}× missed${isLeech(m) ? " · leech" : ""}${S.expl.get(c.id) ? " · explained" : ""}</span></button></li>`).join("")}</ul>` : `<p class="muted">None yet.</p>`}
<p class="muted">A card missed twice gets an "Explain it to me" button aimed at your actual answers. A card with four lapses is a leech: it usually needs rewriting or splitting, not more reps.</p></section>
<section class="panel">${flagForm(null)}<p class="muted">${S.flags.filter((f) => !f.resolved).length} open flags and topic requests. Claude reads them when you ask it to review your learning.</p></section>`;
}
function insightsBlock(ins) {
  const pats = Array.isArray(ins.patterns) ? ins.patterns : [];
  const news = Array.isArray(ins.new_cards) ? ins.new_cards : [];
  return `<div class="insight"><span class="lbl">${esc(ins.source === "session" ? "From a Claude review session" : "From Claude")} · ${ins.at ? esc(new Date(ins.at).toLocaleDateString()) : ""}</span>
<p>${fmt(str(ins.summary, 1200))}</p>
${pats.map((p) => `<div class="pat"><b>${esc(str(p.title, 120))}</b><p>${fmt(str(p.explanation, 600))}</p><p class="mono muted">${(Array.isArray(p.cards) ? p.cards : []).map((id) => esc(String(id))).join(" · ")}</p></div>`).join("")}
${Array.isArray(ins.confusions) && ins.confusions.length ? `<p class="lbl">Confusable pairs</p><ul>${ins.confusions.map((x) => `<li><span class="mono">${esc(String(x.a))} ↔ ${esc(String(x.b))}</span>: ${esc(str(x.why, 300))}</li>`).join("")}</ul>` : ""}
${news.length ? `<p class="lbl">Suggested cards</p>${news.map((n, i) => { const c = cleanCard(n); return c ? `<div class="sugg"><p><b>${esc(c.prompt)}</b></p><p>${esc(c.answer)}</p><button type="button" class="btn ghost" data-act="accept-sugg" data-i="${i}">Add to ${esc(DECK_META.get(c.deck || "inb")?.code || "INB")}</button></div>` : ""; }).join("")}` : ""}
${Array.isArray(ins.rewrite_or_retire) && ins.rewrite_or_retire.length ? `<p class="lbl">Rewrite or retire</p><ul>${ins.rewrite_or_retire.map((x) => `<li><span class="mono">${esc(String(x.id))}</span>: ${esc(str(x.why, 300))}</li>`).join("")}</ul>` : ""}</div>`;
}

function viewTuning() {
  const logs = [...S.logs.values()].flat();
  const cal = calibration(logs);
  const fit = fitScale(logs, S.sched);
  const f = forecast({ cards: S.cards, mem: S.mem, now: Date.now(), config: S.config, days: 14 });
  const cfg = S.config;
  const reviewN = logs.filter((l) => l.st === State.Review).length;
  const k = fit.k;
  return `<section class="panel"><h2>How well the scheduler knows you</h2>
<p class="muted">The scheduler predicts how likely you are to recall each card when it comes due. Below, its predictions are compared with what actually happened. Counts only include reviews of cards already past the learning stage.</p>
<div class="scroll"><table><thead><tr><th>Predicted recall</th><th>Reviews</th><th>Predicted</th><th>Actual</th></tr></thead><tbody>${cal.map((b) => `<tr><td class="mono">${pct(b.lo)}–${pct(b.hi)}</td><td class="num">${b.n}</td><td class="num">${pct(b.predicted)}</td><td class="num">${pct(b.actual)}</td></tr>`).join("")}</tbody></table></div>
${k == null ? `<p>Personal fit needs 30 review-stage reviews. You have ${fit.n}.</p>`
    : `<p>Best-fit memory multiplier: <b class="mono">${k.toFixed(2)}</b> (95% interval ${fit.lo.toFixed(2)}–${fit.hi.toFixed(2)}, ${fit.n} reviews). ${k < 1 ? "You forget a little faster than the default model assumes." : "You remember a little longer than the default model assumes."} Log loss ${fit.logLossDefault.toFixed(3)} → ${fit.logLossFitted.toFixed(3)}.</p>
${fit.significant ? `<div class="row"><button type="button" class="btn primary" data-act="apply-k" data-k="${k}">Apply: intervals × ${k.toFixed(2)}</button></div>` : `<p class="muted">The interval includes 1.00, so there isn't evidence to change anything yet. The forgetting curve is flat enough that this takes a few hundred reviews.</p>`}`}
${cfg.intervalScale !== 1 ? `<p>Currently applied: intervals × <span class="mono">${cfg.intervalScale.toFixed(2)}</span>. <button type="button" class="btn ghost" data-act="apply-k" data-k="1">Reset to 1.00</button></p>` : ""}
</section>
<section class="panel"><h2>Next two weeks</h2><p class="mono strip wide">${f.map((n, i) => `<span><small>${i === 0 ? "today" : "+" + i}</small>${n}</span>`).join("")}</p></section>
<section class="panel"><h2>Scheduler</h2>
<p class="muted">Last changed by: <b>${esc(cfg.source)}</b>${cfg.updatedAt ? ` on ${esc(new Date(cfg.updatedAt).toLocaleDateString())}` : ""}. Target recall by card kind: fact ${pct(cfg.kinds.fact.retention)}, concept ${pct(cfg.kinds.concept.retention)}, judgment ${pct(cfg.kinds.judgment.retention)}. Writing cards cost more per review, so they're scheduled less often. Maximum interval ${cfg.maximumInterval} days.</p>
<form class="settings" data-form="settings"><div class="grid3">
<label>New cards / day<input id="set-new" name="newPerDay" type="number" min="0" max="50" value="${cfg.newPerDay}"></label>
<label>Review cap / day<input id="set-rev" name="reviewsPerDay" type="number" min="5" max="500" value="${cfg.reviewsPerDay}"></label>
<label>Day starts at (hour)<input id="set-roll" name="rolloverHour" type="number" min="0" max="12" value="${cfg.rolloverHour}"></label></div>
<div class="row small"><button class="btn" type="submit">Save</button></div></form></section>
<section class="panel"><h2>Ask Claude to tune it</h2>
<p class="muted">Patrick Collison's suggestion: "review my learning and improve the efficiency of your scheduler." Paste this into a Claude Code session on the spaced-repetition repo. With ${reviewN} review-stage reviews logged, ${reviewN >= 512 ? "a full refit of all 21 parameters is worth running." : "it will mostly fix flagged cards and write insights. Refitting the 21 parameters needs 512 reviews on days after the first."}</p>
<pre class="prompt-copy" id="session-prompt">${esc(SESSION_PROMPT)}</pre><div class="row small"><button type="button" class="btn" data-act="copy-prompt">Copy</button></div></section>
<section class="panel"><h2>Your data</h2><p class="muted">${S.mode === "db" ? "Reviews are saved to this artifact's private store. Only you can read or change them." : "Saved in this browser only. Export regularly."} ${logs.length} reviews, ${S.custom.size} added cards, ${S.flags.length} flags. Build ${esc(BUILD)}.</p>
<div class="row small"><button type="button" class="btn" data-act="export">Export JSON</button></div><div id="export-slot"></div></section>`;
}
const SESSION_PROMPT = `Review my learning in the Card Catalog artifact. Read its db (reviews, cards, flags, explanations, custom, config/scheduler) with ArtifactData. Fix or retire flagged deck cards in decks/ and resolve the flags. If there are enough reviews, run tools/optimize.py and write the fitted parameters and per-kind retention to config/scheduler. Write what you found to insights/latest. Rebuild, run the tests, republish, and tell me what changed and why.`;

// ---------- events ----------
function route() {
  const h = (location.hash || "").replace("#", "");
  S.view = VIEWS.includes(h) ? h : "review";
  if (S.view === "review" && S.session && !S.session.current) startSession();
  render();
}
document.addEventListener("click", async (ev) => {
  const el = ev.target.closest("[data-act]");
  if (!el) return;
  const act = el.dataset.act, id = el.dataset.id;
  switch (act) {
    case "reveal": return reveal();
    case "type": S.session.typing = true; return render();
    case "grade": return grade();
    case "rate": return rate(Number(el.dataset.r));
    case "explain": return explain(id);
    case "contrast": return addContrast(id);
    case "rewrite": return useRewrite(id);
    case "suspend": return setSuspended(id, true);
    case "unsuspend": return setSuspended(id, false);
    case "flag-open": S.cat.flagFor = id; return render();
    case "flag-close": S.cat.flagFor = null; return render();
    case "deck": S.cat.deck = S.cat.deck === el.dataset.deck ? null : el.dataset.deck; S.cat.q = ""; S.cat.open = null; return render();
    case "open": S.cat.open = S.cat.open === id ? null : id; return render();
    case "goto": S.cat.deck = S.byId.get(id)?.deck; S.cat.open = id; S.cat.q = ""; location.hash = "catalog"; return;
    case "draft": {
      const note = S.add.note.trim();
      if (!note) return;
      const out = await ask("draft", draftPrompt(note.slice(0, 12000)));
      if (out) { S.add.drafts = (Array.isArray(out.cards) ? out.cards : []).map(cleanCard).filter(Boolean).slice(0, 5); S.add.drafted = true; }
      return render();
    }
    case "discard": S.add.drafts.splice(Number(el.dataset.i), 1); return render();
    case "patterns": {
      const missed = S.cards.map((c) => ({ c, m: S.mem.get(c.id), tries: attemptsFor(c.id) })).filter(({ m }) => m?.agains > 0).sort((a, b) => b.m.agains - a.m.agains).slice(0, 40);
      const out = await ask("patterns", patternsPrompt(missed), { modelTier: "complex" });
      if (out && typeof out === "object") { S.insights = { ...out, at: Date.now(), source: "in-app" }; persist("insights/latest", S.insights); }
      return render();
    }
    case "accept-sugg": {
      const c = cleanCard(S.insights?.new_cards?.[Number(el.dataset.i)]);
      if (c) { addCustom(c, "Suggested by Claude from your misses", c.deck || "inb"); S.insights.new_cards.splice(Number(el.dataset.i), 1); persist("insights/latest", S.insights); toast("Card added."); }
      return render();
    }
    case "apply-k": {
      const k = Number(el.dataset.k);
      S.config = { ...S.config, intervalScale: k, source: k === 1 ? "reset in app" : "in-app calibration", updatedAt: Date.now(), history: [...(S.config.history || []).slice(-19), { at: Date.now(), by: "in-app", change: `intervalScale=${k.toFixed(3)}` }] };
      S.sched = schedulerFor(S.config);
      persist("config/scheduler", S.config);
      toast(k === 1 ? "Calibration reset." : `Intervals now × ${k.toFixed(2)}.`);
      return render();
    }
    case "copy-prompt": {
      try { await navigator.clipboard.writeText(SESSION_PROMPT); toast("Copied."); }
      catch { const r = document.createRange(); r.selectNodeContents(document.getElementById("session-prompt")); const s = getSelection(); s.removeAllRanges(); s.addRange(r); toast("Selected. Copy it with your keyboard."); }
      return;
    }
    case "export": return exportData();
    case "retry-load": return boot();
  }
});
document.addEventListener("input", (ev) => {
  const t = ev.target;
  if (t.id === "answer-box") S.session.typed = t.value;
  else if (t.id === "add-note") { S.add.note = t.value; const b = document.querySelector('[data-act="draft"]'); if (b && !S.busy.has("draft")) b.disabled = !t.value.trim(); }
  else if (t.id === "cat-q") { S.cat.q = t.value; const pos = t.selectionStart; render(); const n = document.getElementById("cat-q"); if (n) { n.focus(); n.setSelectionRange(pos, pos); } }
});
document.addEventListener("change", (ev) => {
  if (ev.target.id !== "add-deck") return;
  S.add.deck = ev.target.value;
  const code = DECK_META.get(S.add.deck)?.code || "INB";
  document.querySelectorAll('form[data-form="draft"] button[type="submit"]').forEach((b) => (b.textContent = `Add to ${code}`));
});
document.addEventListener("submit", (ev) => {
  const form = ev.target.closest("form[data-form]");
  if (!form) return;
  ev.preventDefault();
  const fd = new FormData(form);
  if (form.dataset.form === "flag") {
    saveFlag(form.dataset.id || null, String(fd.get("reason") || "Other"), String(fd.get("note") || ""));
    S.cat.flagFor = null;
    return render();
  }
  if (form.dataset.form === "draft") {
    const c = cleanCard({ kind: fd.get("kind"), prompt: fd.get("prompt"), answer: fd.get("answer"), points: String(fd.get("points") || "").split("\n") });
    if (!c) return toast("A card needs a prompt and an answer.");
    if (c.kind !== "fact" && c.points.length < 2) return toast("Concept and judgment cards need at least two key points to be graded.");
    const i = form.dataset.i;
    addCustom(c, i === "m" ? "Written by you" : "Drafted by Claude from your note", S.add.deck);
    if (i === "m") S.add.manual = { kind: "fact", prompt: "", answer: "", points: "" }; else S.add.drafts.splice(Number(i), 1);
    toast(`Added to ${DECK_META.get(S.add.deck)?.code}. It enters your queue as a new card.`);
    return render();
  }
  if (form.dataset.form === "settings") {
    const n = (k, lo, hi, d) => { const v = Math.round(Number(fd.get(k))); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
    S.config = { ...S.config, newPerDay: n("newPerDay", 0, 50, 5), reviewsPerDay: n("reviewsPerDay", 5, 500, 40), rolloverHour: n("rolloverHour", 0, 12, 4), updatedAt: Date.now(), history: [...(S.config.history || []).slice(-19), { at: Date.now(), by: "in-app", change: "daily limits" }] };
    persist("config/scheduler", S.config);
    startSession();
    toast("Saved.");
    return render();
  }
});
document.addEventListener("keydown", (ev) => {
  if (S.view !== "review" || !S.session?.current) return;
  const inText = ev.target.tagName === "TEXTAREA" || ev.target.tagName === "INPUT" || ev.target.tagName === "SELECT";
  if (inText) {
    if (ev.target.id === "answer-box" && ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); claudeReady() && S.byId.get(S.session.current)?.kind !== "fact" ? grade() : reveal(); }
    return;
  }
  if (S.session.phase === "front" && (ev.key === " " || ev.key === "Enter") && !ev.target.closest("button,a")) { ev.preventDefault(); reveal(); }
  else if (S.session.phase === "back" && ["1", "2", "3", "4"].includes(ev.key)) { ev.preventDefault(); rate(Number(ev.key)); }
});
let hiddenAt = null;
document.addEventListener("visibilitychange", () => {
  if (document.hidden) hiddenAt = performance.now();
  else if (hiddenAt != null && S.session) { S.session.hiddenMs += performance.now() - hiddenAt; hiddenAt = null; }
});
window.addEventListener("hashchange", route);

async function exportData() {
  const data = {
    app: "card-catalog", version: 1, build: BUILD, exportedAt: new Date().toISOString(), config: S.config,
    cards: S.cards.map(({ id, deck, kind, prompt, answer, points, source, custom, edited, retired }) => ({ id, deck, kind, prompt, answer, points, source, custom: !!custom, edited: !!edited, retired: !!retired })),
    memory: Object.fromEntries(S.mem),
    reviews: [...S.logs.entries()].flatMap(([day, items]) => items.map((x) => ({ day, ...x }))),
    explanations: Object.fromEntries(S.expl), flags: S.flags, insights: S.insights,
  };
  const json = JSON.stringify(data, null, 1);
  if (S.downloads) {
    try { await S.downloads.save({ filename: `card-catalog-${today()}.json`, data: json }); toast("Export saved."); return; }
    catch (e) { if (e?.code === "declined") return; }
  }
  const slot = document.getElementById("export-slot");
  if (slot) slot.innerHTML = `<label class="lbl" for="export-box">Copy this JSON</label><textarea id="export-box" rows="6" readonly>${esc(json)}</textarea>`;
}

// ---------- boot ----------
async function boot() {
  S.mode = "loading";
  render();
  const c = window.claude;
  let db = null;
  if (c?.use) {
    try { [db, S.sample, S.downloads] = await Promise.all([c.use("db"), c.use("sample"), c.use("downloads")]); } catch { db = null; }
  }
  if (db) {
    S.db = db;
    try { await loadDb(); S.mode = "db"; }
    catch { S.mode = "unreachable"; return render(); }
  } else {
    S.mode = "local";
    loadLocal();
  }
  S.sched = schedulerFor(S.config);
  assembleCards();
  startSession();
  route();
}
boot();
