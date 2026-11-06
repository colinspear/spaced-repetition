import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CONFIG, mergeConfig, dayIndex, buildQueue, nextCard, applyRating, previewIntervals,
  interleave, fitScale, calibration, urgency, schedulerFor, forecast, isLearning,
} from "../src/engine.js";
import { DAY, MINUTE, State } from "../src/fsrs.js";

const cfg = () => mergeConfig({});
const T0 = new Date(2026, 2, 10, 9, 0).getTime(); // local time, away from DST changes

test("study day rolls over at 4am local, not midnight", () => {
  const late = new Date(2026, 2, 9, 23, 30).getTime();
  const early = new Date(2026, 2, 10, 3, 59).getTime();
  const after = new Date(2026, 2, 10, 4, 1).getTime();
  assert.equal(dayIndex(late, 4), dayIndex(early, 4));
  assert.equal(dayIndex(after, 4), dayIndex(early, 4) + 1);
});

test("mergeConfig keeps defaults for missing kinds and rejects bad parameter vectors", () => {
  const m = mergeConfig({ kinds: { judgment: { retention: 0.75 } }, parameters: [1, 2, 3] });
  assert.equal(m.kinds.judgment.retention, 0.75);
  assert.deepEqual(m.kinds.judgment.learningSteps, []);
  assert.equal(m.kinds.fact.retention, 0.9);
  assert.equal(m.parameters.length, 21);
});

function reviewCard(id, deck, stability, daysAgo, now = T0) {
  const last = now - daysAgo * DAY;
  return [
    { id, deck, kind: "fact" },
    { state: State.Review, step: null, stability, difficulty: 5, due: last + Math.max(1, Math.round(stability)) * DAY, lastReview: last, reps: 3, lapses: 0, agains: 0, suspended: false },
  ];
}

test("backlog after time off: cap reviews, pause new cards, keep fastest-decaying first", () => {
  const config = cfg();
  const sched = schedulerFor(config, { fuzz: false });
  const pairs = [];
  for (let i = 0; i < 100; i++) pairs.push(reviewCard(`r${i}`, ["gov", "lin", "civ"][i % 3], 2 + (i % 20), 25));
  for (let i = 0; i < 10; i++) pairs.push([{ id: `n${i}`, deck: "mod", kind: "fact" }, undefined]);
  const cards = pairs.map((p) => p[0]);
  const mem = new Map(pairs.filter((p) => p[1]).map((p) => [p[0].id, p[1]]));
  const { queue, counts } = buildQueue({ cards, mem, now: T0, config, sched });
  assert.equal(counts.reviewsDue, 100);
  assert.equal(counts.reviewsToday, 40);
  assert.equal(counts.backlog, 60);
  assert.equal(counts.newToday, 0, "no new cards while drowning");
  assert.equal(queue.length, 40);
  const chosen = new Set(queue);
  const u = (id) => urgency(mem.get(id), T0, config, sched, cards.find((c) => c.id === id).deck);
  const minChosen = Math.min(...[...chosen].map(u));
  const maxLeft = Math.max(...[...mem.keys()].filter((id) => !chosen.has(id)).map(u));
  assert.ok(minChosen >= maxLeft, "every chosen card loses at least as much by waiting as any deferred card");
});

test("urgency: mid-decay cards beat both long-forgotten and very stable ones", () => {
  const config = cfg();
  const sched = schedulerFor(config, { fuzz: false });
  const [, mid] = reviewCard("a", "x", 3, 4);
  const [, forgotten] = reviewCard("b", "x", 0.5, 200);
  const [, stable] = reviewCard("c", "x", 300, 10);
  const um = urgency(mid, T0, config, sched, "x");
  assert.ok(um > urgency(forgotten, T0, config, sched, "x"));
  assert.ok(um > urgency(stable, T0, config, sched, "x"));
});

test("new cards are introduced one deck at a time, in deck order", async () => {
  const { roundRobin } = await import("../src/engine.js");
  const items = ["a1", "a2", "a3", "a4", "b1", "c1", "c2"].map((id) => ({ id, deck: id[0] }));
  assert.deepEqual(roundRobin(items, (x) => x.deck).map((x) => x.id), ["a1", "b1", "c1", "a2", "c2", "a3", "a4"]);
});

test("interleave avoids back-to-back cards from the same deck when possible", () => {
  const items = ["a1", "a2", "a3", "b1", "b2", "c1"].map((id) => ({ id, deck: id[0] }));
  const out = interleave(items, (x) => x.deck);
  assert.equal(out.length, 6);
  for (let i = 1; i < out.length; i++) assert.notEqual(out[i].deck, out[i - 1].deck);
});

test("a known card moves straight to days; a missed one comes back once in-session; judgment never repeats same day", () => {
  const config = cfg();
  const sched = schedulerFor(config, { fuzz: false });
  const fact = { id: "f", deck: "gov", kind: "fact" };
  const judg = { id: "j", deck: "gov", kind: "judgment" };
  const knew = applyRating({ mem: undefined, card: fact, rating: 3, now: T0, config, sched });
  assert.equal(knew.mem.state, State.Review);
  assert.ok(knew.intervalMs >= DAY);
  const f = applyRating({ mem: undefined, card: fact, rating: 1, now: T0, config, sched });
  assert.ok(isLearning(f.mem));
  assert.equal(f.intervalMs, 10 * MINUTE);
  const back = applyRating({ mem: f.mem, card: fact, rating: 3, now: T0 + 10 * MINUTE, config, sched });
  assert.equal(back.mem.state, State.Review, "one good retry graduates it");
  const j = applyRating({ mem: undefined, card: judg, rating: 3, now: T0, config, sched });
  assert.equal(j.mem.state, State.Review);
  assert.ok(j.intervalMs >= DAY);
  const mem = new Map([["f", f.mem]]);
  assert.equal(nextCard({ queue: [], cards: [fact], mem, now: T0 + 5 * MINUTE })?.id, "f", "learn-ahead finishes the session");
  assert.equal(nextCard({ queue: ["x"], cards: [fact], mem, now: T0 + 11 * MINUTE })?.id, "f", "due learning card jumps the queue");
  assert.equal(nextCard({ queue: ["x"], cards: [fact], mem, now: T0 + 2 * MINUTE })?.id, "x");
});

test("mastery bands follow stability", async () => {
  const { mastery, MASTERY } = await import("../src/engine.js");
  const at = (s) => MASTERY[mastery({ state: State.Review, step: null, stability: s, lastReview: T0 })];
  assert.equal(MASTERY[mastery(undefined)], "New");
  assert.deepEqual([at(1), at(5), at(30), at(200)], ["Learning", "Familiar", "Solid", "Mastered"]);
});

test("lower target retention for judgment cards yields longer intervals for the same memory", () => {
  const config = cfg();
  const sched = schedulerFor(config, { fuzz: false });
  const [, m] = reviewCard("a", "x", 10, 10);
  const pf = previewIntervals({ mem: m, card: { id: "a", kind: "fact" }, now: T0, config });
  const pj = previewIntervals({ mem: m, card: { id: "a", kind: "judgment" }, now: T0, config });
  assert.ok(pj[3] > pf[3]);
  assert.ok(pf[1] <= pf[2] && pf[2] <= pf[3] && pf[3] <= pf[4], "Again <= Hard <= Good <= Easy");
});

test("fitScale recovers a known forgetting-rate multiplier from simulated reviews", () => {
  const sched = schedulerFor(cfg(), { fuzz: false });
  // mulberry32: MINSTD's correlated consecutive outputs biased an earlier version of this test.
  let a = 5;
  const rnd = () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const trueK = 0.6;
  const logs = [];
  for (let i = 0; i < 3000; i++) {
    const s = 1 + rnd() * 60;
    const e = 1 + Math.floor(rnd() * 2 * s);
    const R = sched.retrievability(s * trueK, e);
    logs.push({ st: State.Review, s, e, p: sched.retrievability(s, e), r: rnd() < R ? 3 : 1 });
  }
  const fit = fitScale(logs, sched);
  assert.ok(fit.lo <= trueK && trueK <= fit.hi, `95% interval [${fit.lo}, ${fit.hi}] should cover ${trueK}`);
  assert.ok(Math.abs(fit.k - trueK) < 0.1, `k=${fit.k}`);
  assert.ok(fit.significant, "k=1 should be rejected");
  assert.ok(fit.logLossFitted < fit.logLossDefault);
  const cal = calibration(logs);
  const hi = cal.find((b) => b.lo === 0.9);
  assert.ok(hi.actual < hi.predicted, "calibration shows the model is overconfident");
  assert.equal(fitScale(logs.slice(0, 10), sched).k, null, "refuses to fit on too little data");
});

test("forecast counts due cards per study day", () => {
  const config = cfg();
  const [c1, m1] = reviewCard("a", "x", 3, 0);
  const f = forecast({ cards: [c1], mem: new Map([["a", m1]]), now: T0, config });
  assert.equal(f.reduce((a, b) => a + b, 0), 1);
  assert.equal(f[3], 1);
});
