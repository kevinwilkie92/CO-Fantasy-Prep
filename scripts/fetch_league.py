#!/usr/bin/env python3
"""Snapshot a Sleeper league into data/league.json.

The web app normally talks to api.sleeper.app straight from the browser. Run
this only when that is blocked (locked-down network, offline draft night) —
it writes the same payload to disk and the app falls back to it automatically.

    python3 scripts/fetch_league.py [league_id]
"""
import json
import os
import sys
import urllib.request

API = "https://api.sleeper.app/v1"
DEFAULT_LEAGUE = "1384887457304031232"
KEEP_POS = {"QB", "RB", "WR", "TE", "K", "DEF"}
MAX_PRIOR_SEASONS = 6

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "league.json")


def get(path):
    with urllib.request.urlopen(API + path, timeout=60) as res:
        return json.load(res)


def history(league):
    """Walk previous_league_id back and collect each completed draft."""
    seasons = []
    prev_id = league.get("previous_league_id")
    guard = 0
    while prev_id and prev_id != "0" and guard < MAX_PRIOR_SEASONS:
        guard += 1
        try:
            prev = get("/league/%s" % prev_id)
        except Exception as exc:
            print("  ! stopped walking history at %s: %s" % (prev_id, exc))
            break
        for draft in get("/league/%s/drafts" % prev_id) or []:
            if draft.get("status") != "complete":
                continue
            picks = get("/draft/%s/picks" % draft["draft_id"]) or []
            seasons.append({
                "season": int(prev.get("season") or draft.get("season") or 0),
                "leagueId": prev_id,
                "draftId": draft["draft_id"],
                "rounds": (draft.get("settings") or {}).get("rounds"),
                "teams": (draft.get("settings") or {}).get("teams") or prev.get("total_rosters"),
                "picks": picks,
            })
            print("  + %s draft: %d picks" % (prev.get("season"), len(picks)))
        prev_id = prev.get("previous_league_id")
    seasons.sort(key=lambda s: s["season"], reverse=True)
    return seasons


def trimmed_players():
    """The full dump is ~5MB; keep only what the board needs."""
    out = {}
    for pid, p in (get("/players/nfl") or {}).items():
        if not p:
            continue
        pos = p.get("position") or (p.get("fantasy_positions") or [None])[0]
        if pos not in KEEP_POS:
            continue
        name = p.get("full_name") or ("%s %s" % (p.get("first_name") or "", p.get("last_name") or "")).strip()
        if not name:
            continue
        out[pid] = [name, pos, p.get("team") or ""]
    return out


def main():
    league_id = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_LEAGUE
    print("league %s" % league_id)
    league = get("/league/%s" % league_id)
    print("  %s (%s)" % (league.get("name"), league.get("season")))

    drafts = get("/league/%s/drafts" % league_id) or []
    drafts.sort(key=lambda d: d.get("created") or 0, reverse=True)
    draft = next((d for d in drafts if d.get("draft_id") == league.get("draft_id")), None) or (drafts[0] if drafts else None)
    picks = get("/draft/%s/picks" % draft["draft_id"]) if draft else []

    # Picks that changed hands, narrowed to this draft's season.
    season = str((draft or {}).get("season") or league.get("season"))
    try:
        traded = [t for t in (get("/league/%s/traded_picks" % league_id) or [])
                  if str(t.get("season")) == season]
    except Exception as exc:
        print("  ! could not read traded picks: %s" % exc)
        traded = []
    print("  traded picks this season: %d" % len(traded))

    bundle = {
        "league": league,
        "rosters": get("/league/%s/rosters" % league_id),
        "users": get("/league/%s/users" % league_id),
        "draft": draft,
        "picks": picks or [],
        "tradedPicks": traded,
        "history": history(league),
        "players": trimmed_players(),
    }

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(bundle, fh, separators=(",", ":"))
    print("wrote %s (%.1f MB)" % (OUT, os.path.getsize(OUT) / 1e6))


if __name__ == "__main__":
    main()
