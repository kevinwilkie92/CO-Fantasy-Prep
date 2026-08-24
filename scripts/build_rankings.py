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
