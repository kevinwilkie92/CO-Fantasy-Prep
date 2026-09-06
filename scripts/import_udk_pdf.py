#!/usr/bin/env python3
"""Turn a UDK "Redraft Rankings" PDF into the data/raw/tiers_*.csv overlays.

    python3 scripts/import_udk_pdf.py <rankings.pdf>

The PDF carries rank, tier, bye, ADP, risk, upside and projected points for
every position plus team defences — everything the app screens show and the
projections besides — so it supersedes both the CSV export and the screenshot
transcriptions.
"""
import csv
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw")

SECTIONS = [
    ("Quarterbacks", "QB", "tiers_qb.csv"),
    ("Running Backs", "RB", "tiers_rb.csv"),
    ("Wide Receivers", "WR", "tiers_wr.csv"),
    ("Tight Ends", "TE", "tiers_te.csv"),
    ("Defenses", "DEF", "tiers_def.csv"),
]

# Legend and footer text that shares the page with the tables.
NOISE = {"My Guy", "Value", "Bust", "Sleeper", "Rookie", "Injury Concerns",
         "Breakout", "Super Kamario", "Redraft Rankings"}

# A row: rank, name, (team), bye, adp, risk, upside, points. Rows wrap freely
# across lines in the PDF, so the section is flattened before matching. A free
# agent has no bye and may have no ADP, both of which come through as "-".
ROW = re.compile(
    r"(\d{1,3})\s+([^()\d][^()]*?)\s*\(([A-Z]{2,3})\)\s*"
    r"(\d{1,2}|-)\s+(\d+\.\d+|-)\s+(\d+\.\d+)\s+(\d+\.\d+)\s+(\d+\.\d+)")
TIER = re.compile(r"TIER\s+(\d+)")
DEF_ROW = re.compile(r"^(\d{1,2})\s+(.+?)\s+(\d{1,2})$")


def read_pdf(path):
    import pypdf
    reader = pypdf.PdfReader(path)
    return "\n".join((page.extract_text() or "") for page in reader.pages)


def split_sections(text):
    """Carve the document up by position heading, in the order they appear."""
    marks = []
    for heading, pos, filename in SECTIONS:
        i = text.find(heading)
        if i < 0:
            print("  ! no %s section found" % heading)
            continue
        marks.append((i, heading, pos, filename))
    marks.sort()
    out = []
    for n, (start, heading, pos, filename) in enumerate(marks):
        end = marks[n + 1][0] if n + 1 < len(marks) else len(text)
        out.append((pos, filename, text[start:end]))
    return out


def parse_players(chunk):
    """Walk a flattened section, keeping tier banners and rows in order."""
    for line in NOISE:
        chunk = chunk.replace(line, " ")
    chunk = re.sub(r"\d{1,2}/\d{1,2}/\d{4}", " ", chunk)
    flat = re.sub(r"\s+", " ", chunk)

    events = []
    for m in TIER.finditer(flat):
        events.append((m.start(), "tier", int(m.group(1))))
    for m in ROW.finditer(flat):
        events.append((m.start(), "row", m))
    events.sort(key=lambda e: e[0])

    rows, tier = [], None
    for _, kind, payload in events:
        if kind == "tier":
            tier = payload
            continue
        rank, name, team, bye, adp, risk, up, pts = payload.groups()
        rows.append({
            "Rank": int(rank), "Name": name.strip(), "Team": team,
            "Bye": "" if bye == "-" else int(bye),
            "ADP": "" if adp == "-" else adp, "Tier": tier or "",
            "Points": pts, "Risk": risk, "Upside": up,
        })
    return rows


def parse_defenses(chunk, abbrevs):
    rows = []
    for line in chunk.split("\n"):
        line = line.strip()
        if not line or line in NOISE:
            continue
        m = DEF_ROW.match(line)
        if not m:
            continue
        rank, name, bye = m.groups()
        name = name.strip()
        if name not in abbrevs:
            print("  ! unknown defence %r - keeping the name, no team code" % name)
        rows.append({
            "Rank": int(rank), "Name": name, "Team": abbrevs.get(name, ""),
            "Bye": int(bye), "ADP": "", "Tier": "", "Points": "", "Risk": "", "Upside": "",
        })
    return rows


def existing_def_abbrevs():
    """Team codes for defences, carried over from the current overlay."""
    path = os.path.join(RAW, "tiers_def.csv")
    out = {}
    if os.path.exists(path):
        with open(path, newline="", encoding="utf-8") as fh:
            for row in csv.DictReader(fh):
                out[row["Name"]] = row["Team"]
    return out


FIELDS = ["Rank", "Name", "Team", "Bye", "ADP", "Tier", "Points", "Risk", "Upside"]


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    text = read_pdf(sys.argv[1])
    abbrevs = existing_def_abbrevs()

    for pos, filename, chunk in split_sections(text):
        rows = parse_defenses(chunk, abbrevs) if pos == "DEF" else parse_players(chunk)
        if not rows:
            print("  ! %s: nothing parsed, leaving %s alone" % (pos, filename))
            continue
        ranks = [r["Rank"] for r in rows]
        gaps = [n for n in range(1, max(ranks) + 1) if n not in set(ranks)]
        if gaps:
            print("  ! %s: missing rank(s) %s - check the PDF" % (pos, gaps[:10]))
        with open(os.path.join(RAW, filename), "w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=FIELDS)
            w.writeheader()
            for r in sorted(rows, key=lambda r: r["Rank"]):
                w.writerow(r)
        tiers = sorted({r["Tier"] for r in rows if r["Tier"]})
        print("  %s: %d players, %d tiers -> %s" % (pos, len(rows), len(tiers), filename))


if __name__ == "__main__":
    main()
