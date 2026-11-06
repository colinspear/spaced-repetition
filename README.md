# Card Catalog

Spaced repetition for the principles a data leader uses: data governance, metadata and lineage, data modeling and databases, record linkage, privacy, evidence and measurement, change management, capability building, and leadership.

**Content rule:** the topics come from the learner's work, but the cards never do. Every card is a general principle or best practice that would hold in any organization. There are no employer, place, vendor or product specifics, and a test (`test/decks.test.mjs`) enforces that. Cards drafted from your own notes on the Add tab get the same treatment: Claude keeps the transferable principle and drops the names.

It is built on Patrick Collison's [suggestion](https://x.com/patrickc/status/2118352452923912419) (Nov 5, 2026):

> The models are very good at creating custom spaced repetition apps with algorithms adapted to you and the problem domain ("review my learning and improve the efficiency of your scheduler") plus tailored explanations for anything that you consistently get wrong.

**Use it:** [Card Catalog artifact](https://claude.ai/artifact/JhUmR9yBL5isKdy7N2sLfm) (private to you). Five to ten minutes a day, on your phone or at a desk.

## How the post maps onto this repo

| Patrick's phrase | What it is here |
| --- | --- |
| custom spaced repetition app | Single-page app published as a private Claude artifact. Reviews, card state and explanations live in the artifact's private database. |
| algorithm adapted to the problem domain | An FSRS-6 core with a domain layer on top (`src/engine.js`). Three card kinds have their own targets: facts 90%, concepts 85%, judgment scenarios 80%, because writing a scenario answer costs ~10x a fact recall. The maximum interval is one year, so every card resurfaces for a relevance check. Study days roll over at 4am. Reviews interleave across decks. |
| algorithm adapted to you | Three stages, each gated on having enough data (see below). |
| "review my learning and improve the efficiency of your scheduler" | `tools/optimize.py`: a held-out refit of all 21 FSRS parameters plus a cost-based optimal retention per card kind, written back to the artifact's `config/scheduler` doc. Run it from a Claude Code session with the prompt on the Tuning tab. |
| tailored explanations for anything you consistently get wrong | Typed answers are logged. After two misses, a card offers an explanation aimed at your actual wrong answers. It can propose a contrast card or a rewrite. "Analyze my misses" looks for confusions across cards. |

## Where I departed from the literal suggestion, and why

1. **No new algorithm invented.** FSRS is the strongest published scheduler on large benchmarks of real review data. A model-invented one would almost certainly be worse. "Custom" here means a domain layer plus fitting to your data. `src/fsrs.js` is a port of py-fsrs 6.3.2, checked step for step against the reference on 969 randomized reviews (`test/fsrs.parity.test.mjs`).
2. **Adaptation needs data, and the app says so.** With zero reviews nothing is "adapted to you". The stages are:
   - **Stage 1, in-app:** a one-parameter memory multiplier, fit by maximum likelihood from 30+ reviews and offered only when its 95% interval excludes 1. FSRS-6's forgetting curve is flat, so even 3,000 simulated reviews give an interval of about ±15%. Expect "not enough evidence yet" for the first couple of months.
   - **Stage 2:** a full 21-parameter refit, once there are 512 reviews on days after the first. py-fsrs refuses below that.
   - **Stage 3:** optimal retention per kind from timed reviews, also at 512+ per kind.

   In the end-to-end test (`tools/test_optimize.py`), a refit only beats the defaults on held-out data when the simulated learner really differs from them. The script never adopts a refit that loses.
3. **Spaced repetition retains facts; your job is mostly judgment.** About a third of the cards are concept or judgment cards that you answer in writing. Claude grades them against explicit key points and suggests a rating, and you decide. Retrieval of the reasoning is the point, not recognition.
4. **Cards written by a model are a known trap.** Authoring your own prompts is part of how they stick. The Add tab turns your own notes (a meeting takeaway, a fix you found) into draft cards you edit before accepting. Every card can be flagged, suspended or rewritten.

## Days off and vacations

This is the open question in the replies to Patrick's post. FSRS already handles overdue cards correctly, because predicted recall uses the real elapsed time and a long-overdue success earns a large stability gain. The real cost of time off is the pile of due cards, so:

- Reviews are capped per day (default 40).
- When the cap binds, cards are ordered by how much recall they lose if they wait one more day (`urgency` in `src/engine.js`). Cards mid-decay go first. Long-forgotten cards and very stable ones wait, since an extra day costs them little.
- New cards pause while there is a backlog.

The app tells you how many cards are waiting and that they wait without penalty.

## Decks

| Deck | Cards | What it covers |
| --- | --- | --- |
| GOV Data governance | 12 | Roles, operating models, CDEs, quality dimensions, data mesh, policy vs standard, competing definitions |
| MET Metadata & lineage | 10 | Glossary vs catalog, static vs runtime lineage, why lineage breaks, holding tools to their claims, catalog rollout |
| MOD Data modeling & databases | 14 | Normal forms and anomalies, keys, NULL logic, indexes, idempotent loads, grain, fact types, SCDs, conformed dimensions |
| LNK Record linkage | 8 | Fellegi-Sunter, blocking, term frequency, thresholds, match rate vs accuracy |
| PRV Privacy & disclosure | 7 | Re-identification, k-anonymity, suppression, differential privacy, the mosaic effect, minimization |
| EVD Evidence & measurement | 10 | Regression to the mean, Campbell's law, small numbers, Simpson's paradox, administrative data, series breaks, proxies |
| CHG Change management | 9 | Lewin, Bridges, Kotter, ADKAR, Rogers, Switch, defaults, resistance |
| LRN Learning & capability building | 8 | Kirkpatrick, desirable difficulties, Dreyfus, worked examples, curse of knowledge, communities of practice |
| LDR Leadership | 10 | Psychological safety, adaptive challenges, influence without authority, feedback, decision rights, teams |

Cards marked **verify** are ones I'm not fully certain of. Check the cited source before you rely on them, and flag them if they're wrong.

## Privacy

This repo is public and holds only general, sourced content. Your reviews, typed answers, notes, added cards, flags and explanations live only in the private artifact's database, readable by you alone. Exports are gitignored. Nothing from the database is copied into this repo unless you ask.

## Development

```bash
npm test          # FSRS parity vs py-fsrs, engine, deck lint
npm run build     # dist/card-catalog.html
npm run smoke     # headless browser run against a mock artifact runtime
```

```bash
python -m venv .venv && .venv/bin/pip install "fsrs[optimizer]==6.3.2"
.venv/bin/python tools/test_optimize.py     # optimizer end to end on a simulated learner
.venv/bin/python tools/gen_fixtures.py > test/fixtures/pyfsrs.json
```

| Path | Role |
| --- | --- |
| `src/fsrs.js` | FSRS-6 scheduler (port of py-fsrs 6.3.2) |
| `src/engine.js` | Study days, per-kind targets, backlog triage, interleaving, calibration |
| `src/app.js`, `src/app.css`, `src/page.html` | UI; Claude prompts for grading, explanations, patterns, drafting |
| `decks/*.json` | Card content. **Card ids are permanent:** review history keys off them. Retire cards with `"retired": true`; never renumber. |
| `tools/optimize.py` | Held-out refit and optimal retention, producing a config patch |
| `tools/smoke.mjs` | Browser smoke test |

Artifact database layout: `cards/{id}` (memory state), `reviews/{YYYY-MM-DD}` (that day's review log), `explanations/{id}`, `custom/{id}` (added or rewritten cards), `flags/{id}`, `config/scheduler`, `insights/latest`.

To update the published page from another Claude session, rebuild and publish `dist/card-catalog.html` to the artifact URL above.
