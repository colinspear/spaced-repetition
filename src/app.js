// Card Catalog UI. Built into one page by build.mjs (imports are stripped there;
// fsrs.js and engine.js are concatenated ahead of this file).
import { State, DAY } from "./fsrs.js";
import {
  mergeConfig, dayKey, blankMemory, isNew, isLearning, schedulerFor, buildQueue, nextCard, applyRating,
  previewIntervals, previewOutcome, fmtInterval, calibration, fitScale, forecast, currentR, isPersistentMiss, isLeech,
  mastery, MASTERY, simulateCurve, elapsedDays,
} from "./engine.js";

const DECKS = __DECKS__;
const BUILD = "__BUILD__";
const INBOX = { deck: "inb", code: "INB", title: "Inbox", blurb: "Cards you added, or accepted from Claude.", cards: [] };
const DECK_META = new Map([...DECKS, INBOX].map((d) => [d.deck, d]));
// Role-level only: cards and explanations stay general, never tied to one organization.
const LEARNER =
  "an experienced data leader whose work spans data governance, metadata, data modeling and databases, analytics, " +
  "change management, capability building and leadership. Economist by training. " +
  "Thinks as a data governance leader or CDO: wants to know why an idea matters for decisions, risk and governance, more than implementation detail. " +
  "Wants terse, precise, non-sycophantic explanations; skip basics they already know.";
const LS_KEY = "card-catalog:v1";
const RATING = { 1: "Again", 2: "Hard", 3: "Good", 4: "Easy" };
const RATING_UI = { 1: "Didn't know", 2: "Partly", 3: "Knew it", 4: "Easy" };
const VERDICT = { 1: "Not yet", 2: "Partly right", 3: "Right", 4: "Spot on" };
const FINE_POINTER = typeof matchMedia === "function" && matchMedia("(hover: hover) and (pointer: fine)").matches;
const VIEWS = ["review", "study", "catalog", "add", "tuning", "guide"];
const TABS = ["review", "study", "catalog", "add", "tuning"];
const VIEW_LABEL = { review: "Review", study: "Study", catalog: "Catalog", add: "Add", tuning: "Tuning", guide: "Guide" };
const DRAFT_KEY = "card-catalog:draft";
const LEVELS = [["basic", "Too basic"], ["right", "Just right"], ["detailed", "Too detailed"], ["irrelevant", "Not useful"]];
const LEVEL_LABEL = Object.fromEntries(LEVELS);

const S = {
  mode: "loading", // loading | db | local | unreachable
  db: null, sample: null, downloads: null, claudeOff: false,
  config: mergeConfig(null), sched: null,
  cards: [], byId: new Map(),
  mem: new Map(), logs: new Map(), expl: new Map(), custom: new Map(), flags: [], insights: null,
  deep: new Map(), streamText: new Map(), pendingQ: new Map(), study: new Map(), studyOpen: null,
  fb: new Map(), rewrites: new Map(),
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
        mem: [...S.mem], logs: [...S.logs], expl: [...S.expl], custom: [...S.custom], flags: S.flags, config: S.config, insights: S.insights, deep: [...S.deep], study: [...S.study], fb: [...S.fb],
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
    S.deep = new Map(d.deep || []);
    S.study = new Map(d.study || []);
    S.fb = new Map(d.fb || []);
  } catch { /* private window or blocked storage: start empty */ }
}
async function loadDb() {
  const col = async (name) => (await withTimeout(S.db.collection(name).get())).docs;
  const [cards, reviews, expl, custom, flags, deep, study, fb, cfg, ins] = await Promise.all([
    col("cards"), col("reviews"), col("explanations"), col("custom"), col("flags"), col("deepdives"), col("study"), col("feedback"),
    withTimeout(S.db.doc("config/scheduler").get()), withTimeout(S.db.doc("insights/latest").get()),
  ]);
  S.mem = new Map(cards.map((d) => [d.id, clone(d.data())]));
  S.logs = new Map(reviews.map((d) => [d.id, clone(d.data().items || [])]));
  S.expl = new Map(expl.map((d) => [d.id, clone(d.data())]));
  S.custom = new Map(custom.map((d) => [d.id, clone(d.data())]));
  S.flags = flags.map((d) => ({ id: d.id, ...clone(d.data()) }));
  S.deep = new Map(deep.map((d) => [d.id, clone(d.data())]));
  S.study = new Map(study.map((d) => [d.id, clone(d.data())]));
  S.fb = new Map(fb.map((d) => [d.id, clone(d.data())]));
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
    if (S.session?.current && key.endsWith(S.session.current) && S.session.phase === "front") S.session.waitMs += performance.now() - t;
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

Your rating schedules the next review, so be accurate:
1 = wrong, blank, or missing the core idea;
2 = core idea right but important parts missing, vague, or hedged ("I think", "I'm guessing");
3 = correct, with at most minor omissions;
4 = complete, precise and confident.
Judge the answer against what the prompt asks for. Extra explanation that is loosely worded but not false doesn't lower the rating; only a false statement or a missing asked-for part does.
Reply with only JSON:
{"points":[{"i":1,"verdict":"hit|partial|miss","note":"at most 12 words"}],"wrong":"a false claim in their answer, or empty string","feedback":"at most 50 words, second person: what was right, what was missing or wrong, and the one thing to remember. No praise padding.","rating":3}
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

${calibrationContext(c.deck)}
Write for someone who knows the field. No definitions of basics, no pep talk. Keep it general: no specific organizations, places, vendors or products unless the card is about one. If attempts have no typed text, infer the likely confusion from the card and its neighbours and say that you are inferring.
Reply with only JSON:
{"diagnosis":"1-2 sentences: what they get wrong and why it is tempting","explanation":"at most 120 words","hook":"one memorable handle, at most 40 words: a sharp contrast, a concrete workplace example, or a mnemonic","contrast_card":{"prompt":"...","answer":"..."},"rewrite":null}
Set "contrast_card" to null unless a discrimination card would help. A contrast card must have one unambiguous, correct answer: check it against the reference before replying, and never let the answer contradict itself. Set "rewrite" to {"prompt","answer"} only if the card itself is ambiguous or overloaded.`;
}
function patternsPrompt(missed) {
  const body = missed.map(({ c, m, tries }) =>
    `[${c.id}] deck=${c.deck} kind=${c.kind} agains=${m.agains} lapses=${m.lapses}\nQ: ${clip(c.prompt, 220)}\nA: ${clip(c.answer, 260)}\nTheir attempts: ${tries.filter((t) => t.r <= 2).map((t) => (t.a ? `"${clip(t.a, 160)}"` : "(untyped)")).slice(-3).join(" | ") || "(untyped)"}`).join("\n\n");
  return `Here is a learner's miss history in a spaced-repetition collection. Look for patterns across cards, not card-by-card fixes.
Learner: ${LEARNER}
Deck keys: ${[...DECK_META.values()].map((d) => `${d.deck}=${d.title}`).join("; ")}

${calibrationContext(null)}
MISSED CARDS:
${body}

Reply with only JSON:
{"summary":"at most 80 words","patterns":[{"title":"...","cards":["id"],"explanation":"at most 70 words"}],"confusions":[{"a":"id","b":"id","why":"..."}],"new_cards":[{"deck":"gov","kind":"fact","prompt":"...","answer":"...","points":[]}],"rewrite_or_retire":[{"id":"...","why":"..."}]}
At most 4 patterns and 5 new cards. Concept and judgment cards need 2-5 points.`;
}
function deepPrompt(c, typed, grade) {
  return `Give a deeper explanation of the idea behind this spaced-repetition card, for a learner who wants to understand it, not just recall it.
Learner: ${LEARNER}

${cardBlock(c)}${typed ? `\n\nTHEIR LATEST ANSWER:\n"""${clip(typed, 800)}"""` : ""}${grade?.feedback ? `\nGRADER'S NOTE: ${grade.feedback}` : ""}

Cover, in order, only as far as useful:
1. The core idea in plain words, and why it is true or why it matters: the mechanism, not a restatement.
2. A concrete example that makes it click. Keep it generic: no real organizations, places, vendors or products unless the card is about one.
3. The common confusion or misapplication and how to tell the difference${typed ? ", aimed at what their answer suggests they're missing" : ""}.
4. When it doesn't apply, or the main caveat.
5. One reliable source worth reading next, if you know one; otherwise skip this.
At most 300 words. Plain Markdown: ### headings, - bullets, **bold**. No preamble, no pep talk.`;
}
function md(src) {
  const inline = (s) => s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>");
  let out = "", list = null, para = [];
  const flush = () => { if (para.length) { out += `<p>${inline(para.join(" "))}</p>`; para = []; } };
  const close = () => { if (list) { out += `</${list}>`; list = null; } };
  for (const raw of esc(src || "").split("\n")) {
    const l = raw.trim();
    let m;
    if (!l) { flush(); close(); }
    else if ((m = l.match(/^#{1,6}\s+(.*)$/))) { flush(); close(); out += `<p class="md-h">${inline(m[1])}</p>`; }
    else if ((m = l.match(/^[-*•]\s+(.*)$/))) { flush(); if (list !== "ul") { close(); out += "<ul>"; list = "ul"; } out += `<li>${inline(m[1])}</li>`; }
    else if ((m = l.match(/^\d+[.)]\s+(.*)$/))) { flush(); if (list !== "ol") { close(); out += "<ol>"; list = "ol"; } out += `<li>${inline(m[1])}</li>`; }
    else { close(); para.push(l); }
  }
  flush(); close();
  return out;
}
async function stream(key, input, elId) {
  S.busy.add(key); S.errs.delete(key); S.streamText.delete(key); render();
  try {
    const r = await S.sample(input, { modelTier: "default", cache: false, onText: ({ text }) => {
      S.streamText.set(key, text);
      const el = document.getElementById(elId);
      if (el) el.innerHTML = md(text);
    } });
    return r.text;
  } catch (e) {
    const msg = sampleError(e);
    if (msg) S.errs.set(key, msg);
    return null;
  } finally {
    S.busy.delete(key); S.streamText.delete(key); render();
  }
}
function markPause(id) {
  const sess = S.session;
  if (sess?.current === id && sess.phase === "back" && sess.pauseAt == null) sess.pauseAt = performance.now();
}
async function goDeeper(id) {
  const c = S.byId.get(id);
  if (!c || !claudeReady() || S.busy.has(`deep:${id}`)) return;
  markPause(id);
  const sess = S.session, isCur = sess?.current === id;
  const typed = isCur ? sess.typed.trim() : attemptsFor(id).filter((a) => a.a).pop()?.a || "";
  const prompt = deepPrompt(c, typed, isCur ? sess.grade : null);
  const text = await stream(`deep:${id}`, prompt, `deep-${id}`);
  if (!text) return;
  const rec = { prompt, text, followups: [], at: Date.now() };
  S.deep.set(id, rec);
  persist(`deepdives/${id}`, rec);
  setStudy(id, true, false);
  render();
}
/** Study list: cards saved for understanding. Removing hides a card even if it has a deep dive. */
function setStudy(id, on, notify = true) {
  const prev = S.study.get(id);
  if (on && prev && !prev.removed) return;
  const rec = { at: Date.now(), removed: !on };
  S.study.set(id, rec);
  persist(`study/${id}`, rec);
  if (notify) toast(on ? "Saved to Study." : "Removed from Study.");
}
function studyIds() {
  const ids = new Set([...S.deep.keys(), ...[...S.study].filter(([, r]) => !r.removed).map(([id]) => id)]);
  const when = (id) => Math.max(S.study.get(id)?.at || 0, S.deep.get(id)?.at || 0, ...(S.deep.get(id)?.followups || []).map((f) => f.at || 0));
  return [...ids].filter((id) => S.byId.has(id) && !S.study.get(id)?.removed).sort((a, b) => when(b) - when(a));
}
async function followUp(id, q) {
  const rec = S.deep.get(id);
  q = (q || "").trim();
  if (!rec || !q || !claudeReady() || S.busy.has(`follow:${id}`)) return;
  markPause(id);
  const turns = [{ role: "user", content: rec.prompt }, { role: "assistant", content: rec.text }];
  for (const f of rec.followups.slice(-6)) turns.push({ role: "user", content: f.q }, { role: "assistant", content: f.a });
  turns.push({ role: "user", content: `${q}\n\n(At most 200 words. Plain Markdown. Stay general: no real organizations, places, vendors or products unless asked.)` });
  S.pendingQ.set(id, q);
  const text = await stream(`follow:${id}`, turns, `follow-${id}`);
  S.pendingQ.delete(id);
  if (!text) return render();
  rec.followups.push({ q: q.slice(0, 1000), a: text, at: Date.now() });
  persist(`deepdives/${id}`, rec);
  render();
}
/** The learner's level marks, as worked examples for any prompt that writes cards. */
function calibrationContext(deck) {
  // Each mark keeps the prompt as it read when the learner judged it, so a later rewrite of the
  // card doesn't change what the example says. Marks already acted on still count as examples.
  const marked = [];
  for (const [id, f] of S.fb) {
    for (const e of [f, ...(f.past || [])]) {
      const prompt = e.prompt || S.byId.get(id)?.prompt;
      if (e.level && prompt) marked.push({ level: e.level, note: e.note || "", prompt, deck: e.deck || f.deck || S.byId.get(id)?.deck });
    }
  }
  if (!marked.length) return "";
  const sec = (title, lvl) => {
    const rows = marked.filter((e) => e.level === lvl).sort((a, b) => (a.deck === deck ? 0 : 1) - (b.deck === deck ? 0 : 1)).slice(0, 5)
      .map((e) => `- "${clip(e.prompt, 170)}"${e.note ? ` (their note: ${clip(e.note, 200)})` : ""}`);
    return rows.length ? `${title}:\n${rows.join("\n")}\n` : "";
  };
  return `\nLEVEL FEEDBACK FROM THE LEARNER. Aim for what they marked just right; avoid what they marked too basic, too detailed or not useful:
${sec("Just right", "right")}${sec("Too basic for them", "basic")}${sec("Too detailed: trivia they don't need", "detailed")}${sec("Not useful to them", "irrelevant")}`;
}
function rewritePrompt(c, level, note) {
  const why = level === "basic"
    ? "too basic: they already know it and need a more advanced version"
    : "too detailed: it tests trivia rather than the principle they need";
  const aim = level === "basic"
    ? "tests understanding at a higher level: applying it to a realistic situation, a trade-off, a failure mode, or how it connects to a neighbouring idea. Prefer a concept or judgment card."
    : "tests the underlying principle, or why it matters, instead of the detail. Drop lists, counts and numbers they don't need.";
  return `Rewrite this spaced-repetition card for the learner. They marked it ${why}.${note ? ` Their note: "${clip(note, 400)}".` : ""}
Learner: ${LEARNER}

${cardBlock(c)}
${calibrationContext(c.deck)}
Write ONE replacement card on the same topic that ${aim}
Rules: one idea; a precise prompt with one consistent answer; general, with no real organizations, places, vendors or products unless the card is about one; only claims you are confident are accurate; concept and judgment cards need 2-5 key points.
Before replying, check that the answer is correct and doesn't contradict itself.
Reply with only JSON: {"kind":"concept","prompt":"...","answer":"...","points":["..."],"why":"one sentence on what changed"}`;
}
function deckDraftPrompt(deck) {
  const d = DECK_META.get(deck);
  const have = S.cards.filter((c) => c.deck === deck && !c.retired).map((c) => `- ${clip(c.prompt, 140)}`).join("\n");
  return `Draft new spaced-repetition cards for the deck "${d?.title || deck}": ${d?.blurb || ""}
Learner: ${LEARNER}
${calibrationContext(deck)}
CARDS ALREADY IN THIS DECK (don't duplicate them):
${have || "- none"}

Write 5 new cards that fill gaps at the level the learner wants. General principles and best practice that hold in any organization; no real organizations, places, vendors or products unless a card is about one. Each card tests one idea with a precise prompt and one consistent answer. Mix kinds: "fact", "concept" (2-5 key points), "judgment" (a realistic scenario; 3-5 key points). Only include claims you are confident are accurate, check each answer for correctness and internal consistency before replying, and name a source for each.
Reply with only JSON: {"cards":[{"kind":"concept","prompt":"...","answer":"...","points":["..."],"source":"..."}]}`;
}
function draftPrompt(note) {
  return `Turn this note into spaced-repetition cards for the learner.
Learner: ${LEARNER}
Rules: each card tests one idea; the prompt is precise and has one consistent answer; no yes/no prompts; prefer why/how/when over bare what when the note supports it. Use only what the note states or directly implies. Add no outside facts.
Make every card broadly applicable: extract the transferable principle, and leave out the names of the organization, its people, departments, systems, vendors and places. A card should make sense to a data professional anywhere.
Kinds: "fact" (short recall), "concept" (explain in a few sentences; give 2-5 points), "judgment" (a realistic scenario needing a decision; give 3-5 points).
${calibrationContext(S.add.deck)}
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
  return { kind, prompt, answer, points, deck: DECK_META.has(x.deck) ? x.deck : undefined, source: str(x.source, 300).trim(), change: str(x.why, 300).trim() };
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
  Object.assign(sess, { current: nx?.id || null, from: nx?.from, phase: "front", typed: "", grade: null, override: false, focusBox: FINE_POINTER, t0: performance.now(), waitMs: 0, hiddenMs: 0, pauseAt: null });
  saveDraft();
  if (doRender) render();
}
// The card in progress survives reloads (phones reload backgrounded pages; publishing an
// update reloads open views). Per-viewer convenience, so browser storage, not the db.
let draftTimer;
function saveDraft(soon = false) {
  const write = () => {
    try {
      const s = S.session;
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ id: s?.current || null, phase: s?.phase, typed: s?.typed || "", grade: s?.grade || null, override: !!s?.override, studyOpen: S.studyOpen, day: today(), at: Date.now() }));
    } catch { /* storage blocked: nothing to restore later */ }
  };
  clearTimeout(draftTimer);
  if (soon) draftTimer = setTimeout(write, 300);
  else write();
}
function readDraft() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || "null"); } catch { return null; }
}
/** Takes the draft read before startSession(), which saves a fresh draft of its own. */
function restoreDraft(d) {
  if (!d || d.day !== today()) return;
  S.studyOpen = d.studyOpen && S.byId.has(d.studyOpen) ? d.studyOpen : null;
  const c = d.id && S.byId.get(d.id);
  if (!c || S.mem.get(c.id)?.suspended) return;
  if ((S.logs.get(today()) || []).some((l) => l.c === c.id && l.t >= d.at)) return; // rated since
  Object.assign(S.session, { current: c.id, from: "restored", phase: d.phase === "back" ? "back" : "front", typed: d.typed || "", grade: d.grade || null, override: !!d.override, focusBox: false, t0: performance.now(), waitMs: 0, hiddenMs: 0, pauseAt: null });
  saveDraft();
}
/** Cards, not reviews: each card today is in exactly one bucket. */
function progress() {
  const sess = S.session;
  const back = new Set(S.cards.filter((c) => isLearning(S.mem.get(c.id)) && !S.mem.get(c.id).suspended).map((c) => c.id));
  const done = new Set((S.logs.get(today()) || []).map((l) => l.c).filter((id) => !back.has(id)));
  const toGo = sess ? sess.queue.filter((id) => !back.has(id) && !done.has(id)).length : 0;
  return { done: done.size, toGo, back: back.size, total: done.size + toGo + back.size };
}
function reveal() { if (S.session.current) { S.session.phase = "back"; saveDraft(); render(); } }
async function grade() {
  const sess = S.session, c = S.byId.get(sess.current);
  if (!c || !sess.typed.trim() || !claudeReady() || S.busy.has(`grade:${c.id}`)) return;
  const g = await ask(`grade:${c.id}`, gradePrompt(c, sess.typed.trim()), c.kind === "fact" ? { modelTier: "quick" } : {});
  if (S.session !== sess || sess.current !== c.id) return;
  if (g) {
    const pts = Array.isArray(g.points) ? g.points : [];
    sess.grade = {
      points: pts.map((p) => ({ i: Number(p?.i) || 0, verdict: ["hit", "partial", "miss"].includes(p?.verdict) ? p.verdict : "miss", note: str(p?.note, 140) })),
      wrong: str(g.wrong, 300), feedback: str(g.feedback, 500), rating: [1, 2, 3, 4].includes(Number(g.rating)) ? Number(g.rating) : null,
    };
    sess.phase = "back";
    saveDraft();
  }
  render();
}
const seenToday = (id) => (S.logs.get(today()) || []).filter((l) => l.c === id).length;
function rate(r) {
  const sess = S.session, c = S.byId.get(sess.current);
  if (!c || sess.phase !== "back") return;
  const now = Date.now();
  const prev = S.mem.get(c.id);
  const res = applyRating({ mem: prev, card: c, rating: r, now, config: S.config, sched: S.sched, seenToday: seenToday(c.id) });
  // Review cost excludes waiting on Claude and anything after a deeper dive or explanation was opened.
  const paused = sess.pauseAt != null ? performance.now() - sess.pauseAt : 0;
  res.log.d = Math.round(Math.min(Math.max(performance.now() - sess.t0 - sess.waitMs - sess.hiddenMs - paused, 300), 600000));
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
  toast(res.movedOn
    ? `That's enough of this card for today. It comes back in ${fmtInterval(res.intervalMs)}. If it isn't clicking, try Go deeper.`
    : `${RATING_UI[r]}. ${r === 1 ? "Back" : "Next"} in ${fmtInterval(res.intervalMs)}.`, { label: "Undo", fn: undoLast });
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
  Object.assign(sess, { queue: u.queue, reviewed: u.reviewed, passed: u.passed, undo: null, current: u.id, phase: "back", typed: u.typed, grade: u.grade, override: false, t0: performance.now(), waitMs: 0, hiddenMs: 0, pauseAt: null });
  saveDraft();
  render();
}
async function explain(id) {
  const c = S.byId.get(id);
  if (!c || !claudeReady()) return;
  markPause(id);
  const x = await ask(`explain:${id}`, explainPrompt(c, attemptsFor(id)), { modelTier: "complex" });
  if (!x) return;
  const cc = cleanCard(x.contrast_card ? { ...x.contrast_card, kind: "fact" } : null);
  const rw = cleanCard(x.rewrite ? { ...x.rewrite, kind: c.kind, points: c.points } : null);
  const rec = { diagnosis: str(x.diagnosis, 600), explanation: str(x.explanation, 1400), hook: str(x.hook, 600), contrast: cc, rewrite: rw, at: Date.now(), attempts: attemptsFor(id).length };
  S.expl.set(id, rec);
  persist(`explanations/${id}`, rec);
  render();
}
function addCustom(card, origin, deck, extra = {}) {
  const id = uid("u");
  const rec = { id, deck: deck || card.deck || "inb", kind: card.kind, prompt: card.prompt, answer: card.answer, points: card.points || [], source: card.source || `${origin}, ${today()}`, origin, createdAt: Date.now(), ...extra };
  S.custom.set(id, rec);
  persist(`custom/${id}`, rec);
  assembleCards();
  return id;
}
function setLevel(id, level) {
  const c = S.byId.get(id);
  if (!c) return;
  let prev = S.fb.get(id) || {};
  // A mark Claude has already acted on is archived; a new mark judges the card as it reads now.
  if (prev.resolved) prev = { past: [...(prev.past || []).slice(-4), { level: prev.level, note: prev.note || "", prompt: prev.prompt, deck: prev.deck, resolved: prev.resolved }], history: prev.history };
  const next = prev.level === level ? null : level;
  const rec = { level: next, note: prev.note || "", at: Date.now(), deck: c.deck, kind: c.kind, prompt: clip(c.prompt, 300), history: [...(prev.history || []).slice(-9), { level: next, at: Date.now() }], ...(prev.past ? { past: prev.past } : {}) };
  S.fb.set(id, rec);
  persist(`feedback/${id}`, rec);
  if (!next || next === "right" || next === "irrelevant") S.rewrites.delete(id);
  render();
}
function saveLevelNote(id, note) {
  const rec = S.fb.get(id);
  if (!rec) return;
  rec.note = str(note, 500).trim();
  rec.at = Date.now();
  persist(`feedback/${id}`, rec);
  toast("Note saved. It steers the cards Claude writes for you.");
}
async function rewriteLevel(id) {
  const c = S.byId.get(id), f = S.fb.get(id);
  if (!c || !claudeReady() || f?.resolved || !["basic", "detailed"].includes(f?.level)) return;
  markPause(id);
  const out = await ask(`rewrite:${id}`, rewritePrompt(c, f.level, f.note), { cache: false, modelTier: "complex" });
  if (!out) return;
  const card = cleanCard(out);
  if (!card) S.errs.set(`rewrite:${id}`, "Claude's rewrite came back incomplete. Try again.");
  else S.rewrites.set(id, card);
  render();
}
function acceptRewrite(id) {
  const c = S.byId.get(id), rw = S.rewrites.get(id), f = S.fb.get(id);
  if (!c || !rw) return;
  addCustom({ ...rw, source: `${c.source || "—"} · rewritten by Claude for your level` }, "Rewritten for your level", c.deck, { replaces: id, verify: true, level: f?.level || null });
  const m = { ...(S.mem.get(id) || blankMemory(Date.now())), suspended: true };
  S.mem.set(id, m);
  persist(`cards/${id}`, m);
  if (S.session) S.session.queue = S.session.queue.filter((q) => q !== id || q === S.session.current);
  S.rewrites.delete(id);
  toast("New version added as a new card. The original won't come back.");
  render();
}
/** Rebuild today's queue without disturbing the card on screen. */
function refreshQueue() {
  const sess = S.session;
  if (!sess) return;
  const q = buildQueue({ cards: S.cards, mem: S.mem, now: Date.now(), config: S.config, today: todayCounts(), sched: S.sched });
  sess.queue = q.queue.filter((id) => id !== sess.current);
  sess.counts = q.counts;
  if (!sess.current) advance(false);
}
function toggleFocus(deck) {
  const set = new Set(S.config.focusDecks || []);
  const on = !set.has(deck);
  on ? set.add(deck) : set.delete(deck);
  S.config = { ...S.config, focusDecks: [...set], updatedAt: Date.now(), history: [...(S.config.history || []).slice(-19), { at: Date.now(), by: "in-app", change: `${on ? "focus" : "unfocus"} ${deck}` }] };
  persist("config/scheduler", S.config);
  refreshQueue();
  toast(on ? `New cards now come from ${DECK_META.get(deck)?.code || deck} first.` : "Back to mixing new cards across decks.");
  render();
}
async function deckDraft(deck) {
  if (!claudeReady() || !DECK_META.has(deck)) return;
  const out = await ask(`deckdraft:${deck}`, deckDraftPrompt(deck), { cache: false, modelTier: "complex" });
  if (!out) return;
  S.add.drafts = (Array.isArray(out.cards) ? out.cards : []).map(cleanCard).filter(Boolean).slice(0, 5).map((d) => ({ ...d, generated: true }));
  S.add.drafted = true;
  S.add.origin = "deck";
  S.add.deck = deck;
  location.hash = "add";
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
  addCustom({ ...x.contrast, deck: S.byId.get(id).deck }, `Contrast card for ${id}`, undefined, { verify: true });
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
  toast(card ? "Reported. Claude fixes reported cards when you ask it to review your learning." : "Topic saved.");
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
  root.innerHTML = `${nav()}<div id="status-slot">${statusLine()}</div><main id="view">${{ review: viewReview, study: viewStudy, catalog: viewCatalog, add: viewAdd, tuning: viewTuning, guide: viewGuide }[v]()}</main>`;
  if (v === "guide") drawCurve();
  const ta = document.getElementById("answer-box");
  if (ta && S.session?.focusBox) { ta.focus(); S.session.focusBox = false; }
}
function renderStatus() { const el = document.getElementById("status-slot"); if (el) el.innerHTML = statusLine(); }
function nav() {
  return `<header class="top"><div class="brand"><span class="brand-mark" aria-hidden="true"></span><span>Card Catalog</span><a href="#guide" class="guide-link${S.view === "guide" ? " on" : ""}">Guide</a></div>
<nav class="tabs" aria-label="Views">${TABS.map((v) => `<a href="#${v}" class="tab${S.view === v ? " on" : ""}"${S.view === v ? ' aria-current="page"' : ""}>${VIEW_LABEL[v]}${v === "study" && studyIds().length ? ` <span class="count">${studyIds().length}</span>` : ""}</a>`).join("")}</nav></header>`;
}
function statusLine() {
  const store = S.mode === "db" ? "Saved to your account" : "This browser only";
  const c = S.session?.counts;
  const p = S.session ? progress() : null;
  const due = p ? `<span><b>${p.done}</b> done · <b>${p.toGo}</b> to go${p.back ? ` · <b>${p.back}</b> coming back` : ""}</span>${c?.backlog ? `<span class="warn-chip" title="Cards over today's review cap wait without penalty. The ones losing ground fastest are shown first."><b>${c.backlog}</b> waiting</span>` : ""}` : "";
  return `<div class="status"><span class="mono">${esc(today())}</span>${due}<span class="store${S.mode === "db" ? "" : " local"}">${store}</span>${S.unsaved ? `<span class="warn-chip">Unsaved changes</span>` : ""}${claudeReady() ? "" : `<span class="muted-chip">Claude off</span>`}</div>`;
}
function kindChip(c) { return `<span class="chip kind-${c.kind}">${c.kind}</span>`; }
function cardHead(c) {
  const d = DECK_META.get(c.deck);
  const lvl = mastery(S.mem.get(c.id));
  return `<div class="card-head"><span class="callno">${esc(callNumber(c))}</span>${kindChip(c)}<span class="deck-name">${esc(d?.title || c.deck)}</span><span class="chip m${lvl}" title="Mastery: how long you'd likely still recall it">${MASTERY[lvl]}</span>${c.verify ? `<span class="chip verify" title="Not fully certain. Check the source before relying on it.">verify</span>` : ""}${c.edited ? `<span class="chip">edited</span>` : ""}</div>`;
}
function viewReview() {
  const sess = S.session;
  const c = sess?.current && S.byId.get(sess.current);
  if (!c) return doneScreen();
  const m = S.mem.get(c.id);
  const busyGrade = S.busy.has(`grade:${c.id}`);
  const front = `<article class="index-card" aria-label="Card ${esc(callNumber(c))}">${cardHead(c)}
<div class="ruled"><p class="prompt">${fmt(c.prompt)}</p></div>
${sess.phase === "front" ? frontControls(c, busyGrade) : backSide(c, m)}
</article>`;
  const p = progress();
  return `${front}<div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${p.total}" aria-valuenow="${p.done}"><span style="width:${p.total ? (p.done / p.total) * 100 : 0}%"></span></div>
<p class="hint">${p.done} of ${p.total} cards done today${sess.from === "learning" || sess.from === "ahead" ? " · this one is back for another try" : isNew(m) ? " · new card" : ""}${totalReviews() < 40 ? ` · <a href="#guide">How this works</a>` : ""}</p>`;
}
function frontControls(c, busy) {
  const sess = S.session;
  const err = S.errs.get(`grade:${c.id}`);
  const can = claudeReady();
  return `<div class="answer-zone">
<label class="lbl" for="answer-box">${c.kind === "judgment" ? "What would you do?" : c.kind === "concept" ? "Explain it" : "Your answer"}</label>
<textarea id="answer-box" rows="${c.kind === "fact" ? 2 : 5}" placeholder="${can ? "Type your answer. Claude checks it and schedules the card." : "Type your answer, or just think it."}">${esc(sess.typed)}</textarea>
<div class="row">
${can ? `<button type="button" class="btn primary" data-act="grade" ${busy || !sess.typed.trim() ? "disabled" : ""}>${busy ? "Claude is checking…" : "Check my answer"}</button>` : ""}
<button type="button" class="btn${can ? " ghost" : " primary"}" data-act="reveal">${can ? "Skip to the answer" : "Show answer"}</button>
</div>${err ? `<p class="err">${esc(err)}</p>` : ""}<p class="keys">Ctrl+Enter checks your answer</p></div>`;
}
function backSide(c, m) {
  const sess = S.session;
  const g = sess.grade;
  const prev = previewIntervals({ mem: m, card: c, now: Date.now(), config: S.config, seenToday: seenToday(c.id) });
  const x = S.expl.get(c.id);
  const missed = (m?.agains || 0) >= 1;
  const busyX = S.busy.has(`explain:${c.id}`);
  const errX = S.errs.get(`explain:${c.id}`);
  const points = c.points?.length
    ? `<ol class="points">${c.points.map((p, i) => { const v = g?.points?.find((q) => q.i === i + 1); return `<li class="${v ? "v-" + v.verdict : ""}"><span>${fmt(p)}</span>${v ? `<em>${esc(v.verdict)}${v.note ? ": " + esc(v.note) : ""}</em>` : ""}</li>`; }).join("")}</ol>` : "";
  return `<div class="back">
${g ? `<div class="grade v${g.rating || 0}"><span class="lbl">Claude's evaluation</span>${g.rating ? `<p class="verdict">${VERDICT[g.rating]}</p>` : ""}<p>${esc(g.feedback)}</p>${g.wrong ? `<p class="wrong"><b>Not right:</b> ${esc(g.wrong)}</p>` : ""}</div>` : ""}
${sess.typed.trim() ? `<div class="yours"><span class="lbl">You wrote</span><p>${fmt(sess.typed.trim())}</p></div>` : ""}
<div class="answer"><span class="lbl">Answer</span><p>${fmt(c.answer)}</p>${points}${c.why ? `<p class="why">${fmt(c.why)}</p>` : ""}</div>
${levelRow(c)}
${deepBlock(c)}
${x ? explanationBlock(c, x) : ""}
<p class="source">Source: ${esc(c.source || "—")}</p>
${cardActions(c, m, x, missed, busyX)}${errX ? `<p class="err">${esc(errX)}</p>` : ""}
${S.cat.flagFor === c.id ? flagForm(c.id) : ""}
${whyTiming(c, m, g?.rating && !sess.override ? g.rating : null)}
</div>
${rateBar(c, m, g, prev)}`;
}
const totalReviews = () => [...S.logs.values()].reduce((n, items) => n + items.length, 0);
function plainDays(d) {
  if (d < 1) return "less than a day";
  if (d < 13.5) { const n = Math.round(d); return `${n} day${n === 1 ? "" : "s"}`; }
  if (d < 60) return `${Math.round(d / 7)} weeks`;
  if (d < 700) return `${Math.round(d / 30.4)} months`;
  return `${(d / 365).toFixed(1).replace(/\.0$/, "")} years`;
}
const plainAgo = (n) => (n <= 0 ? "earlier today" : n === 1 ? "yesterday" : `${n} days ago`);
const KIND_NAME = { fact: "fact", concept: "concept", judgment: "scenario" };
function whyTiming(c, m, r) {
  const link = `<p><a href="#guide">How the scheduler works</a></p>`;
  if (!r) {
    return `<details class="why-timing"><summary>What do these buttons do?</summary><p>Each button shows when the card would come back. Pick <b>Knew it</b> if you got it with some effort, <b>Easy</b> only if it was instant, <b>Partly</b> if you had part of it, and <b>Didn't know</b> if you missed it. Higher ratings mean longer gaps.</p>${link}</details>`;
  }
  const now = Date.now();
  const out = previewOutcome({ mem: m, card: c, now, config: S.config, rating: r, seenToday: seenToday(c.id) });
  const k = S.config.kinds[c.kind] || S.config.kinds.fact;
  const before = isNew(m)
    ? "This is your first time answering this card."
    : `You last answered it ${plainAgo(elapsedDays(m, now, S.config.rolloverHour))}, and the scheduler put your chance of recalling it today at ${pct(currentR(m, now, S.config, S.sched))}.`;
  const verdict = `Claude's verdict, ${VERDICT[r]}, counts as "${RATING_UI[r]}".`;
  const after = isLearning(out.mem)
    ? `It isn't solid yet, so it comes back in ${fmtInterval(out.intervalMs)} for one more try today. After that it moves to another day, whatever the result.`
    : out.movedOn
    ? `You've already retried it today, and more repeats this evening add little, so it comes back in ${plainDays(out.intervalMs / DAY)}. If the idea isn't clicking, Go deeper will help more than another attempt.`
    : `After this review the scheduler estimates your recall stays above 90% for about ${plainDays(out.mem.stability)}. Your target for ${KIND_NAME[c.kind] || "fact"} cards is ${pct(k.retention)}, so it comes back in ${plainDays(out.intervalMs / DAY)}, when your recall is predicted to reach that target.`;
  return `<details class="why-timing"><summary>Why this timing?</summary><p>${esc(before)} ${esc(verdict)} ${esc(after)}</p>${link}</details>`;
}
function cardActions(c, m, x, missed, busyX) {
  const can = claudeReady();
  return `<div class="row small">
${can && !S.deep.has(c.id) && !S.busy.has("deep:" + c.id) ? `<button type="button" class="btn" data-act="deep" data-id="${c.id}">Go deeper</button>` : ""}
${S.view === "review" ? (studyIds().includes(c.id) ? `<button type="button" class="btn ghost" data-act="study-open" data-id="${c.id}">Open in Study</button>` : `<button type="button" class="btn ghost" data-act="study-save" data-id="${c.id}" title="Save it to the Study tab to work through later. It doesn't change the schedule.">Study later</button>`) : ""}
${can && (missed || x) ? `<button type="button" class="btn ${isPersistentMiss(m) && !x ? "primary" : "ghost"}" data-act="explain" data-id="${c.id}" ${busyX ? "disabled" : ""}>${busyX ? "Claude is diagnosing…" : x ? "Re-diagnose my misses" : `Missed ${m.agains}×. Why do I keep missing this?`}</button>` : ""}
<button type="button" class="btn ghost" data-act="flag-open" data-id="${c.id}" title="Something about the card is wrong, unclear or not useful. Claude fixes reported cards when you ask it to review your learning.">Report a problem</button>
<button type="button" class="btn ghost" data-act="${m?.suspended ? "unsuspend" : "suspend"}" data-id="${c.id}" title="${m?.suspended ? "Put this card back into your reviews." : "Take this card out of your reviews. You can bring it back from the Catalog."}">${m?.suspended ? "Show again" : "Stop showing"}</button>
</div>`;
}
function rateBar(c, m, g, prev) {
  const sess = S.session;
  if (g?.rating && !sess.override) {
    const after = mastery(previewOutcome({ mem: m, card: c, now: Date.now(), config: S.config, rating: g.rating, seenToday: seenToday(c.id) }).mem);
    const before = mastery(m);
    return `<div class="rate accept"><button type="button" class="rate-btn next r${g.rating}" data-act="rate" data-r="${g.rating}"><span>Next</span><small>${g.rating === 1 ? "this card comes back" : "see it again"} in ${fmtInterval(prev[g.rating])} · ${MASTERY[before]}${after !== before ? ` → ${MASTERY[after]}` : ""}</small></button>
<button type="button" class="btn ghost change" data-act="override">Change rating</button></div>`;
  }
  return `<div class="rate" role="group" aria-label="How well did you know it?">
${[1, 2, 3, 4].map((r) => `<button type="button" class="rate-btn r${r}${g?.rating === r ? " suggested" : ""}" data-act="rate" data-r="${r}"><span>${RATING_UI[r]}</span><small class="mono">${fmtInterval(prev[r])}</small></button>`).join("")}
</div>`;
}
function deepBlock(c) {
  const id = c.id, rec = S.deep.get(id);
  const busy = S.busy.has(`deep:${id}`), fbusy = S.busy.has(`follow:${id}`);
  const err = S.errs.get(`deep:${id}`) || S.errs.get(`follow:${id}`);
  if (!rec && !busy) return err ? `<p class="err">${esc(err)}</p>` : "";
  const thinking = '<p class="muted">Thinking…</p>';
  const body = rec ? md(rec.text) : md(S.streamText.get(`deep:${id}`)) || thinking;
  const fu = (rec?.followups || []).map((f) => `<div class="fq"><p class="q">${esc(f.q)}</p><div class="md">${md(f.a)}</div></div>`).join("");
  const sess = S.session, inReview = S.view === "review" && sess?.current === id;
  const note = inReview && rec
    ? `<p class="deep-note">Saved to <a href="#study" data-act="study-open" data-id="${id}">Study</a>, where you can keep going anytime. This card waits until you press Next, and time spent here doesn't count as review time.${sess.grade?.rating >= 3 && !sess.override ? " If this showed you didn't really get it, press <b>Change rating</b> so the card comes back sooner." : ""}</p>`
    : "";
  return `<div class="deep"><span class="lbl">Deeper dive</span><div class="md" id="deep-${id}">${body}</div>${fu}${note}
${fbusy ? `<div class="fq"><p class="q">${esc(S.pendingQ.get(id) || "")}</p><div class="md" id="follow-${id}">${md(S.streamText.get(`follow:${id}`)) || thinking}</div></div>` : ""}
${rec && claudeReady() ? `<form class="followup" data-form="followup" data-id="${id}"><label class="sr" for="fq-${id}">Ask a follow-up question</label><input id="fq-${id}" name="q" type="text" placeholder="Ask a follow-up question" autocomplete="off"><button class="btn" type="submit" ${fbusy ? "disabled" : ""}>Ask</button></form>` : ""}
${err ? `<p class="err">${esc(err)}</p>` : ""}</div>`;
}
function levelRow(c) {
  const f0 = S.fb.get(c.id), f = f0?.resolved ? null : f0, lv = f?.level, rw = S.rewrites.get(c.id), m = S.mem.get(c.id);
  const acted = f0?.resolved && !c.retired ? `<p class="muted">You marked an earlier version "${esc((LEVEL_LABEL[f0.level] || "").toLowerCase())}". Claude ${esc(f0.resolved.action || "updated it")}. Mark this version if it's still off.</p>` : "";
  const busy = S.busy.has(`rewrite:${c.id}`), err = S.errs.get(`rewrite:${c.id}`), can = claudeReady();
  const follow = {
    basic: [can && ["rewrite-level", "Rewrite it harder"], !m?.suspended && ["suspend", "Stop showing (I know this)"]],
    detailed: [can && ["rewrite-level", "Rewrite around the principle"], !m?.suspended && ["suspend", "Stop showing"]],
    irrelevant: [!m?.suspended && ["suspend", "Stop showing"]],
  }[lv] || [];
  return `<div class="level"><div class="level-row" role="group" aria-label="Is this card at the right level for you?"><span class="lbl inline">Level</span>
${LEVELS.map(([k, t]) => `<button type="button" class="pill-btn${lv === k ? " on" : ""}" data-act="level" data-id="${c.id}" data-level="${k}" aria-pressed="${lv === k}">${t}</button>`).join("")}</div>
${lv ? `<div class="row small">${follow.filter(Boolean).map(([a, t]) => `<button type="button" class="btn ghost" data-act="${a}" data-id="${c.id}" ${a === "rewrite-level" && busy ? "disabled" : ""}>${a === "rewrite-level" && busy ? "Claude is rewriting…" : t}</button>`).join("")}
<form class="level-note" data-form="level-note" data-id="${c.id}"><label class="sr" for="ln-${c.id}">What would make it better?</label><input id="ln-${c.id}" name="note" type="text" placeholder="Optional: what would be more useful?" value="${esc(f?.note || "")}" autocomplete="off"><button class="btn ghost" type="submit">Save note</button></form></div>` : ""}
${acted}${err ? `<p class="err">${esc(err)}</p>` : ""}${rw ? rewritePreview(c, rw) : ""}</div>`;
}
function rewritePreview(c, rw) {
  return `<div class="rewrite"><span class="lbl">Claude's rewrite · ${esc(rw.kind)}</span>${rw.change ? `<p class="muted">${esc(rw.change)}</p>` : ""}
<p class="prompt sm">${fmt(rw.prompt)}</p><p>${fmt(rw.answer)}</p>${rw.points.length ? `<ol class="points">${rw.points.map((p) => `<li><span>${fmt(p)}</span></li>`).join("")}</ol>` : ""}
<div class="row small"><button type="button" class="btn primary" data-act="rewrite-accept" data-id="${c.id}">Use this instead</button><button type="button" class="btn ghost" data-act="rewrite-level" data-id="${c.id}" ${S.busy.has(`rewrite:${c.id}`) ? "disabled" : ""}>Try another</button><button type="button" class="btn ghost" data-act="rewrite-discard" data-id="${c.id}">Keep the original</button></div>
<p class="muted">The new version starts as a new card, marked verify because Claude wrote it. The original stops showing, and its history is kept.</p></div>`;
}
function deckLevelLine(deck) {
  const n = { basic: 0, right: 0, detailed: 0, irrelevant: 0 };
  for (const [id, f] of S.fb) if (f.level && S.byId.get(id)?.deck === deck) n[f.level]++;
  const parts = LEVELS.filter(([k]) => n[k]).map(([k, t]) => `${n[k]} ${t.toLowerCase()}`);
  const busy = S.busy.has(`deckdraft:${deck}`), err = S.errs.get(`deckdraft:${deck}`);
  const focused = (S.config.focusDecks || []).includes(deck);
  return `<div class="row small"><button type="button" class="btn${focused ? " primary" : ""}" data-act="focus-deck" data-deck="${deck}" aria-pressed="${focused}" title="Introduce new cards from this deck before the others">${focused ? "Focused: new cards come from here first" : "Focus new cards here"}</button></div>
<div class="row small"><span class="muted">${parts.length ? `Your level marks here: ${parts.join(" · ")}.` : "No level marks in this deck yet. Mark cards as you review and new drafts follow them."}</span>
${claudeReady() ? `<button type="button" class="btn" data-act="deck-draft" data-deck="${deck}" ${busy ? "disabled" : ""}>${busy ? "Drafting…" : "Draft more cards at my level"}</button>` : ""}</div>${err ? `<p class="err">${esc(err)}</p>` : ""}`;
}
function explanationBlock(c, x) {
  return `<div class="tailored"><span class="lbl">Aimed at your misses · ${esc(new Date(x.at).toLocaleDateString())}</span>
${x.diagnosis ? `<p><b>${esc(x.diagnosis)}</b></p>` : ""}<p>${fmt(x.explanation)}</p>${x.hook ? `<p class="hook">${fmt(x.hook)}</p>` : ""}
${x.contrast || x.rewrite ? `<div class="row small">${x.contrast ? `<button type="button" class="btn ghost" data-act="contrast" data-id="${c.id}">Add contrast card: “${esc(clip(x.contrast.prompt, 60))}”</button>` : ""}${x.rewrite ? `<button type="button" class="btn ghost" data-act="rewrite" data-id="${c.id}">Use Claude's rewrite of this card</button>` : ""}</div>` : ""}</div>`;
}
function flagForm(id) {
  const reasons = id ? ["Wrong", "Unclear", "Not useful for my work", "Too easy", "Other"] : ["Topic I want covered"];
  return `<form class="flag" data-form="flag" data-id="${id || ""}"><span class="lbl">${id ? "What's wrong with this card?" : "Suggest a topic"}</span>${id ? `<p class="muted">Reports are saved for your next "review my learning" session with Claude, which fixes or retires the card.</p>` : ""}
<div class="row small">${reasons.map((r, i) => `<label class="pill"><input type="radio" name="reason" value="${esc(r)}" ${i === 0 ? "checked" : ""}> ${esc(r)}</label>`).join("")}</div>
<textarea id="flag-note-${id || "topic"}" name="note" rows="2" placeholder="${id ? "Optional: what should it say?" : "What do you keep needing to know at work?"}"></textarea>
<div class="row small"><button class="btn primary" type="submit">${id ? "Save report" : "Save topic"}</button>${id ? `<button class="btn ghost" type="button" data-act="flag-close">Cancel</button>` : ""}</div></form>`;
}
function doneScreen() {
  const sess = S.session;
  const now = Date.now();
  const f = forecast({ cards: S.cards, mem: S.mem, now, config: S.config, days: 8 });
  const left = S.cards.filter((c) => isNew(S.mem.get(c.id)) && !c.retired).length;
  const items = S.logs.get(today()) || [];
  const cardsToday = new Set(items.map((l) => l.c)).size;
  const msg = items.length ? `${cardsToday} card${cardsToday === 1 ? "" : "s"} reviewed today.` : left ? "Nothing due right now." : "Nothing due, and no new cards left.";
  const backlog = sess.counts.backlog;
  return `<section class="panel done"><h2>${items.length ? "Done for today" : "All caught up"}</h2><p>${msg}</p>
${backlog ? `<p>${backlog} overdue cards are waiting beyond today's cap of ${S.config.reviewsPerDay}. They lose little by waiting: the ones decaying fastest are shown first each day. New cards stay paused until the backlog clears.</p>` : ""}
<p class="mono strip">${f.map((n, i) => `<span><small>${i === 0 ? "today" : i === 1 ? "tmrw" : "+" + i}</small>${n}</span>`).join("")}</p>
<p class="muted">${masterySummary(S.cards)}. ${left ? `${S.config.newPerDay} new cards are introduced per day.` : ""}</p>
<div class="row"><a class="btn" href="#add">Turn a note into cards</a><a class="btn ghost" href="#study">Study</a><a class="btn ghost" href="#guide">How it works</a></div></section>`;
}

function masterySummary(cards) {
  const n = [0, 0, 0, 0, 0];
  for (const c of cards) if (!c.retired) n[mastery(S.mem.get(c.id))]++;
  return MASTERY.map((label, i) => (n[i] ? `${n[i]} ${label.toLowerCase()}` : "")).filter(Boolean).join(" · ");
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
<div class="drawers">${decks.map((d) => { const s = deckStats(d.deck); return `<button type="button" class="drawer${S.cat.deck === d.deck && !q ? " on" : ""}" data-act="deck" data-deck="${d.deck}"><span class="callno">${d.code}</span><span class="dname">${esc(d.title)}</span><span class="dmeta">${s.total} cards: ${masterySummary(S.cards.filter((c) => c.deck === d.deck))}</span></button>`; }).join("")}</div>
<p class="muted">Mastery is how long you'd likely still recall a card: <b>learning</b> (days), <b>familiar</b> (up to 3 weeks), <b>solid</b> (up to 3 months), <b>mastered</b> (longer). Reviews raise it; misses lower it.</p>
${S.cat.deck && !q ? `<p class="blurb">${esc(DECK_META.get(S.cat.deck)?.blurb || "")}</p>${deckLevelLine(S.cat.deck)}` : ""}
${list.length ? `<ul class="cardlist">${list.map(cardRow).join("")}</ul>` : q ? `<p class="muted">No cards match “${esc(S.cat.q)}”.</p>` : `<p class="muted">Open a drawer to browse its cards.</p>`}</section>`;
}
function cardRow(c) {
  const m = S.mem.get(c.id);
  const lvl = MASTERY[mastery(m)].toLowerCase();
  const st = c.retired ? "retired" : m?.suspended ? "not showing" : isNew(m) ? "new" : isLearning(m) ? "learning · back today" : `${lvl} · next ${new Date(m.due).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  const open = S.cat.open === c.id;
  return `<li class="crow${open ? " open" : ""}"><button type="button" class="crow-head" data-act="open" data-id="${c.id}" aria-expanded="${open}"><span class="callno">${esc(callNumber(c))}</span><span class="cprompt">${esc(clip(c.prompt, 110))}</span><span class="cmeta">${st}${m?.agains ? ` · missed ${m.agains}×` : ""}${S.deep.has(c.id) ? " · deeper dive saved" : ""}</span></button>
${open ? `<div class="cdetail">${cardHead(c)}<p class="prompt sm">${fmt(c.prompt)}</p><p>${fmt(c.answer)}</p>${c.points?.length ? `<ol class="points">${c.points.map((p) => `<li><span>${fmt(p)}</span></li>`).join("")}</ol>` : ""}${c.why ? `<p class="why">${fmt(c.why)}</p>` : ""}
${deepBlock(c)}${S.expl.get(c.id) ? explanationBlock(c, S.expl.get(c.id)) : ""}<p class="source">Source: ${esc(c.source || "—")}${m && !isNew(m) ? ` · reviewed ${m.reps}×` : ""}</p>
${levelRow(c)}
${cardActions(c, m, S.expl.get(c.id), (m?.agains || 0) >= 1, S.busy.has("explain:" + c.id))}
${S.errs.get("explain:" + c.id) ? `<p class="err">${esc(S.errs.get("explain:" + c.id))}</p>` : ""}${S.cat.flagFor === c.id ? flagForm(c.id) : ""}</div>` : ""}</li>`;
}

function deckOptions(sel) {
  return [...DECK_META.values()].map((d) => `<option value="${d.deck}" ${d.deck === sel ? "selected" : ""}>${esc(d.code)} · ${esc(d.title)}</option>`).join("");
}
function viewAdd() {
  const a = S.add;
  const busy = S.busy.has("draft");
  return `<section class="panel"><h2>Turn a note into cards</h2>
<p class="muted">Paste something you learned: a meeting takeaway, a passage from a book, a mistake you don't want to repeat. Claude drafts cards that keep the general principle and leave out the names of people, systems and organizations. You edit or discard them. Your notes and cards stay in this private artifact.</p>
<label class="lbl" for="add-note">Note</label><textarea id="add-note" rows="6" placeholder="e.g. We reran a failed load and doubled a month of records, because the job appends instead of replacing the partition…">${esc(a.note)}</textarea>
<div class="row"><label class="lbl inline" for="add-deck">Deck</label><select id="add-deck">${deckOptions(a.deck)}</select>
${claudeReady() ? `<button type="button" class="btn primary" data-act="draft" ${busy || !a.note.trim() ? "disabled" : ""}>${busy ? "Drafting…" : "Draft cards"}</button>` : `<span class="muted">Claude is off. Use the manual form below.</span>`}</div>
${S.errs.get("draft") ? `<p class="err">${esc(S.errs.get("draft"))}</p>` : ""}
${a.drafts.length ? `${a.origin === "deck" ? `<p class="muted">Drafted for ${esc(DECK_META.get(a.deck)?.title || a.deck)} at the level your marks point to. Claude wrote these from its own knowledge, so they're marked verify once added. Edit anything before adding.</p>` : ""}<div class="drafts">${a.drafts.map((d, i) => draftEditor(d, i)).join("")}</div>` : a.drafted ? `<p class="muted">Nothing in that note seemed worth a card.</p>` : ""}
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
<label class="lbl" for="ds-${i}">Source</label><input id="ds-${i}" name="source" type="text" value="${esc(d.source || "")}" placeholder="Optional: where this comes from">
<input type="hidden" name="generated" value="${d.generated ? "1" : ""}">
<div class="row small"><button class="btn primary" type="submit">Add to ${esc(DECK_META.get(S.add.deck)?.code || "INB")}</button>${i !== "m" ? `<button class="btn ghost" type="button" data-act="discard" data-i="${i}">Discard</button>` : ""}</div></form>`;
}

function viewStudy() {
  const ids = studyIds();
  const open = S.studyOpen && S.byId.get(S.studyOpen);
  const back = S.session?.current && S.byId.get(S.session.current);
  return `<section class="panel"><h2>Study</h2>
<p class="muted">Review is for recalling; Study is for understanding. Take as long as you like here. Nothing in Study changes when cards come back.${back ? ` Your review is paused on <a href="#review">${esc(callNumber(back))}</a>.` : ""}</p>
${open ? studyDetail(open) : ""}
${ids.length ? `<ul class="cardlist">${ids.map((id) => { const c = S.byId.get(id), d = S.deep.get(id); return `<li class="crow${S.studyOpen === id ? " open" : ""}"><button type="button" class="crow-head" data-act="study-open" data-id="${id}"><span class="callno">${esc(callNumber(c))}</span><span class="cprompt">${esc(clip(c.prompt, 110))}</span><span class="cmeta">${d ? `deep dive${d.followups?.length ? ` · ${d.followups.length} follow-up${d.followups.length > 1 ? "s" : ""}` : ""}` : "saved, not explored yet"}</span></button></li>`; }).join("")}</ul>`
    : `<p class="muted">Nothing saved yet. On any card in Review, press <b>Go deeper</b> or <b>Study later</b> and it lands here.</p>`}
</section>
${missesPanels()}`;
}
function studyDetail(c) {
  const can = claudeReady(), m = S.mem.get(c.id), x = S.expl.get(c.id);
  return `<article class="study-detail">${cardHead(c)}<p class="prompt sm">${fmt(c.prompt)}</p>
<div class="answer"><span class="lbl">Answer</span><p>${fmt(c.answer)}</p>${c.points?.length ? `<ol class="points">${c.points.map((p) => `<li><span>${fmt(p)}</span></li>`).join("")}</ol>` : ""}${c.why ? `<p class="why">${fmt(c.why)}</p>` : ""}</div>
${deepBlock(c)}${x ? explanationBlock(c, x) : ""}
<p class="source">Source: ${esc(c.source || "—")}</p>
${levelRow(c)}
<div class="row small">${can && !S.deep.has(c.id) && !S.busy.has("deep:" + c.id) ? `<button type="button" class="btn primary" data-act="deep" data-id="${c.id}">Go deeper</button>` : ""}
${can && (m?.agains || 0) >= 1 ? `<button type="button" class="btn ghost" data-act="explain" data-id="${c.id}" ${S.busy.has("explain:" + c.id) ? "disabled" : ""}>${S.busy.has("explain:" + c.id) ? "Claude is diagnosing…" : x ? "Re-diagnose my misses" : "Why do I keep missing this?"}</button>` : ""}
<button type="button" class="btn ghost" data-act="study-remove" data-id="${c.id}">Remove from Study</button>
<button type="button" class="btn ghost" data-act="study-close">Close</button></div>
${S.errs.get("explain:" + c.id) ? `<p class="err">${esc(S.errs.get("explain:" + c.id))}</p>` : ""}</article>`;
}
function missesPanels() {
  const missed = S.cards.filter((c) => !c.retired && !S.mem.get(c.id)?.suspended).map((c) => ({ c, m: S.mem.get(c.id) })).filter(({ m }) => m?.agains > 0).sort((a, b) => b.m.agains - a.m.agains);
  const ins = S.insights;
  const busy = S.busy.has("patterns");
  return `<section class="panel"><h2>What you keep missing</h2>
${ins ? insightsBlock(ins) : `<p class="muted">No analysis yet. Once a few cards have misses, ask Claude to look for patterns across them.</p>`}
${claudeReady() ? `<div class="row"><button type="button" class="btn primary" data-act="patterns" ${busy || missed.length < 3 ? "disabled" : ""}>${busy ? "Claude is reading your history…" : "Analyze my misses"}</button>${missed.length < 3 ? `<span class="muted">Needs misses on at least 3 cards (${missed.length} so far).</span>` : ""}</div>` : ""}
${S.errs.get("patterns") ? `<p class="err">${esc(S.errs.get("patterns"))}</p>` : ""}</section>
<section class="panel"><h2>Persistent misses</h2>${missed.length ? `<ul class="cardlist">${missed.slice(0, 30).map(({ c, m }) => `<li class="crow"><button type="button" class="crow-head" data-act="study-open" data-id="${c.id}"><span class="callno">${esc(callNumber(c))}</span><span class="cprompt">${esc(clip(c.prompt, 110))}</span><span class="cmeta mono">${m.agains}× missed${isLeech(m) ? " · leech" : ""}${S.expl.get(c.id) ? " · explained" : ""}</span></button></li>`).join("")}</ul>` : `<p class="muted">None yet.</p>`}
<p class="muted">Open a missed card to study it. "Why do I keep missing this?" looks at all your attempts on it. A card with four lapses is a leech: it usually needs rewriting or splitting, not more reps.</p></section>
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
<p class="muted">The scheduler predicts how likely you are to recall each card when it comes due. Below, its predictions are compared with what actually happened. Counts only include reviews of cards already past the learning stage. <a href="#guide">The Guide</a> explains the scheduler in plain terms.</p>
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
// ---------- guide ----------
let curveCache = null, curveRO = null;
function guideCurve() {
  const key = JSON.stringify([S.config.parameters, S.config.kinds.fact, S.config.maximumInterval, S.config.intervalScale]);
  if (curveCache?.key !== key) curveCache = { key, data: simulateCurve({ config: S.config, kind: "fact", days: 240 }) };
  return curveCache.data;
}
function viewGuide() {
  const cfg = S.config, c = guideCurve();
  const revs = c.reviews.slice(1);
  const t = (k) => pct(cfg.kinds[k].retention);
  const gaps = revs.map((r) => plainDays(r.gap));
  const label = `Line chart of the chance you'd recall a fact over ${c.days} days. With reviews, recall stays between ${pct(Math.min(...c.withR))} and 100%, with reviews on days ${revs.map((r) => r.day).join(", ")}. Without reviews, it falls to ${pct(c.without[c.days])} by day ${c.days}.`;
  return `<section class="panel guide"><h2>How Card Catalog works</h2>
<p class="muted">A two-minute read. The short version: answer, let Claude judge it, press Next, and come back most days.</p>

<h3>The daily routine</h3>
<ol>
<li>Open <b>Review</b> and type an answer to the question, even a rough one.</li>
<li>Press <b>Check my answer</b>. Claude compares it with the reference answer and the key points.</li>
<li>Read the verdict and the answer. If it didn't click, press <b>Go deeper</b> and ask follow-up questions.</li>
<li>Press <b>Next</b>. The card leaves today's pile and comes back when the scheduler says.</li>
<li>Stop when nothing is left. Most days take 5 to 10 minutes. Skipped days are fine.</li>
</ol>

<h3>How the scheduler decides when you see a card</h3>
<p>Memory fades on a predictable curve, and each successful recall makes the next fade slower. The scheduler (FSRS, the open algorithm Anki also offers) keeps two estimates for every card:</p>
<ul>
<li><b>Stability</b>: how many days until your chance of recalling the card falls to 90%. A new card you get right starts at about ${plainDays(c.reviews[0].stability)}.</li>
<li><b>Difficulty</b>: how hard the card is for you. Stability grows more slowly on difficult cards.</li>
</ul>
<p>A card comes due when your predicted chance of recalling it falls to its target: ${t("fact")} for facts, ${t("concept")} for concepts, ${t("judgment")} for scenarios. That's the useful moment to review: recall takes some effort, which is what strengthens the memory, and you'll usually still get it right.</p>
<p>Each correct answer multiplies stability, so the gaps grow fast. A fact you get right every time comes back after ${gaps.join(", then ")}. That's ${revs.length} reviews in ${Math.round(c.days / 30.4)} months. A miss cuts stability and brings the card back in 10 minutes, then again after a short gap.</p>

<figure class="chart-card"><figcaption><p class="chart-title">Chance you'd recall a fact over ${Math.round(c.days / 30.4)} months</p>
<div class="legend"><span><i class="key s1"></i>With reviews</span><span><i class="key s2"></i>Without reviews</span></div></figcaption>
<div id="curve" class="curve" tabindex="0" role="img" aria-label="${esc(label)}"></div>
<p class="muted">Each dot is a review. Recall had drifted down to about ${t("fact")}, and answering correctly restores it and slows the next fade. Hover or tap the chart, or focus it and use the arrow keys, to read values.</p></figure>
<div class="scroll"><table><thead><tr><th>Review</th><th>Day</th><th>Gap</th><th>Recall then</th><th>Memory now lasts</th></tr></thead><tbody>
<tr><td>First answer</td><td class="num">0</td><td class="num">–</td><td class="num">–</td><td class="num">${plainDays(c.reviews[0].stability)}</td></tr>
${revs.map((r, i) => `<tr><td>${i + 1}</td><td class="num">${r.day}</td><td class="num">${plainDays(r.gap)}</td><td class="num">${pct(r.rBefore)}</td><td class="num">${plainDays(r.stability)}</td></tr>`).join("")}
</tbody></table></div>
<p class="muted">"Memory now lasts" is stability: days until recall is predicted to fall to 90%. Under each graded card, <b>Why this timing?</b> shows the same numbers for that card.</p>

<h3>Reviewing and studying</h3>
<p>Review is for recalling what you already understand; that's what the scheduler optimizes. When a card shows you don't really understand something, switch to studying. <b>Go deeper</b> starts an explanation aimed at your answer, and the card is saved to the <b>Study</b> tab, where you can keep asking questions for as long as you like. Nothing in Study changes the schedule. The review card waits until you press <b>Next</b>, even if you leave for Study, and the time doesn't count as review time.</p>
<p>After studying, rate honestly. If you didn't really know it, press <b>Change rating</b> and pick <b>Partly</b> or <b>Didn't know</b>, so the card comes back soon and tests the understanding you just built.</p>

<h3>Calibrating the cards</h3>
<p>Under each answer, mark the card's level: <b>Too basic</b>, <b>Just right</b>, <b>Too detailed</b> or <b>Not useful</b>. It's one tap, and you can add a note. Too basic or too detailed offers a rewrite: Claude drafts a harder or more principle-focused version for you to accept or discard. An accepted rewrite starts as a new card and the original retires. Your marks also steer every card Claude writes for you: rewrites, drafts from your notes, and <b>Draft more cards at my level</b> in each Catalog deck.</p>
<p>There's no "too hard". If a relevant card is hard, it's the one to practise; that's the scheduler's job. If it's hard because it's trivia you don't need, mark it too detailed.</p>

<h3>What Claude's verdict does</h3>
<div class="scroll"><table><thead><tr><th>Verdict</th><th>Counts as</th><th>What happens</th></tr></thead><tbody>
<tr><td>Not yet</td><td>Didn't know</td><td>Stability drops. The card comes back in 10 minutes for another try.</td></tr>
<tr><td>Partly right</td><td>Partly</td><td>A shorter gap than a full success, and the card counts as a little more difficult. On a card you're still learning, it comes back once the same day.</td></tr>
<tr><td>Right</td><td>Knew it</td><td>Normal growth.</td></tr>
<tr><td>Spot on</td><td>Easy</td><td>The longest gap.</td></tr>
</tbody></table></div>
<p>Claude judges how well you know it, and the scheduler turns that into when. Press <b>Change rating</b> if Claude misjudged; your choice is final.</p>

<h3>Today's count</h3>
<ul>
<li><b>Done</b>: cards finished for today.</li>
<li><b>To go</b>: cards due today that you haven't seen yet, plus today's new cards.</li>
<li><b>Coming back</b>: cards you missed or only partly knew, waiting a few minutes for another try.</li>
</ul>
<p>No card shows more than ${cfg.maxShowingsPerDay || 3} times in a day. A partly-right answer gets one retry and then waits for another day, because a night's sleep does more for a half-learned idea than a fourth attempt in one evening. If a card keeps coming back partly right, use <b>Go deeper</b> or <b>Why do I keep missing this?</b>.</p>
<p>New cards rotate across decks. To learn one deck sooner, open it in the Catalog and press <b>Focus new cards here</b>. Each day brings up to ${cfg.newPerDay} new cards and at most ${cfg.reviewsPerDay} reviews. After days off, overdue cards beyond that cap wait without penalty, and the ones fading fastest come first. New cards pause until the pile clears. Change these limits in Tuning.</p>

<h3>Mastery</h3>
<p>How long you'd likely still recall a card, from its stability: <b>learning</b> (days), <b>familiar</b> (up to 3 weeks), <b>solid</b> (up to 3 months), <b>mastered</b> (longer). Correct answers raise it and misses lower it. The Catalog shows mastery by deck.</p>

<h3>Card kinds</h3>
<ul>
<li><b>fact</b>: a short answer. Target ${t("fact")}.</li>
<li><b>concept</b>: explain an idea in a few sentences. Target ${t("concept")}.</li>
<li><b>judgment</b>: a scenario where you decide what to do. Target ${t("judgment")}.</li>
</ul>
<p>Written answers take longer, so concept and judgment cards aim a little lower and come back less often. That gives up a little recall to save a lot of time.</p>

<h3>Buttons on a card</h3>
<dl>
<dt>Go deeper</dt><dd>A longer explanation aimed at your answer. Ask follow-up questions under it. It's saved to the Study tab.</dd>
<dt>Study later</dt><dd>Saves the card to the Study tab without exploring it now.</dd>
<dt>Level</dt><dd>Too basic, Just right, Too detailed, Not useful. Tells Claude what level of card you need, and offers a rewrite or retirement.</dd>
<dt>Why do I keep missing this?</dt><dd>Appears after a miss. Claude looks at all your attempts on the card and explains the specific confusion.</dd>
<dt>Report a problem</dt><dd>The card is wrong, unclear or not useful. Claude fixes or retires reported cards when you ask it to review your learning.</dd>
<dt>Stop showing</dt><dd>Takes the card out of your reviews. Bring it back from the Catalog.</dd>
<dt>Undo</dt><dd>In the message after each card. It reverses your last rating.</dd>
<dt>Skip to the answer</dt><dd>For days you'd rather not type: see the answer and rate yourself.</dd>
</dl>

<h3>The other tabs</h3>
<dl>
<dt>Catalog</dt><dd>Browse every card by deck, with mastery, saved deep dives and explanations.</dd>
<dt>Add</dt><dd>Paste a note and Claude drafts cards from it, keeping the general principle. Or write a card yourself.</dd>
<dt>Study</dt><dd>Cards you went deeper on or saved, with their explanations and follow-ups. Also the cards you keep missing, and a cross-card analysis of what's behind them.</dd>
<dt>Tuning</dt><dd>Daily limits, and a check of how well the scheduler's predictions match your actual answers.</dd>
<dt>Guide</dt><dd>This page. The link sits next to the app name.</dd>
</dl>

<h3>How it adapts to you</h3>
<p>At first the scheduler uses default settings fitted on a large public dataset of Anki reviews. Tuning compares its predictions with your answers, and after a few hundred reviews it can tell whether you forget faster or slower than the default. After about 500, ask Claude to refit the scheduler to you; the prompt is in Tuning.</p>
</section>`;
}
function curveGeom(W, days) {
  const H = 246, m = { l: 42, r: 14, t: 20, b: 42 };
  const iw = Math.max(80, W - m.l - m.r), ih = H - m.t - m.b, lo = 0.4;
  return { W, H, m, iw, ih, x: (d) => m.l + (d / days) * iw, y: (r) => m.t + (1 - (r - lo) / (1 - lo)) * ih, day: (px) => Math.round(((px - m.l) / iw) * days) };
}
function curveSVG(c, W) {
  const { H, m, x, y } = curveGeom(W, c.days);
  const f = (n) => n.toFixed(1);
  const rev = new Map(c.reviews.slice(1).map((r) => [r.day, r]));
  let pw = `M${f(x(0))},${f(y(1))}`;
  for (let d = 1; d <= c.days; d++) {
    const r = rev.get(d);
    pw += r ? `L${f(x(d))},${f(y(r.rBefore))}L${f(x(d))},${f(y(1))}` : `L${f(x(d))},${f(y(c.withR[d]))}`;
  }
  const po = c.without.map((r, d) => `${d ? "L" : "M"}${f(x(d))},${f(y(r))}`).join("");
  const grid = [0.5, 0.6, 0.7, 0.8, 0.9, 1].map((v) => `<line class="gl${Math.abs(v - c.target) < 1e-9 ? " target" : ""}" x1="${m.l}" x2="${W - m.r}" y1="${f(y(v))}" y2="${f(y(v))}"/><text class="ax" x="${m.l - 6}" y="${f(y(v) + 4)}" text-anchor="end">${Math.round(v * 100)}%</text>`).join("");
  const ticks = [0, 60, 120, 180, 240].filter((d) => d <= c.days).map((d) => `<text class="ax" x="${f(x(d))}" y="${H - m.b + 16}" text-anchor="middle">${d}</text>`).join("");
  const dots = c.reviews.slice(1).map((r) => `<circle class="dot" cx="${f(x(r.day))}" cy="${f(y(r.rBefore))}" r="4"/>`).join("");
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">${grid}${ticks}
<text class="ax" x="${f(m.l + (W - m.l - m.r) / 2)}" y="${H - 6}" text-anchor="middle">days since you first answered the card</text>
<text class="ax" x="${f(W - m.r)}" y="${f(y(c.target) + 14)}" text-anchor="end">target ${pct(c.target)}</text>
<path class="ln s2" d="${po}"/><path class="ln s1" d="${pw}"/>${dots}
<text class="dl" x="${f(W - m.r)}" y="${f(m.t - 7)}" text-anchor="end">With reviews</text>
<text class="dl" x="${f(W - m.r)}" y="${f(y(c.without[c.days]) - 8)}" text-anchor="end">Without reviews</text>
<line class="cross" x1="0" x2="0" y1="${m.t}" y2="${H - m.b}" visibility="hidden"/>
<rect class="hit" x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="transparent"/></svg><div class="curve-tip" hidden></div>`;
}
function drawCurve() {
  const host = document.getElementById("curve");
  if (!host) return;
  const c = guideCurve();
  let w = 0;
  const paint = () => {
    w = host.clientWidth || 340;
    host.innerHTML = curveSVG(c, w);
    wireCurve(host, c, w);
  };
  paint();
  curveRO?.disconnect();
  if (typeof ResizeObserver === "function") {
    curveRO = new ResizeObserver(() => { if (host.isConnected && Math.abs(host.clientWidth - w) > 4) paint(); });
    curveRO.observe(host);
  }
}
function wireCurve(host, c, W) {
  const g = curveGeom(W, c.days);
  const svg = host.querySelector("svg"), cross = svg.querySelector(".cross"), tip = host.querySelector(".curve-tip");
  const rev = new Map(c.reviews.slice(1).map((r) => [r.day, r]));
  let cur = 30;
  const row = (cls, val, text) => {
    const p = document.createElement("p"), k = document.createElement("i"), b = document.createElement("b"), s = document.createElement("span");
    k.className = `key ${cls}`; b.textContent = val; s.textContent = text;
    p.append(k, b, s);
    return p;
  };
  const show = (d) => {
    cur = Math.max(0, Math.min(c.days, d));
    const X = g.x(cur);
    cross.setAttribute("x1", X); cross.setAttribute("x2", X); cross.setAttribute("visibility", "visible");
    const head = document.createElement("p");
    head.className = "tip-h";
    head.textContent = cur === 0 ? "Day 0, first answer" : `Day ${cur}`;
    const r = rev.get(cur);
    tip.replaceChildren(head, row("s1", r ? `${pct(r.rBefore)} → 100%` : pct(c.withR[cur]), r ? "With reviews (reviewed)" : "With reviews"), row("s2", pct(c.without[cur]), "Without reviews"));
    tip.hidden = false;
    const tw = tip.offsetWidth;
    tip.style.left = `${X + 12 + tw <= W ? X + 12 : Math.max(0, X - 12 - tw)}px`;
    tip.style.top = `${g.m.t}px`;
  };
  const hide = () => { cross.setAttribute("visibility", "hidden"); tip.hidden = true; };
  const at = (e) => show(g.day(e.clientX - svg.getBoundingClientRect().left));
  svg.addEventListener("pointermove", at);
  svg.addEventListener("pointerdown", at);
  svg.addEventListener("pointerleave", () => { if (document.activeElement !== host) hide(); });
  host.onfocus = () => show(cur);
  host.onblur = hide;
  host.onkeydown = (e) => {
    const step = e.shiftKey ? 30 : 1;
    const to = { ArrowRight: cur + step, ArrowLeft: cur - step, Home: 0, End: c.days }[e.key];
    if (to != null) { e.preventDefault(); show(to); }
  };
}

const SESSION_PROMPT = `Review my learning in the Card Catalog artifact. Read its db (reviews, cards, flags, feedback, explanations, deepdives, study, custom, config/scheduler) with ArtifactData. Fix or retire flagged deck cards in decks/ and resolve the flags. Use the level feedback to rewrite, retire or add deck cards at the level I marked "just right". If there are enough reviews, run tools/optimize.py and write the fitted parameters and per-kind retention to config/scheduler. Write what you found to insights/latest. Rebuild, run the tests, republish, and tell me what changed and why.`;

// ---------- events ----------
function route() {
  let h = (location.hash || "").replace("#", "");
  if (h === "patterns") h = "study";
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
    case "deep": return goDeeper(id);
    case "level": return setLevel(id, el.dataset.level);
    case "rewrite-level": return rewriteLevel(id);
    case "rewrite-accept": return acceptRewrite(id);
    case "rewrite-discard": S.rewrites.delete(id); return render();
    case "deck-draft": return deckDraft(el.dataset.deck);
    case "focus-deck": return toggleFocus(el.dataset.deck);
    case "study-save": setStudy(id, true); saveDraft(); return render();
    case "study-open": ev.preventDefault(); S.studyOpen = id; saveDraft(); if (location.hash !== "#study") location.hash = "study"; else render(); return;
    case "study-close": S.studyOpen = null; saveDraft(); return render();
    case "study-remove": setStudy(id, false); if (S.studyOpen === id) S.studyOpen = null; return render();
    case "override": S.session.override = true; saveDraft(); return render();
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
      if (out) { S.add.drafts = (Array.isArray(out.cards) ? out.cards : []).map(cleanCard).filter(Boolean).slice(0, 5); S.add.drafted = true; S.add.origin = "note"; }
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
  if (t.id === "answer-box") {
    S.session.typed = t.value;
    saveDraft(true);
    const b = document.querySelector('[data-act="grade"]');
    if (b && !S.busy.has(`grade:${S.session.current}`)) b.disabled = !t.value.trim();
  }
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
  if (form.dataset.form === "level-note") {
    saveLevelNote(form.dataset.id, String(fd.get("note") || ""));
    return;
  }
  if (form.dataset.form === "followup") {
    followUp(form.dataset.id, String(fd.get("q") || ""));
    return;
  }
  if (form.dataset.form === "flag") {
    saveFlag(form.dataset.id || null, String(fd.get("reason") || "Other"), String(fd.get("note") || ""));
    S.cat.flagFor = null;
    return render();
  }
  if (form.dataset.form === "draft") {
    const c = cleanCard({ kind: fd.get("kind"), prompt: fd.get("prompt"), answer: fd.get("answer"), points: String(fd.get("points") || "").split("\n"), source: String(fd.get("source") || "") });
    const generated = fd.get("generated") === "1";
    if (!c) return toast("A card needs a prompt and an answer.");
    if (c.kind !== "fact" && c.points.length < 2) return toast("Concept and judgment cards need at least two key points to be graded.");
    const i = form.dataset.i;
    addCustom(c, i === "m" ? "Written by you" : generated ? "Drafted by Claude for your level" : "Drafted by Claude from your note", S.add.deck, generated ? { verify: true } : {});
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
    if (ev.target.id === "answer-box" && ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); claudeReady() && S.session.typed.trim() ? grade() : reveal(); }
    return;
  }
  if (ev.target.closest("button,a,form")) return;
  const g = S.session.grade;
  if (S.session.phase === "front" && (ev.key === " " || ev.key === "Enter")) { ev.preventDefault(); reveal(); }
  else if (S.session.phase === "back" && (ev.key === "Enter" || ev.key === " ") && g?.rating && !S.session.override) { ev.preventDefault(); rate(g.rating); }
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
    explanations: Object.fromEntries(S.expl), deepdives: Object.fromEntries(S.deep), feedback: Object.fromEntries(S.fb), flags: S.flags, insights: S.insights,
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
  const draft = readDraft();
  startSession();
  restoreDraft(draft);
  route();
}
boot();
