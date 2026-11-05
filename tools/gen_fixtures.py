"""Generate parity fixtures for src/fsrs.js from the reference py-fsrs implementation.

    python -m venv .venv && .venv/bin/pip install fsrs==6.3.2
    .venv/bin/python tools/gen_fixtures.py > test/fixtures/pyfsrs.json

Each case is a randomized review history under one scheduler configuration (fuzzing off).
The JS port must reproduce every intermediate card state.
"""

import json
import random
import sys
from datetime import datetime, timedelta, timezone

import fsrs
from fsrs import Card, Rating, Scheduler
from fsrs.scheduler import DEFAULT_PARAMETERS, LOWER_BOUNDS_PARAMETERS, UPPER_BOUNDS_PARAMETERS

EPOCH = datetime(2026, 1, 5, 9, 30, tzinfo=timezone.utc)


def ms(dt):
    return int(round(dt.timestamp() * 1000))


def perturbed_params(rng):
    out = []
    for p, lo, hi in zip(DEFAULT_PARAMETERS, LOWER_BOUNDS_PARAMETERS, UPPER_BOUNDS_PARAMETERS):
        v = p * rng.uniform(0.7, 1.3)
        out.append(min(max(v, lo), hi))
    return out


def configs(rng):
    yield "default", dict()
    yield "no-steps", dict(learning_steps=(), relearning_steps=())
    yield "r085-one-step", dict(desired_retention=0.85, learning_steps=(timedelta(minutes=10),), relearning_steps=(timedelta(minutes=10),))
    yield "r080-two-relearn", dict(desired_retention=0.80, relearning_steps=(timedelta(minutes=5), timedelta(minutes=30)))
    yield "max-30", dict(maximum_interval=30)
    for i in range(3):
        yield f"perturbed-{i}", dict(parameters=perturbed_params(rng))


def gap(rng):
    kind = rng.random()
    if kind < 0.25:
        return timedelta(minutes=rng.choice([1, 2, 5, 10, 30, 90]))
    if kind < 0.35:
        return timedelta(hours=rng.uniform(1, 23))
    return timedelta(days=rng.randint(1, 120), hours=rng.uniform(-6, 6))


def main():
    rng = random.Random(20261105)
    cases = []
    for name, kw in configs(rng):
        sched = Scheduler(enable_fuzzing=False, **kw)
        cfg = sched.to_dict()
        for seq in range(12):
            card = Card(card_id=1, due=EPOCH)
            t = EPOCH
            steps = []
            for _ in range(rng.randint(3, 18)):
                rating = Rating(rng.choices([1, 2, 3, 4], weights=[2, 1.5, 5, 1.5])[0])
                card, _log = sched.review_card(card, rating, review_datetime=t)
                probe_t = t + timedelta(days=rng.randint(0, 60))
                steps.append(
                    dict(
                        rating=int(rating),
                        now=ms(t),
                        state=int(card.state),
                        step=card.step,
                        stability=card.stability,
                        difficulty=card.difficulty,
                        due=ms(card.due),
                        last_review=ms(card.last_review),
                        probe_now=ms(probe_t),
                        probe_r=sched.get_card_retrievability(card, probe_t),
                    )
                )
                t = t + gap(rng)
            cases.append(dict(name=f"{name}#{seq}", config=cfg, start=ms(EPOCH), steps=steps))
    json.dump(dict(generator=f"py-fsrs {fsrs.__version__ if hasattr(fsrs, '__version__') else '6.3.2'}", cases=cases), sys.stdout, indent=1)


if __name__ == "__main__":
    main()
