// Domain layer on top of FSRS: study days, per-kind targets, backlog triage,
// interleaving, calibration. Pure functions; the UI owns I/O.
import { makeScheduler, newCard, State, Rating, DAY, MINUTE, DEFAULT_PARAMETERS } from "./fsrs.js";

// Why the kinds differ: reviewing a judgment card costs ~2 min of writing plus grading,
// a fact card ~10 s. FSRS simulations show optimal retention falls as review cost rises,
// so expensive cards get a lower target (longer intervals). Same-session learning steps
// make sense for facts, not for scenarios you just wrote three paragraphs about.
// These are priors. tools/optimize.py replaces them with fitted values once there is data.
// Learning steps: one 10-minute step, so a card you knew moves straight to days and only a
// miss (or a shaky answer) comes back once later in the session for a corrective retrieval.
export const DEFAULT_CONFIG = Object.freeze({
  parameters: [...DEFAULT_PARAMETERS],
  kinds: {
    fact: { retention: 0.9, learningSteps: [10], relearningSteps: [10] },
    concept: { retention: 0.85, learningSteps: [10], relearningSteps: [10] },
    judgment: { retention: 0.8, learningSteps: [], relearningSteps: [] },
  },
  maximumInterval: 365, // work knowledge goes stale; see every card at least yearly and prune
  newPerDay: 5,
  reviewsPerDay: 40,
  rolloverHour: 4,
  intervalScale: 1, // stage-1 personal calibration (see fitScale)
  deckWeights: {},
  source: "defaults",
  updatedAt: null,
  history: [],
});

export function mergeConfig(stored) {
  const base = structuredClone(DEFAULT_CONFIG);
  if (!stored || typeof stored !== "object") return base;
  const out = { ...base, ...stored };
  out.kinds = { ...base.kinds };
  for (const k of Object.keys(base.kinds)) out.kinds[k] = { ...base.kinds[k], ...(stored.kinds?.[k] || {}) };
  if (!Array.isArray(out.parameters) || out.parameters.length !== 21) out.parameters = base.parameters;
  return out;
}

// ---------- time ----------
/** Study-day number: local calendar date of (ts - rollover). Reviews at 11pm and 1am share a day. */
export function dayIndex(ts, rolloverHour = 4) {
  const d = new Date(ts - rolloverHour * 3600000);
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY);
}
export function dayKey(ts, rolloverHour = 4) {
  const d = new Date(ts - rolloverHour * 3600000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------- memory records ----------
export function blankMemory(now) {
  return { ...newCard(now), reps: 0, lapses: 0, agains: 0, suspended: false };
}
export const isNew = (m) => !m || m.lastReview == null;
export const isLearning = (m) => !isNew(m) && (m.state === State.Learning || m.state === State.Relearning);
export function elapsedDays(m, now, roll) {
  return isNew(m) ? null : dayIndex(now, roll) - dayIndex(m.lastReview, roll);
}
export function isDue(m, now, roll) {
  if (isNew(m) || m.suspended) return false;
  if (isLearning(m)) return m.due <= now;
  return dayIndex(m.due, roll) <= dayIndex(now, roll);
}

export function schedulerFor(config, { fuzz = true, rng = Math.random } = {}) {
  return makeScheduler({
    parameters: config.parameters,
    maximumInterval: config.maximumInterval,
    enableFuzzing: fuzz,
    rng,
  });
}
export function kindOpts(config, kind) {
  const k = config.kinds[kind] || config.kinds.fact;
  return {
    retention: k.retention,
    learningSteps: k.learningSteps.map((m) => m * MINUTE),
    relearningSteps: k.relearningSteps.map((m) => m * MINUTE),
    intervalScale: config.intervalScale || 1,
  };
}

/** Predicted recall probability now, under the current personal calibration. */
export function currentR(m, now, config, sched) {
  if (isNew(m)) return null;
  return sched.retrievability(m.stability * (config.intervalScale || 1), elapsedDays(m, now, config.rolloverHour));
}

/**
 * Backlog priority: how much recall probability this card loses if it waits one more day.
 * Cards decaying fastest go first. Long-forgotten cards (flat tail) and very stable cards
 * (flat head) can wait without much extra loss. FSRS already handles overdue cards correctly,
 * since R uses the real elapsed time. The cost of time off is the pile of due cards, and this
 * ordering decides which of them get the limited review slots.
 */
export function urgency(m, now, config, sched, deck) {
  const s = m.stability * (config.intervalScale || 1);
  const e = elapsedDays(m, now, config.rolloverHour);
  const loss = sched.retrievability(s, e) - sched.retrievability(s, e + 1);
  return loss * (config.deckWeights?.[deck] ?? 1);
}

/** Round-robin across decks so consecutive cards differ in topic where possible (interleaving). */
export function interleave(items, deckOf) {
  const groups = new Map();
  for (const it of items) {
    const d = deckOf(it);
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push(it);
  }
  const out = [];
  let last = null;
  while (out.length < items.length) {
    let best = null;
    for (const [d, g] of groups) {
      if (!g.length || d === last) continue;
      if (!best || g.length > groups.get(best).length) best = d;
    }
    if (best == null) best = last; // only one deck left
    out.push(groups.get(best).shift());
    last = best;
  }
  return out;
}

/** One from each deck in turn, decks in first-seen order: how new material is introduced. */
export function roundRobin(items, deckOf) {
  const groups = new Map();
  for (const it of items) {
    const d = deckOf(it);
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push(it);
  }
  const out = [];
  const lists = [...groups.values()];
  for (let i = 0; out.length < items.length; i++) for (const g of lists) if (i < g.length) out.push(g[i]);
  return out;
}

/**
 * Build today's main queue. Learning cards are not in it. nextCard() pulls them in as they come due.
 * @returns {{queue: string[], counts: {reviewsDue:number, reviewsToday:number, backlog:number, newToday:number, newAvailable:number, learning:number}}}
 */
export function buildQueue({ cards, mem, now, config, today = { reviews: 0, news: 0 }, sched }) {
  const roll = config.rolloverHour;
  const live = cards.filter((c) => !c.retired && !mem.get(c.id)?.suspended);
  const deckOf = (id) => live.find((c) => c.id === id)?.deck;
  const reviewDue = live.filter((c) => {
    const m = mem.get(c.id);
    return !isNew(m) && !isLearning(m) && isDue(m, now, roll);
  });
  reviewDue.sort((a, b) => urgency(mem.get(b.id), now, config, sched, b.deck) - urgency(mem.get(a.id), now, config, sched, a.deck));
  const reviewCap = Math.max(0, config.reviewsPerDay - today.reviews);
  const chosen = reviewDue.slice(0, reviewCap);
  const backlog = reviewDue.length - chosen.length;
  const newAvailable = live.filter((c) => isNew(mem.get(c.id)));
  // No new cards while the backlog is over the cap: adding material while drowning is how people quit.
  const newCap = backlog > 0 ? 0 : Math.max(0, config.newPerDay - today.news);
  const news = roundRobin(newAvailable, (c) => c.deck).slice(0, newCap);
  const reviews = interleave(chosen, (c) => c.deck).map((c) => c.id);
  const queue = spread(reviews, news.map((c) => c.id));
  const learning = live.filter((c) => isLearning(mem.get(c.id))).length;
  return {
    queue,
    counts: { reviewsDue: reviewDue.length, reviewsToday: chosen.length, backlog, newToday: news.length, newAvailable: newAvailable.length, learning },
    deckOf,
  };
}

function spread(main, extra) {
  if (!extra.length) return main.slice();
  if (!main.length) return extra.slice();
  const out = [];
  const every = Math.max(1, Math.floor(main.length / extra.length));
  let j = 0;
  main.forEach((id, i) => {
    out.push(id);
    if ((i + 1) % every === 0 && j < extra.length) out.push(extra[j++]);
  });
  while (j < extra.length) out.push(extra[j++]);
  return out;
}

/**
 * Pick the next card: a learning card that is due now, then the main queue, then learning
 * cards due within `learnAheadMs` (so a session can finish instead of waiting 10 minutes).
 */
export function nextCard({ queue, cards, mem, now, lastId = null, learnAheadMs = 20 * MINUTE }) {
  const learning = cards
    .filter((c) => !c.retired && isLearning(mem.get(c.id)) && !mem.get(c.id).suspended)
    .map((c) => ({ id: c.id, due: mem.get(c.id).due }))
    .sort((a, b) => a.due - b.due);
  const ready = learning.filter((l) => l.due <= now && !(l.id === lastId && queue.length));
  if (ready.length) return { id: ready[0].id, from: "learning" };
  if (queue.length) return { id: queue[0], from: "queue" };
  const ahead = learning.filter((l) => l.due <= now + learnAheadMs);
  if (ahead.length) return { id: ahead[0].id, from: "ahead" };
  return null;
}

/** Apply a rating. Returns the new memory record and a review-log row. */
export function applyRating({ mem, card, rating, now, config, sched }) {
  const base = isNew(mem) ? blankMemory(now) : { ...blankMemory(now), ...mem };
  const e = elapsedDays(base, now, config.rolloverHour);
  const opts = kindOpts(config, card.kind);
  const p = isNew(base) ? null : sched.retrievability(base.stability * opts.intervalScale, e);
  const fsrsCard = { state: base.state, step: base.step, stability: base.stability, difficulty: base.difficulty, due: base.due, lastReview: base.lastReview };
  const { card: c, intervalDays, intervalMs } = sched.review(fsrsCard, rating, now, e, opts);
  const next = {
    ...base,
    ...c,
    reps: base.reps + 1,
    lapses: base.lapses + (rating === Rating.Again && base.state === State.Review ? 1 : 0),
    agains: base.agains + (rating === Rating.Again ? 1 : 0),
  };
  const log = { c: card.id, k: card.kind, r: rating, t: now, st: isNew(base) ? 0 : base.state, s: base.stability, e, p, i: intervalDays };
  return { mem: next, log, intervalMs };
}

/** Button labels: what each rating would schedule (no fuzz). */
export function previewIntervals({ mem, card, now, config }) {
  const sched = schedulerFor(config, { fuzz: false });
  const out = {};
  for (const r of [1, 2, 3, 4]) out[r] = applyRating({ mem, card, rating: r, now, config, sched }).intervalMs;
  return out;
}
/** The memory state a rating would produce (no fuzz), for showing mastery before committing. */
export function previewOutcome({ mem, card, now, config, rating }) {
  return applyRating({ mem, card, rating, now, config, sched: schedulerFor(config, { fuzz: false }) });
}

/**
 * Mastery bands from FSRS stability: the number of days until predicted recall falls to 90%.
 * Learning: days. Familiar: up to 3 weeks. Solid: up to 3 months. Mastered: 3 months or more.
 */
export const MASTERY = Object.freeze(["New", "Learning", "Familiar", "Solid", "Mastered"]);
export function mastery(m) {
  if (isNew(m)) return 0;
  if (isLearning(m) || !(m.stability >= 3)) return 1;
  if (m.stability < 21) return 2;
  if (m.stability < 90) return 3;
  return 4;
}
export function fmtInterval(ms) {
  if (ms < 60 * MINUTE) return `${Math.max(1, Math.round(ms / MINUTE))}m`;
  if (ms < DAY) return `${Math.round(ms / (60 * MINUTE))}h`;
  const d = Math.round(ms / DAY);
  if (d < 31) return `${d}d`;
  if (d < 365) return `${(d / 30.4).toFixed(d < 304 ? 1 : 0).replace(/\.0$/, "")}mo`;
  return `${(d / 365).toFixed(1).replace(/\.0$/, "")}y`;
}

// ---------- personal adaptation ----------
const reviewRows = (logs) => logs.filter((l) => l.st === State.Review && l.s > 0 && l.e >= 1);

/** Predicted vs actual recall for reviews of cards in the Review state. */
export function calibration(logs) {
  const edges = [0, 0.7, 0.8, 0.85, 0.9, 0.95, 1.0001];
  const rows = edges.slice(0, -1).map((lo, i) => ({ lo, hi: Math.min(edges[i + 1], 1), n: 0, pSum: 0, ok: 0 }));
  for (const l of reviewRows(logs)) {
    if (l.p == null) continue;
    const b = rows.find((r) => l.p >= r.lo && l.p < (r.hi === 1 ? 1.0001 : r.hi));
    if (!b) continue;
    b.n++;
    b.pSum += l.p;
    b.ok += l.r > 1 ? 1 : 0;
  }
  return rows.map((r) => ({ lo: r.lo, hi: r.hi, n: r.n, predicted: r.n ? r.pSum / r.n : null, actual: r.n ? r.ok / r.n : null }));
}

/**
 * Stage-1 personalization: one multiplier k on stability, fit by maximum likelihood.
 * k < 1 means you forget faster than the default model assumes (intervals shrink).
 * One parameter is estimable from a few dozen reviews. The full 21-parameter refit
 * (tools/optimize.py) needs hundreds.
 */
export function fitScale(logs, sched, minN = 30) {
  const rows = reviewRows(logs);
  if (rows.length < minN) return { n: rows.length, k: null };
  const ll = (k) => {
    let s = 0;
    for (const l of rows) {
      let R = sched.retrievability(k * l.s, l.e);
      R = Math.min(Math.max(R, 1e-6), 1 - 1e-6);
      s += l.r > 1 ? Math.log(R) : Math.log(1 - R);
    }
    return s;
  };
  const grid = Array.from({ length: 161 }, (_, i) => Math.exp(Math.log(0.25) + (i / 160) * (Math.log(4) - Math.log(0.25))));
  let best = 1, bestLL = -Infinity;
  for (const k of grid) {
    const v = ll(k);
    if (v > bestLL) { bestLL = v; best = k; }
  }
  // 95% likelihood-ratio interval
  const inside = grid.filter((k) => 2 * (bestLL - ll(k)) < 3.84);
  const lo = Math.min(...inside), hi = Math.max(...inside);
  return {
    n: rows.length,
    k: best,
    lo,
    hi,
    logLossDefault: -ll(1) / rows.length,
    logLossFitted: -bestLL / rows.length,
    significant: !(lo <= 1 && 1 <= hi),
  };
}

export function forecast({ cards, mem, now, config, days = 14 }) {
  const roll = config.rolloverHour;
  const today = dayIndex(now, roll);
  const out = Array(days).fill(0);
  for (const c of cards) {
    const m = mem.get(c.id);
    if (c.retired || isNew(m) || m.suspended) continue;
    const d = Math.max(0, dayIndex(m.due, roll) - today);
    if (d < days) out[d]++;
  }
  return out;
}

export const isPersistentMiss = (m) => !!m && m.agains >= 2;
export const isLeech = (m) => !!m && m.lapses >= 4;
