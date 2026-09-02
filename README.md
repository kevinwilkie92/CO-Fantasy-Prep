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

**Available** — the tab to live on during the draft. Above the pool sits a strip
answering what you need to know between picks:

- **Your next picks** — the next two you actually own, and how far away they are
- **Still to fill** — the starting slots you have not covered, plus a warning
  when three or more starters share a bye week
- **Tier cliffs** — how many players are left in the shallowest live tier at each
  position, red at two or fewer. This is the reach signal: when a tier is down
  to its last man, the next pick there is a visibly worse player
- **Runs** — "Last 10 picks: 8 QB, 2 WR — run on QB"
- **Targets** — star anyone in the table and they appear here with the odds they
  last until your next pick, most at risk first

Below that is the pool itself: everyone not yet drafted, sortable on any column,
searchable, keepers removed by default. Click a row for the full Ultimate Draft
Kit writeup, projection, risk/upside and ADP.

**Teams** — every roster, what it already holds and which starting slots it
still needs. Read the teams picking between you and your next pick to work out
whether your target survives.

**Keepers** — every player eligible to be kept, by team, plus a league-wide
*best keeper values* table.

**Keeper Sim** — once your league sets keepers this shows the real ones, read
from Sleeper. Before that it predicts them, and *Auto-predict* fills in every
team's three biggest bargains as a starting point. Either way, ticking and
unticking redraws the board, and if you have picked your team it shows which of
your rounds survive and who the pool projects will be there when you pick.

## Survival odds

The percentage next to a target is the chance he lasts until your next pick,
read off ADP with a deliberately wide spread — ADP is a mean and real rooms
deviate from it hard. Treat it as a lean, not a probability. Under about 40%
means take him now; over about 70% means you can spend this pick elsewhere and
still expect him back. It ignores what other teams actually need, which is what
the Teams tab is for.

## Where keepers come from

Sleeper stores locked keepers in two places depending on how the commissioner
set them up — a `keepers` list on each roster, and/or draft picks already
flagged as keepers. Both are read, so as soon as your league locks them the
board switches from predicting to showing the real thing and says so in green:
*"Keepers are set. 33 keepers across 12 teams, read from your league — not
predicted."*

Real keepers are re-read on every load and always win, including over a stale
guess saved in your browser from before they were set. Editing the set is still
allowed for what-ifs — the banner turns amber to say you are off the real
data, and *Reset to actual keepers* puts it back.

Sleeper's word also beats this tool's own arithmetic: a player your league kept
stays listed even if the two-year clock worked out here says he was burned, and
he is flagged rather than hidden. If a locked keeper cannot be paid for in his
cost round, the board says so and points at the override editor, because at that
point the cost derived from the prior draft is the thing that is probably wrong.

## Keeper rules encoded

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

- Up to **3 keepers** per team.
- A player may be kept **two years running, then he goes back in the pool**. The
  clock follows the *player*, not the manager — kept by two different owners in
  back-to-back years and he is done.
- Cost is **one round earlier than where he went last year**. First-rounders stay
  first-rounders. Undrafted players cost a **14th**.
- A keeper must be taken in the round he costs — he cannot be moved to another
  round to resolve a clash.
- Only players on the **end-of-season roster** are eligible.

A keeper is paid for with a pick in his **exact** cost round. He never moves to
another round, so two keepers who both cost a 5th need two 5th-round picks.

Whether that is a clash depends on how many picks the team actually holds in
that round: two picks in a round pays for two keepers, and a round traded away
pays for none. When there is no pick left, the keeper simply cannot be kept —
the board says so in red and leaves him off, and the Keeper Sim flags the exact
player with "no 5th left to pay with" so you can drop one of the pair.
Auto-predict already respects this and will never propose a set the rule
forbids; it takes the next-best keeper the team can actually pay for.

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

### Updating tiers from the app

The UDK app re-ranks through the summer while the CSV export does not, so
`data/raw/tiers_<pos>.csv` overlays fresher rank, tier, ADP, team and bye on top
of an export. Columns are `Rank,Name,Team,Bye,ADP,Tier`; a missing file just
means that position keeps its export. QB and RB are current from the app; WR and
TE still come from the export.

Projections and the writeups always come from the export, because the app screens
do not carry them. Two things follow:

- A player only in the app has his projection **estimated** from the ranked
  players either side of him.
- Where a projection flatly contradicts the app's rank — the app moved him 25+
  places — the projection is stale and gets re-estimated the same way. Josh
  Jacobs is the live example: the export projects him RB13, the app has him
  RB84, so his 234.6 points would otherwise have made him the best value on the
  board.

Estimated projections carry an asterisk in the Available table and are labelled
in the player pop-up. The rebuild prints every one it makes, along with any name
in the update that did not match the export — a mismatch there usually means a
typo in the update file.

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
