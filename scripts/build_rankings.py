#!/usr/bin/env python3
"""Convert the Ultimate Draft Kit position-ranking CSVs into data/rankings.json.

Run from the repo root:  python3 scripts/build_rankings.py
"""
import csv
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw")
OUT = os.path.join(ROOT, "data", "rankings.json")

SOURCES = [
    ("QB", "udk_qb.csv"),
    ("RB", "udk_rb.csv"),
    ("WR", "udk_wr.csv"),
    ("TE", "udk_te.csv"),
]

# Fresher rank/tier/ADP straight from the UDK app, overlaid on the CSV exports.
# The app screens carry no projections, so points and the writeups keep coming
# from the export; everything the app does show wins.
TIER_UPDATES = [
    ("QB", "tiers_qb.csv"),
    ("RB", "tiers_rb.csv"),
    ("WR", "tiers_wr.csv"),
    ("TE", "tiers_te.csv"),
]

SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "v"}


def normalize(name):
    """Key used to match a ranking row to a Sleeper player."""
    n = name.lower().strip()
    n = n.replace("’", "'").replace("‘", "'")
    n = re.sub(r"[.'`\-]", "", n)
    parts = [p for p in re.split(r"\s+", n) if p and p not in SUFFIXES]
    return " ".join(parts)


def num(value):
    value = (value or "").strip()
    if not value:
        return None
    try:
        return float(value)
    except ValueError:
        return None


def adp_to_pick(adp, teams=12):
    """'2.11' -> overall pick 23. Returns None when the player has no ADP."""
    adp = (adp or "").strip()
    if not adp:
        return None
    m = re.match(r"^(\d+)\.(\d+)$", adp)
    if not m:
        return None
    rnd, slot = int(m.group(1)), int(m.group(2))
    return (rnd - 1) * teams + slot


def clean(text):
    text = (text or "").strip()
    # A couple of source rows carry stray newlines inside the quoted cell.
    return re.sub(r"\s*\n\s*", " ", text)


def interpolate_points(rows):
    """Fill projections for players the export never had, from their neighbours.

    A player who only appears in the app has no projection. Rather than drop him
    off the value board entirely, estimate from the ranked players either side of
    him; the tails decay from the nearest known value.
    """
    known = [i for i, r in enumerate(rows) if r["points"] is not None]
    if not known:
        return
    for i, row in enumerate(rows):
        if row["points"] is not None:
            continue
        before = [k for k in known if k < i]
        after = [k for k in known if k > i]
        if before and after:
            a, b = before[-1], after[0]
            pa, pb = rows[a]["points"], rows[b]["points"]
            row["points"] = round(pa + (pb - pa) * (i - a) / float(b - a), 1)
        elif before:
            row["points"] = round(rows[before[-1]]["points"] * (0.97 ** (i - before[-1])), 1)
        else:
            row["points"] = round(rows[after[0]]["points"] * (1.03 ** (after[0] - i)), 1)
        row["estimated"] = True


def reconcile_projections(rows, threshold=25):
    """Drop projections the app's ranking flatly contradicts.

    Projections come from the older CSV export and the ranks from the app, so
    they can drift apart. Small gaps are honest disagreement - a ranker valuing
    upside over a median projection - and are left alone. A player the app has
    moved dozens of places has had something happen the export predates, and
    his stale projection would otherwise put him top of the value board.
    """
    known = [r for r in rows if r["points"] is not None]
    by_points = sorted(known, key=lambda r: -r["points"])
    implied = {id(r): i + 1 for i, r in enumerate(by_points)}
    stale = []
    for r in known:
        gap = abs(implied[id(r)] - (r["posRank"] or 999))
        if gap >= threshold:
            stale.append((r["name"], implied[id(r)], r["posRank"], gap))
            r["points"] = None
    interpolate_points(rows)
    return stale


def apply_tier_updates(players):
    """Rebuild a position's list from an app export when one is present."""
    by_pos = {}
    for p in players:
        by_pos.setdefault(p["pos"], []).append(p)

    for pos, filename in TIER_UPDATES:
        path = os.path.join(RAW, filename)
        if not os.path.exists(path):
            print("  %s: no tier update, keeping the CSV export" % pos)
            continue
        base = {p["key"]: p for p in by_pos.get(pos, [])}
        rebuilt, added = [], []
        with open(path, newline="", encoding="utf-8") as fh:
            for row in csv.DictReader(fh):
                name = clean(row.get("Name"))
                if not name:
                    continue
                key = normalize(name)
                p = base.pop(key, None)
                if p is None:
                    p = {"name": name, "key": key, "pos": pos, "points": None,
                         "risk": None, "upside": None, "outlook": "", "dynasty": ""}
                    added.append(name)
                p["name"] = name
                p["team"] = clean(row.get("Team"))
                p["bye"] = int(row["Bye"]) if (row.get("Bye") or "").strip().isdigit() else None
                p["posRank"] = int(row["Rank"]) if (row.get("Rank") or "").strip().isdigit() else None
                p["tier"] = int(row["Tier"]) if (row.get("Tier") or "").strip().isdigit() else None
                p["adp"] = clean(row.get("ADP")) or None
                p["adpPick"] = adp_to_pick(row.get("ADP"))
                rebuilt.append(p)
        rebuilt.sort(key=lambda r: r["posRank"] or 999)
        interpolate_points(rebuilt)
        for name, was, now, gap in reconcile_projections(rebuilt):
            print("  %s: re-estimated %s - projection implied %s%d, app says %s%d (%d places)"
                  % (pos, name, pos, was, pos, now, gap))
        by_pos[pos] = rebuilt
        print("  %s: %d ranked from app (%d new%s; %d dropped%s)" % (
            pos, len(rebuilt), len(added),
            (": " + ", ".join(added[:4]) + ("…" if len(added) > 4 else "")) if added else "",
            len(base),
            (": " + ", ".join(sorted(p["name"] for p in base.values())[:4])
             + ("…" if len(base) > 4 else "")) if base else ""))

    out = []
    for pos, _ in SOURCES:
        out.extend(by_pos.get(pos, []))
    return out


def main():
    players = []
    seen = {}
    for pos, filename in SOURCES:
        path = os.path.join(RAW, filename)
        if not os.path.exists(path):
            sys.exit("missing source file: %s" % path)
        with open(path, newline="", encoding="utf-8") as fh:
            for row in csv.DictReader(fh):
                name = clean(row.get("Name"))
                # The RB export has one malformed row where an outlook blob
                # spilled into its own record; those have no Position value.
                if not name or (row.get("Position") or "").strip() != pos:
                    continue
                key = normalize(name)
                if key in seen:
                    continue
                seen[key] = True
                players.append({
                    "name": name,
                    "key": key,
                    "pos": pos,
                    "team": clean(row.get("Team")),
                    "bye": int(row["Bye Week"]) if (row.get("Bye Week") or "").strip().isdigit() else None,
                    "posRank": int(row["Rank"]) if (row.get("Rank") or "").strip().isdigit() else None,
                    "points": num(row.get("Points")),
                    "risk": num(row.get("Risk")),
                    "upside": num(row.get("Upside")),
                    "adp": clean(row.get("ADP")) or None,
                    "adpPick": adp_to_pick(row.get("ADP")),
                    "tier": int(row["Tier"]) if (row.get("Tier") or "").strip().isdigit() else None,
                    "outlook": clean(row.get("Outlook")),
                    "dynasty": clean(row.get("Dynasty")),
                })

    players = apply_tier_updates(players)

    # Overall rank: order by projected points within a positional value model.
    # We rank straight off projected points so the board has a single spine,
    # then expose position rank + tier separately for positional context.
    ranked = sorted(players, key=lambda p: (-(p["points"] or 0), p["pos"], p["posRank"] or 999))
    for i, p in enumerate(ranked, 1):
        p["ptsRank"] = i

    payload = {
        "source": "Ultimate Draft Kit position rankings (Fantasy Footballers)",
        "counts": {pos: sum(1 for p in players if p["pos"] == pos) for pos, _ in SOURCES},
        "players": ranked,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
    print("wrote %s (%d players)" % (OUT, len(ranked)))
    print(payload["counts"])


if __name__ == "__main__":
    main()
