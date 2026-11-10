"""End-to-end check of tools/optimize.py on a simulated learner.

    .venv/bin/python tools/test_optimize.py

A simulated learner whose memory follows *different* FSRS parameters than the defaults studies
for ~5 months with the app's default scheduler. optimize.py must (a) recover parameters that beat
the defaults on held-out reviews, and (b) produce a well-formed config patch.
"""

import json
import os
import random
import sys
import tempfile
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(__file__))
from fsrs import Card, Rating, Scheduler  # noqa: E402
from fsrs.scheduler import DEFAULT_PARAMETERS  # noqa: E402

import optimize  # noqa: E402


def simulate(seed=3, cards=200, days=180, per_day_new=4):
    rng = random.Random(seed)
    random.seed(seed)  # the app scheduler's fuzz uses the global generator
    true_params = list(DEFAULT_PARAMETERS)
    true_params[0:4] = [0.1, 0.6, 1.2, 4.0]  # forgets new material much faster than default
    true_params[8] = 1.2  # slower stability growth after each success
    true_params[20] = 0.45  # steeper forgetting curve than the default decay (0.1542)
    truth = Scheduler(parameters=true_params, enable_fuzzing=False)
    app = Scheduler(enable_fuzzing=True)  # what the learner is actually scheduled with
    start = datetime(2026, 1, 1, 13, tzinfo=timezone.utc)
    sched_cards, mem_cards, reviews = {}, {}, []
    kinds = ["fact", "concept", "judgment"]
    introduced = 0
    for d in range(days):
        now = start + timedelta(days=d)
        for _ in range(per_day_new):
            if introduced < cards:
                introduced += 1
                sched_cards[introduced] = Card(card_id=introduced, due=now)
                mem_cards[introduced] = Card(card_id=introduced, due=now)
        due = [cid for cid, c in sched_cards.items() if c.due <= now + timedelta(hours=20)]
        rng.shuffle(due)
        t = now
        for cid in due[:60]:
            for _ in range(4):  # learning steps within the day
                c, m = sched_cards[cid], mem_cards[cid]
                if c.due > t + timedelta(hours=20):
                    break
                r = truth.get_card_retrievability(m, t) if m.last_review else 0.0
                recalled = m.last_review is not None and rng.random() < r
                if m.last_review is not None and (t - m.last_review).days < 1:
                    recalled = rng.random() < 0.85
                rating = Rating.Again if not recalled else rng.choices([Rating.Hard, Rating.Good, Rating.Easy], [1, 6, 1])[0]
                if m.last_review is None:
                    rating = rng.choices([Rating.Again, Rating.Hard, Rating.Good, Rating.Easy], [2, 1, 5, 1])[0]
                sched_cards[cid], _ = app.review_card(c, rating, review_datetime=t)
                mem_cards[cid], _ = truth.review_card(m, rating, review_datetime=t)
                reviews.append({"day": t.date().isoformat(), "c": f"x-{cid:03d}", "k": kinds[cid % 3], "r": int(rating), "t": int(t.timestamp() * 1000), "d": rng.randint(4000, 90000)})
                t += timedelta(minutes=rng.choice([1, 2, 3, 11]))
                if sched_cards[cid].state.name == "Review":
                    break
    return {"app": "card-catalog", "config": {"parameters": list(DEFAULT_PARAMETERS)}, "reviews": reviews}


def check_timeline():
    """A late review followed by an early one the next study day must count as one day apart."""
    day = lambda n: f"2026-03-{n:02d}"
    t = lambda n, h: int(datetime(2026, 3, n, h, tzinfo=timezone.utc).timestamp() * 1000)
    reviews = [
        {"day": day(1), "c": "a", "k": "fact", "r": 3, "t": t(1, 9)},
        {"day": day(1), "c": "b", "k": "fact", "r": 3, "t": t(1, 23)},   # late on day 1
        {"day": day(1), "c": "b", "k": "fact", "r": 3, "t": t(2, 2)},    # after midnight, same study day
        {"day": day(2), "c": "b", "k": "fact", "r": 3, "t": t(2, 8)},    # early on day 2
        {"day": day(2), "c": "a", "k": "fact", "r": 3, "t": t(2, 22)},
        {"day": day(5), "c": "a", "k": "fact", "r": 3, "t": t(5, 7)},
    ]
    logs, ids = optimize.to_logs(reviews)
    by = {}
    gaps = []
    for r, l in zip(reviews, logs):
        if r["c"] in by:
            gaps.append((r["c"], (l.review_datetime - by[r["c"]]).days))
        by[r["c"]] = l.review_datetime
    assert gaps == [("b", 0), ("b", 1), ("a", 1), ("a", 3)], gaps
    assert optimize.cross_day_count(logs) == 3


def main():
    check_timeline()
    export = simulate()
    with tempfile.TemporaryDirectory() as td:
        p = os.path.join(td, "export.json")
        with open(p, "w") as f:
            json.dump(export, f)
        out = optimize.main([p, "--out", os.path.join(td, "patch.json")])
    rep = out["report"]
    assert rep["n_cross_day"] >= 512, rep
    h = rep["heldout"]
    assert h["fitted"]["log_loss"] < h["current"]["log_loss"], h
    patch = out["patch"]
    assert len(patch["parameters"]) == 21
    assert patch["source"].startswith("Claude session")
    for kind, v in patch.get("kinds", {}).items():
        assert 0.7 <= v["retention"] <= 0.95, (kind, v)
    print(f"optimize ok: held-out log loss {h['current']['log_loss']:.4f} -> {h['fitted']['log_loss']:.4f}; retention {rep['retention']}")


if __name__ == "__main__":
    main()
