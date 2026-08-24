# CO Fantasy Prep

A draft-day tool for a 12-team PPR keeper league on Sleeper
([league 1384887457304031232](https://sleeper.com/leagues/1384887457304031232/predraft)).

It is a static page. Everything — the league pull, the keeper math, the value
model — runs in your browser, so there is nothing to deploy and nothing to keep
in sync. Sleeper's API is public and read-only; the app never writes to it.

## Get to it from a link (phone + laptop)

Turn on GitHub Pages once and the tool lives at a URL you can bookmark on any
device:

1. <https://github.com/kevinwilkie92/CO-Fantasy-Prep/settings/pages>
2. **Source** → *Deploy from a branch*
3. **Branch** → `claude/fantasy-draft-tool-icg1q5`, folder `/ (root)` → **Save**

A minute later it is live at:

**<https://kevinwilkie92.github.io/CO-Fantasy-Prep/>**

Every push to that branch redeploys automatically. On iPhone, *Share → Add to
Home Screen* gives it an app icon.

This repo is public, so anyone with the link can open the page — including your
leaguemates, keeper predictions and all. Nothing secret is in it (the league ID
is already in the Sleeper URL you share), but make the repo private if you would
rather they could not. Pages on a private repo needs a paid GitHub plan.

## Or run it locally

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

Serve it rather than double-clicking `index.html` — a `file://` page cannot load
`data/rankings.json`.

On load it pulls your league straight from `api.sleeper.app`: scoring rules,
roster slots, managers, the draft order your commissioner already set, live
picks, and every prior-season draft it can reach through Sleeper's
`previous_league_id` chain. Pick your team from the dropdown once and it sticks.

## The four tabs

**Draft Board** — the 12-wide snake grid, rounds down the side. Press *Start
live updates* on draft day and it polls every 10 seconds; the pick on the clock
is outlined, your column is tinted. Two toggles: overlay the keepers you expect
teams to declare, and fill every open pick with an ADP guess at who is still
there.

**Available** — everyone not yet drafted, sortable on any column, searchable,
with predicted keepers removed by default so the pool reflects reality. Click a
row for the full Ultimate Draft Kit writeup, projection, risk/upside and ADP.

**Keepers** — every player eligible to be kept, by team, plus a league-wide
*best keeper values* table.

**Keeper Sim** — tick the keepers you think each team will declare and watch the
board redraw. *Auto-predict* fills in every team's three biggest bargains as a
starting point. If you have picked your team, it also shows which of your rounds
survive and who the pool projects will be there when you pick.

## Keeper rules encoded

- Up to **3 keepers** per team.
- A player may be kept **two years running, then he goes back in the pool**. The
  clock follows the *player*, not the manager — kept by two different owners in
  back-to-back years and he is done.
- Cost is **one round earlier than where he went last year**. First-rounders stay
  first-rounders. Undrafted players cost a **14th**.
- Only players on the **end-of-season roster** are eligible.

Two rounds can collide — a team keeping both its 1st and 2nd rounders owes two
1sts. The app slides the second keeper to the nearest open *earlier* round, or
later if there is no earlier one, and prints exactly what it did above the
board. Confirm that tiebreak matches your league's house rule.

### If Sleeper never flagged your keepers

Keeper cost is reconstructed from prior drafts, and Sleeper only knows a pick
was a keeper if it was flagged that way at the time. If your league did not flag
them, the Keepers tab has an override editor for cost and years-used. Overrides
are stored in your browser and survive reloads.

## Two numbers on every keeper

**Value (points)** is the one to trust. It is the player's projected points over
replacement, minus what the pick he burns would have bought you anyway. Positive
means keeping him beats drafting at that slot.

**Rounds** is the same idea in draft capital — the round he costs minus the round
he actually goes. It is the number to quote in trade talk, but it flatters deep
sleepers: a player who would go undrafted still shows a fat round surplus at a
14th. When the two disagree, believe the points.

Replacement level is computed from your league's *actual* starting lineup, so
the value of an elite TE or a second RB reflects how this league is built, not a
generic template. The League Settings tab shows the replacement level it landed
on for each position.

## Rankings

Projections, tiers, ADP, risk/upside and writeups come from the Ultimate Draft
Kit position rankings (Fantasy Footballers) — 312 players across QB/RB/WR/TE.

Source CSVs live in `data/raw/`. To refresh them, drop in new exports with the
same columns and rebuild:

```sh
python3 scripts/build_rankings.py
```

## When Sleeper is unreachable

Some networks block `api.sleeper.app`. Run this anywhere that can reach it:

```sh
python3 scripts/fetch_league.py [league_id]
```

It writes `data/league.json`, and the app falls back to that file automatically
when the live call fails (and to its last cached load after that). Live pick
polling is off in that mode. `data/league.json` is gitignored — it is a
snapshot, not source.

## Layout

```
index.html               shell and tab markup
.nojekyll                stops GitHub Pages running the files through Jekyll
assets/app.js            API client, keeper engine, value model, all views
assets/styles.css
data/rankings.json       generated — do not edit by hand
data/raw/*.csv           Ultimate Draft Kit exports
scripts/build_rankings.py
scripts/fetch_league.py  offline league snapshot
```
