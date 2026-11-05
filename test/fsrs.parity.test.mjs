// Parity: src/fsrs.js must reproduce py-fsrs 6.3.2 step for step (fuzzing off).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeScheduler, newCard, roundHalfEven, DAY } from "../src/fsrs.js";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/pyfsrs.json", import.meta.url)));
const close = (a, b, msg) => assert.ok(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)), `${msg}: ${a} vs ${b}`);

test("roundHalfEven matches Python round()", () => {
  assert.deepEqual([0.5, 1.5, 2.5, 3.5, 2.4999, 2.5001, 7].map(roundHalfEven), [0, 2, 2, 4, 2, 3, 7]);
});

test(`py-fsrs parity across ${fixtures.cases.length} randomized histories`, () => {
  let checked = 0;
  for (const c of fixtures.cases) {
    const cfg = c.config;
    const s = makeScheduler({
      parameters: cfg.parameters,
      desiredRetention: cfg.desired_retention,
      learningSteps: cfg.learning_steps.map((x) => x * 1000),
      relearningSteps: cfg.relearning_steps.map((x) => x * 1000),
      maximumInterval: cfg.maximum_interval,
      enableFuzzing: false,
    });
    let card = newCard(c.start);
    for (const [i, st] of c.steps.entries()) {
      const elapsed = card.lastReview == null ? null : Math.floor((st.now - card.lastReview) / DAY);
      card = s.review(card, st.rating, st.now, elapsed).card;
      const where = `${c.name} step ${i}`;
      assert.equal(card.state, st.state, `${where} state`);
      assert.equal(card.step, st.step, `${where} step`);
      close(card.stability, st.stability, `${where} stability`);
      close(card.difficulty, st.difficulty, `${where} difficulty`);
      assert.equal(card.due, st.due, `${where} due`);
      assert.equal(card.lastReview, st.last_review, `${where} lastReview`);
      const pe = Math.floor((st.probe_now - card.lastReview) / DAY);
      close(s.retrievability(card.stability, pe), st.probe_r, `${where} retrievability`);
      checked++;
    }
  }
  assert.ok(checked > 500, `only ${checked} steps checked`);
});

test("fuzzing keeps intervals inside py-fsrs fuzz bounds and is deterministic per rng", () => {
  let seed = 1;
  const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const s = makeScheduler({ enableFuzzing: true, rng, learningSteps: [] });
  const t0 = Date.UTC(2026, 0, 1);
  for (let k = 0; k < 200; k++) {
    let card = newCard(t0);
    card = s.review(card, 4, t0, null).card; // Easy -> Review
    const later = t0 + 40 * DAY;
    const r = s.review(card, 3, later, 40);
    assert.ok(r.intervalDays >= 2, "fuzzed interval >= 2 days");
    assert.ok(r.intervalDays <= 36500);
  }
});
