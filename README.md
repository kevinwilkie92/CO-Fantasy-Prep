# CO Fantasy Prep

A draft-day tool for a 12-team PPR keeper league on Sleeper
([league 1384887457304031232](https://sleeper.com/leagues/1384887457304031232/predraft)).

It is a static page. Everything — the league pull, the keeper math, the value
model — runs in your browser, so there is nothing to deploy and nothing to keep
in sync. Sleeper's API is public and read-only; the app never writes to it.

## Get to it from a link (phone + laptop)

The tool is published to GitHub Pages, so it lives at a URL you can bookmark on
any device:

**<https://kevinwilkie92.github.io/CO-Fantasy-Prep/>**

`.github/workflows/pages.yml` deploys the repo root on every push and switches
Pages on by itself the first time it runs, so there is nothing to configure. On
iPhone, *Share → Add to Home Screen* gives it an app icon.

If the URL 404s, open the [Actions
tab](https://github.com/kevinwilkie92/CO-Fantasy-Prep/actions) and check the
*Deploy to GitHub Pages* run. Should it fail on permissions, turn Pages on by
hand instead — [Settings →
Pages](https://github.com/kevinwilkie92/CO-Fantasy-Prep/settings/pages),
**Source** *Deploy from a branch*, **Branch** `claude/fantasy-draft-tool-icg1q5`
and folder `/ (root)`, then **Save**.

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
is outlined, and picks you own are tinted. Two toggles: overlay the keepers you
expect teams to declare, and fill every open pick with an ADP guess at who is
still there.

**Available** — everyone not yet drafted, sortable on any column, searchable,
with predicted keepers removed by default so the pool reflects reality. Click a
row for the full Ultimate Draft Kit writeup, projection, risk/upside and ADP.

**Keepers** — every player eligible to be kept, by team, plus a league-wide
*best keeper values* table.

**Keeper Sim** — tick the keepers you think each team will declare and watch the
board redraw. *Auto-predict* fills in every team's three biggest bargains as a
starting point. If you have picked your team, it also shows which of your rounds
survive and who the pool projects will be there when you pick.

## Traded picks

A traded pick keeps the board slot it started in — that is where it falls in the
snake — so the column heading is the team the pick *came from*, not always the
team that gets to use it. Any pick that changed hands is marked with a red edge
and an arrow naming who holds it now, and the count sits in the legend.

Ownership, not the column, drives everything downstream: your picks are tinted
wherever they sit, a pick you traded away stops counting as yours, and *Your
board after keepers* on the Keeper Sim lists every pick you actually hold —
including ones you traded for, labelled with who they came from.

Keepers are paid for with picks a team genuinely owns, so a pick acquired in a
trade can cover a keeper, and a round traded away cannot. If a predicted keeper
needs a round its team no longer holds, the board says so above the grid rather
than quietly placing him — leagues differ on whether that keeper is forfeited or
slides to another round, so it is flagged for you to settle.

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

## Reading the keeper table

Four columns carry the decision, left to right:

| Column | What it is |
| --- | --- |
| **Proj Rd** | Where the projections say he belongs — every player ranked by points over replacement, dealt out 12 to a round |
| **Cost** | The round keeping him burns |
| **Rounds** | `Cost − Proj Rd`. +4 means a 4th-round-caliber player for the price of an 8th |
| **Points** | His value minus what that pick would have returned anyway |

So *Tyler Warren projects 2nd, costs a 6th, +4 rounds* — that is the sentence the
table is built to say.

**Rounds** is the headline and the default sort. **Points** is the safer
tiebreak: a deep sleeper can show a fat round surplus at a 14th and still be
worth almost nothing, because a 14th-round pick was never going to return much
either. When the two disagree, believe the points. The sort toggle above the
table switches between them.

**ADP Rd** sits alongside as a reality check — where the room actually takes
him. Proj Rd is what he is *worth*; ADP Rd is what he *costs on the open
market*. A player projected 2nd but going 4th is a genuine edge; a player
projected 9th and undrafted by ADP means the model likes him and nobody else
does.

Replacement level is computed from your league's *actual* starting lineup, so
the value of an elite TE or a second RB reflects how this league is built, not a
generic template. That is why elite TEs crowd the top of the list — with one TE
slot and a flex, the gap between TE3 and TE14 is worth more than the same gap at
RB. The League Settings tab shows the replacement level it landed on for each
position.

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
.github/workflows/       Pages deploy
assets/app.js            API client, keeper engine, value model, all views
assets/styles.css
data/rankings.json       generated — do not edit by hand
data/raw/*.csv           Ultimate Draft Kit exports
scripts/build_rankings.py
scripts/fetch_league.py  offline league snapshot
```
