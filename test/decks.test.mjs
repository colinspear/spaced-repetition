// Deck lint: ids are permanent (review history keys off them), kinds are known,
// graded kinds carry a rubric, and prompts stay one question long.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const dir = new URL("../decks/", import.meta.url);
const decks = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => [f, JSON.parse(readFileSync(new URL(f, dir)))]);
const KINDS = new Set(["fact", "concept", "judgment"]);
const ID = /^[a-z]{3}-\d{2,3}$/;

test("deck files are well formed", () => {
  assert.ok(decks.length >= 8);
  const seen = new Set();
  for (const [file, d] of decks) {
    assert.equal(`${d.deck}.json`, file, "file name matches deck key");
    assert.match(d.code, /^[A-Z]{3}$/);
    assert.ok(d.title && d.blurb, `${file}: title and blurb`);
    for (const c of d.cards) {
      const where = `${file}:${c.id}`;
      assert.match(c.id, ID, where);
      assert.ok(c.id.startsWith(d.deck + "-"), `${where} id prefix matches deck`);
      assert.ok(!seen.has(c.id), `${where} duplicate id`);
      seen.add(c.id);
      assert.ok(KINDS.has(c.kind), `${where} kind`);
      assert.ok(c.prompt?.trim() && c.answer?.trim(), `${where} prompt and answer`);
      assert.ok(c.source?.trim(), `${where} source`);
      if (c.kind !== "fact") assert.ok(Array.isArray(c.points) && c.points.length >= 2, `${where} graded kinds need >= 2 rubric points`);
      assert.ok(c.prompt.length <= 260, `${where} prompt too long (${c.prompt.length})`);
      if (c.kind === "fact") assert.ok(c.answer.length <= 360, `${where} fact answer too long; split the card`);
    }
  }
  assert.ok(seen.size >= 70, `${seen.size} cards`);
});
