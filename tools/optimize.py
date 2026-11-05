"""Refit the scheduler from a Card Catalog export.

This is the "review my learning and improve the efficiency of your scheduler" step.

    python -m venv .venv && .venv/bin/pip install "fsrs[optimizer]==6.3.2"
    .venv/bin/python tools/optimize.py card-catalog-YYYY-MM-DD.json --out patch.json

What it does, and why each step exists:
  1. Rebuilds py-fsrs ReviewLogs from the export. The app counts elapsed time in study days
     (4am rollover); py-fsrs counts 24h periods. Reviews are mapped onto a timeline where every
     study day starts at UTC midnight and a day's reviews are compressed into its first hour,
     so py-fsrs sees exactly the same elapsed-day values the app used.
  2. Honest evaluation: fits on the first 80% of reviews (by time) and scores held-out later
     reviews. A refit is only proposed if it beats the current parameters on data it didn't see.
  3. Refits on everything and proposes the new 21 parameters.
  4. Efficiency: for each card kind with enough reviews (>= 512, durations required), simulates
     the review cost of target retentions 0.70-0.95 and picks the cheapest per unit of memory.
     Kinds without enough data keep their priors.
  5. Writes a JSON patch for the artifact's config/scheduler document.

py-fsrs returns its default parameters when it has fewer than 512 cross-day reviews. That gate
is reported rather than worked around.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from fsrs import Card, Rating, ReviewLog, Scheduler
from fsrs.scheduler import DEFAULT_PARAMETERS

try:
    from fsrs import Optimizer
except ImportError:  # pragma: no cover
    Optimizer = None

MIN_CROSS_DAY = 512
MIN_FOR_RETENTION = 512


def load(path):
    with open(path) as f:
        data = json.load(f)
    reviews = [r for r in data.get("reviews", []) if r.get("r") in (1, 2, 3, 4) and r.get("c") and r.get("t")]
    reviews.sort(key=lambda r: r["t"])
    return data, reviews


def to_logs(reviews):
    """Map app reviews onto a py-fsrs timeline with identical elapsed-day arithmetic."""
    first_t = {}
    for r in reviews:
        first_t.setdefault(r["day"], r["t"])
    ids = {}
    logs = []
    for r in reviews:
        y, m, d = (int(x) for x in r["day"].split("-"))
        offset_ms = min(max(r["t"] - first_t[r["day"]], 0), 23.5 * 3600 * 1000) / 24  # < 1h
        dt = datetime(y, m, d, tzinfo=timezone.utc) + timedelta(milliseconds=offset_ms)
        cid = ids.setdefault(r["c"], len(ids) + 1)
        dur = r.get("d")
        logs.append(ReviewLog(card_id=cid, rating=Rating(r["r"]), review_datetime=dt, review_duration=int(dur) if dur else None))
    return logs, ids


def score(params, logs, after=None):
    """Replay every card's history; return (log loss, n, rmse over 10 bins) on cross-day reviews (optionally only those after `after`)."""
    sched = Scheduler(parameters=params, enable_fuzzing=False)
    by_card = defaultdict(list)
    for l in logs:
        by_card[l.card_id].append(l)
    preds = []
    for cid, hist in by_card.items():
        card = Card(card_id=cid, due=hist[0].review_datetime)
        for l in sorted(hist, key=lambda x: x.review_datetime):
            if card.last_review is not None and (l.review_datetime - card.last_review).days >= 1:
                if after is None or l.review_datetime >= after:
                    p = min(max(sched.get_card_retrievability(card, l.review_datetime), 1e-6), 1 - 1e-6)
                    preds.append((p, 0 if l.rating == Rating.Again else 1))
            card, _ = sched.review_card(card, l.rating, review_datetime=l.review_datetime)
    if not preds:
        return None
    ll = -sum(y * math.log(p) + (1 - y) * math.log(1 - p) for p, y in preds) / len(preds)
    bins = defaultdict(list)
    for p, y in preds:
        bins[min(int(p * 10), 9)].append((p, y))
    sq = sum(len(b) * (sum(p for p, _ in b) / len(b) - sum(y for _, y in b) / len(b)) ** 2 for b in bins.values())
    return {"log_loss": ll, "rmse_bins": math.sqrt(sq / len(preds)), "n": len(preds)}


def cross_day_count(logs):
    last = {}
    n = 0
    for l in sorted(logs, key=lambda x: x.review_datetime):
        if l.card_id in last and (l.review_datetime - last[l.card_id]).days >= 1:
            n += 1
        last[l.card_id] = l.review_datetime
    return n


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("export")
    ap.add_argument("--out", help="write the config/scheduler patch here")
    ap.add_argument("--min-cross-day", type=int, default=MIN_CROSS_DAY)
    args = ap.parse_args(argv)

    data, reviews = load(args.export)
    current = (data.get("config") or {}).get("parameters") or list(DEFAULT_PARAMETERS)
    logs, _ = to_logs(reviews)
    n_cross = cross_day_count(logs)
    report = {"n_reviews": len(logs), "n_cross_day": n_cross}
    patch = {}
    print(f"{len(logs)} reviews, {n_cross} cross-day (the optimizer needs {args.min_cross_day}).")

    if Optimizer is None:
        sys.exit("py-fsrs optimizer extras missing: pip install 'fsrs[optimizer]'")

    if n_cross >= args.min_cross_day:
        cutoff = logs[int(len(logs) * 0.8)].review_datetime
        train = [l for l in logs if l.review_datetime < cutoff]
        fitted_train = Optimizer(train).compute_optimal_parameters()
        base = score(current, logs, after=cutoff)
        cand = score(fitted_train, logs, after=cutoff)
        report["heldout"] = {"current": base, "fitted": cand, "cutoff": cutoff.date().isoformat()}
        print(f"held-out log loss: current {base['log_loss']:.4f} -> fitted {cand['log_loss']:.4f} (n={cand['n']})")
        if cand["log_loss"] < base["log_loss"]:
            params = Optimizer(logs).compute_optimal_parameters()
            patch["parameters"] = [round(float(p), 6) for p in params]
            print("proposing refit on all reviews")
        else:
            params = current
            print("refit does not beat current parameters on held-out data; keeping them")
    else:
        params = current
        print("not enough cross-day reviews to refit parameters; keeping current ones")

    kinds = defaultdict(list)
    for r, l in zip(reviews, logs):
        kinds[r.get("k", "fact")].append(l)
    report["retention"] = {}
    for kind, klogs in sorted(kinds.items()):
        with_dur = [l for l in klogs if l.review_duration]
        if len(with_dur) >= MIN_FOR_RETENTION:
            opt = Optimizer(with_dur).compute_optimal_retention(params)
            patch.setdefault("kinds", {})[kind] = {"retention": float(opt)}
            report["retention"][kind] = {"n": len(with_dur), "optimal": float(opt)}
            print(f"{kind}: optimal retention {opt:.2f} from {len(with_dur)} timed reviews")
        else:
            report["retention"][kind] = {"n": len(with_dur), "optimal": None}
            print(f"{kind}: {len(with_dur)} timed reviews, need {MIN_FOR_RETENTION}; keeping prior")

    if patch:
        now = int(datetime.now(timezone.utc).timestamp() * 1000)
        cfg = data.get("config") or {}
        patch["source"] = "Claude session (tools/optimize.py)"
        patch["updatedAt"] = now
        patch["fit"] = report
        patch["history"] = (cfg.get("history") or [])[-19:] + [{"at": now, "by": "tools/optimize.py", "change": ", ".join(k for k in patch if k in ("parameters", "kinds"))}]
    out = {"patch": patch, "report": report}
    if args.out:
        with open(args.out, "w") as f:
            json.dump(out, f, indent=1)
        print(f"wrote {args.out}")
    else:
        json.dump(out, sys.stdout, indent=1)
    return out


if __name__ == "__main__":
    main()
