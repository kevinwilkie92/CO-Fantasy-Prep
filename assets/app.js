/* CO Fantasy Prep — keeper draft tool
 *
 * Everything runs in your browser. The Sleeper API is public and read-only,
 * so the app pulls league settings, rosters, draft order, live picks and the
 * full prior-draft history straight from api.sleeper.app on your machine.
 */

'use strict';

const API = 'https://api.sleeper.app/v1';
const DEFAULT_LEAGUE = '1384887457304031232';
const LS = {
  league: 'cofp.leagueId',
  team: 'cofp.myRosterId',
  players: 'cofp.playersNfl',
  overrides: 'cofp.overrides',
  predicted: 'cofp.predicted',
  keeperSort: 'cofp.keeperSort',
  snapshot: 'cofp.snapshot',
};

const POS_ORDER = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
const FLEX_SETS = {
  FLEX: ['RB', 'WR', 'TE'],
  WRRB_FLEX: ['RB', 'WR'],
  REC_FLEX: ['WR', 'TE'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
};

/* ------------------------------------------------------------------ state */

const S = {
  leagueId: null,
  league: null,
  rosters: [],
  users: [],
  draft: null,
  picks: [],
  history: [],          // [{season, leagueId, draftId, picks}] newest completed first
  tradedPicks: [],      // picks that changed hands for this draft's season
  nflPlayers: {},       // id -> [name, pos, team]
  rankings: [],
  byKey: new Map(),     // normalized name -> ranking row
  keepers: new Map(),   // sleeper player_id -> keeper record
  predicted: new Set(), // sleeper player_ids currently treated as keepers
  actualKeepers: new Set(), // keepers the league has actually locked in
  unmatchedKeepers: [],   // locked keeper ids we could not resolve to a player
  keeperMode: 'whatif',   // 'actual' once Sleeper has real keepers loaded
  keeperTeamCount: 0,     // teams with at least one locked keeper
  overrides: {},        // player_id -> {cost, years, note}
  myRosterId: null,
  pollTimer: null,
  loadedAt: null,
};

/* ------------------------------------------------------------------ utils */

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of [].concat(children || [])) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return node;
}

const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

/** Must mirror normalize() in scripts/build_rankings.py. */
function normName(name) {
  if (!name) return '';
  let n = String(name).toLowerCase().trim();
  n = n.replace(/[’‘]/g, "'");
  n = n.replace(/[.'`\-]/g, '');
  return n.split(/\s+/).filter((p) => p && !SUFFIXES.has(p)).join(' ');
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function fmt(n, digits) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return Number(n).toFixed(digits === undefined ? 1 : digits);
}

function signed(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return (n > 0 ? '+' : '') + n;
}

function lsGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch (e) { return fallback; }
}

function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* quota */ }
}

function setStatus(text, kind) {
  $('#statusText').textContent = text;
  $('#statusDot').className = 'dot' + (kind ? ' ' + kind : '');
}

/* -------------------------------------------------------------- api layer */

async function api(path) {
  const res = await fetch(API + path, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error('Sleeper ' + res.status + ' for ' + path);
  return res.json();
}

/** The full NFL player dump is ~5MB, so trim it hard and cache it for a week. */
async function loadNflPlayers(force) {
  const cached = lsGet(LS.players, null);
  const WEEK = 7 * 24 * 3600 * 1000;
  if (!force && cached && cached.at && Date.now() - cached.at < WEEK && cached.map) {
    S.nflPlayers = cached.map;
    return;
  }
  setStatus('Loading NFL player list (~5MB, cached after this)…');
  const all = await api('/players/nfl');
  const map = {};
  for (const [id, p] of Object.entries(all)) {
    if (!p) continue;
    const pos = p.position || (p.fantasy_positions && p.fantasy_positions[0]);
    if (!pos || POS_ORDER.indexOf(pos) === -1) continue;
    const name = p.full_name || ((p.first_name || '') + ' ' + (p.last_name || '')).trim();
    if (!name) continue;
    map[id] = [name, pos, p.team || ''];
  }
  S.nflPlayers = map;
  lsSet(LS.players, { at: Date.now(), map });
}

function playerName(id) {
  const p = S.nflPlayers[id];
  return p ? p[0] : String(id);
}
function playerPos(id) {
  const p = S.nflPlayers[id];
  return p ? p[1] : '';
}
function playerTeam(id) {
  const p = S.nflPlayers[id];
  return p ? p[2] : '';
}

/** Walk previous_league_id back through prior seasons and grab each draft. */
async function loadHistory(league, maxSeasons) {
  const history = [];
  let prevId = league.previous_league_id;
  let guard = 0;
  while (prevId && prevId !== '0' && guard < (maxSeasons || 6)) {
    guard += 1;
    let prev;
    try { prev = await api('/league/' + prevId); } catch (e) { break; }
    if (!prev) break;
    let drafts = [];
    try { drafts = await api('/league/' + prevId + '/drafts'); } catch (e) { drafts = []; }
    for (const d of (drafts || [])) {
      if (d.status !== 'complete') continue;
      let picks = [];
      try { picks = await api('/draft/' + d.draft_id + '/picks'); } catch (e) { picks = []; }
      history.push({
        season: Number(prev.season) || Number(d.season),
        leagueId: prevId,
        draftId: d.draft_id,
        rounds: (d.settings && d.settings.rounds) || null,
        teams: (d.settings && d.settings.teams) || prev.total_rosters,
        picks: picks || [],
      });
    }
    prevId = prev.previous_league_id;
  }
  history.sort((a, b) => b.season - a.season);
  return history;
}

async function loadLeague(leagueId) {
  S.leagueId = leagueId;
  setStatus('Loading league…');
  const league = await api('/league/' + leagueId);
  const [rosters, users, drafts] = await Promise.all([
    api('/league/' + leagueId + '/rosters'),
    api('/league/' + leagueId + '/users'),
    api('/league/' + leagueId + '/drafts'),
  ]);
  S.league = league;
  S.rosters = rosters || [];
  S.users = users || [];

  // The upcoming draft: prefer the league's own draft_id, else the newest.
  const list = (drafts || []).slice().sort((a, b) => (b.created || 0) - (a.created || 0));
  S.draft = list.find((d) => d.draft_id === league.draft_id) || list[0] || null;

  setStatus('Loading draft picks…');
  S.picks = S.draft ? await api('/draft/' + S.draft.draft_id + '/picks').catch(() => []) : [];

  // Picks that changed hands. Sleeper keys these by the roster the pick
  // originally belonged to, which is the slot it still sits in on the board.
  const season = String((S.draft && S.draft.season) || league.season);
  const traded = await api('/league/' + leagueId + '/traded_picks').catch(() => []);
  S.tradedPicks = (traded || []).filter((t) => String(t.season) === season);

  setStatus('Loading prior-season drafts…');
  S.history = await loadHistory(league, 6);

  await loadNflPlayers(false);

  S.loadedAt = new Date();
  lsSet(LS.league, leagueId);
  lsSet(LS.snapshot, {
    at: Date.now(),
    league,
    rosters: S.rosters,
    users: S.users,
    draft: S.draft,
    picks: S.picks,
    history: S.history,
    tradedPicks: S.tradedPicks,
  });
}

/* -------------------------------------------------- league shape helpers */

function teamCount() {
  return (S.draft && S.draft.settings && S.draft.settings.teams)
    || (S.league && S.league.total_rosters) || 12;
}

function roundCount() {
  return (S.draft && S.draft.settings && S.draft.settings.rounds) || 14;
}

function rosterPositions() {
  return (S.league && S.league.roster_positions) || [];
}

function starterSlots() {
  return rosterPositions().filter((p) => p !== 'BN' && p !== 'IR' && p !== 'TAXI');
}

function userFor(rosterId) {
  const roster = S.rosters.find((r) => r.roster_id === rosterId);
  if (!roster) return null;
  return S.users.find((u) => u.user_id === roster.owner_id) || null;
}

function teamName(rosterId) {
  const u = userFor(rosterId);
  if (!u) return 'Team ' + rosterId;
  return (u.metadata && u.metadata.team_name) || u.display_name || ('Team ' + rosterId);
}

/** Draft slot (1..N) -> roster_id, from the order the commissioner already set. */
function slotToRoster() {
  const map = {};
  if (S.draft && S.draft.slot_to_roster_id) {
    for (const [slot, rid] of Object.entries(S.draft.slot_to_roster_id)) {
      if (rid) map[Number(slot)] = Number(rid);
    }
  }
  if (Object.keys(map).length === 0 && S.draft && S.draft.draft_order) {
    for (const [userId, slot] of Object.entries(S.draft.draft_order)) {
      const roster = S.rosters.find((r) => r.owner_id === userId);
      if (roster) map[Number(slot)] = roster.roster_id;
    }
  }
  return map;
}

function rosterToSlot() {
  const out = {};
  for (const [slot, rid] of Object.entries(slotToRoster())) out[rid] = Number(slot);
  return out;
}

/**
 * Who actually holds each pick. A pick keeps the board slot of the roster it
 * was originally assigned to; a trade only changes who gets to use it.
 * Returns a map of "round:originalRosterId" -> current owner roster_id.
 */
function pickOwnerMap() {
  const map = new Map();
  for (const t of (S.tradedPicks || [])) {
    const original = Number(t.roster_id);
    const owner = Number(t.owner_id);
    if (!original || !owner || !t.round) continue;
    map.set(Number(t.round) + ':' + original, owner);
  }
  return map;
}

/** Snake order: overall pick number for a given round + draft slot. */
function pickNumber(round, slot) {
  const t = teamCount();
  return (round - 1) * t + (round % 2 === 1 ? slot : t - slot + 1);
}


/* ------------------------------------------------------- rankings + value */

async function loadRankings() {
  const res = await fetch('data/rankings.json');
  if (!res.ok) throw new Error('Could not load data/rankings.json (' + res.status + ')');
  const payload = await res.json();
  S.rankings = payload.players || [];
  S.byKey = new Map(S.rankings.map((p) => [p.key, p]));
  computeValue();
}

/**
 * Value over replacement, using the league's actual starter requirements.
 * Replacement level for a position = the projected points of the player who
 * sits just past the last starter the league will realistically roster there.
 */
function computeValue() {
  const teams = teamCount();
  const slots = starterSlots();
  const base = { QB: 0, RB: 0, WR: 0, TE: 0 };
  const flexPools = [];
  for (const slot of slots) {
    if (base[slot] !== undefined) { base[slot] += 1; continue; }
    if (FLEX_SETS[slot]) flexPools.push(FLEX_SETS[slot]);
  }
  // Spread each flex slot across its eligible positions by how often that
  // position actually wins the spot in PPR.
  const FLEX_WEIGHT = { QB: 0.9, RB: 0.45, WR: 0.4, TE: 0.15 };
  for (const pool of flexPools) {
    const total = pool.reduce((sum, p) => sum + (FLEX_WEIGHT[p] || 0), 0) || 1;
    for (const p of pool) base[p] += (FLEX_WEIGHT[p] || 0) / total;
  }
  // Nobody starts zero of a position they still draft; keep a small floor.
  for (const p of ['QB', 'RB', 'WR', 'TE']) if (!base[p]) base[p] = 0.35;

  const replacement = {};
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    const pool = S.rankings.filter((p) => p.pos === pos && p.points !== null)
      .sort((a, b) => b.points - a.points);
    const idx = Math.max(0, Math.min(pool.length - 1, Math.round(base[pos] * teams) - 1));
    replacement[pos] = pool.length ? pool[idx].points : 0;
  }
  for (const p of S.rankings) {
    p.vor = p.points === null ? null : Math.round((p.points - (replacement[p.pos] || 0)) * 10) / 10;
  }
  const ranked = S.rankings.filter((p) => p.vor !== null).sort((a, b) => b.vor - a.vor);
  ranked.forEach((p, i) => { p.vorRank = i + 1; });
  S.rankings.filter((p) => p.vor === null).forEach((p) => { p.vorRank = ranked.length + 1; });
  S.replacement = replacement;
  S.starterBase = base;
  // Value the board is expected to offer at each successive pick: if picks went
  // in value order, the player still on the board at pick N is the Nth best.
  S.vorCurve = ranked.map((p) => p.vor);
}

/** What a pick is worth, in projected points over replacement. */
function expectedVorAtPick(pickNo) {
  const curve = S.vorCurve || [];
  if (!curve.length) return 0;
  return curve[Math.min(curve.length - 1, Math.max(0, pickNo - 1))];
}

function rankingFor(playerId) {
  const name = playerName(playerId);
  return S.byKey.get(normName(name)) || null;
}

/** Turn an overall pick number into the round it falls in. */
function roundOfPick(pick) {
  if (!pick) return null;
  // Anything past the last round is simply "goes undrafted"; capping keeps a
  // deep sleeper from showing a fake 6-round bargain.
  return Math.min(roundCount() + 1, Math.ceil(pick / teamCount()));
}

/**
 * The round the projections say he belongs in: rank everyone by points over
 * replacement and deal them out in order. This is the number the keeper
 * decision turns on — where he is *worth* taking, not where the room takes him.
 */
function projRound(rank) {
  return rank ? roundOfPick(rank.vorRank) : null;
}

/** Where the market actually takes him, for comparison. Not every player has one. */
function adpRound(rank) {
  return rank && rank.adpPick ? roundOfPick(rank.adpPick) : null;
}

/** Rounds past the end of the draft just mean "nobody takes him". */
function marketLabel(round) {
  if (round === null || round === undefined) return 'n/a';
  return round > roundCount() ? 'undrafted' : ordinal(round);
}

/* --------------------------------------------------------- keeper engine */

/**
 * League keeper rules:
 *   - up to 3 keepers per team
 *   - a player may be kept at most 2 years running; the clock follows the
 *     player, not the manager, so a player kept by two different owners in
 *     back-to-back years is done
 *   - cost is one round earlier than the round he went in last year;
 *     1st-rounders stay 1st, undrafted players cost a 14th
 *   - only players on a roster at season's end are eligible
 */
function buildKeepers() {
  const rounds = roundCount();
  const undraftedCost = Math.min(14, rounds);
  const keepers = new Map();

  // Index every prior draft by player_id, newest season first.
  const seasons = S.history.map((h) => {
    const byPlayer = new Map();
    for (const pick of h.picks) {
      if (pick.player_id) byPlayer.set(String(pick.player_id), pick);
    }
    return { season: h.season, byPlayer };
  });

  const slotOfRoster = rosterToSlot();
  const rostered = new Map(); // player_id -> roster_id
  for (const r of S.rosters) {
    for (const pid of (r.players || [])) rostered.set(String(pid), r.roster_id);
  }

  for (const [pid, rosterId] of rostered.entries()) {
    // Consecutive seasons, ending with the most recent, that he was kept.
    let yearsUsed = 0;
    for (const s of seasons) {
      const pick = s.byPlayer.get(pid);
      if (pick && pick.is_keeper) yearsUsed += 1;
      else break;
    }

    const last = seasons.length ? seasons[0].byPlayer.get(pid) : null;
    const lastRound = last ? Number(last.round) : null;
    let cost;
    if (!lastRound) cost = undraftedCost;              // undrafted / waiver add
    else if (lastRound === 1) cost = 1;                 // 1st-rounders hold at 1
    else cost = Math.max(1, lastRound - 1);             // one round more expensive

    const override = S.overrides[pid] || {};
    if (override.cost) cost = Number(override.cost);
    if (override.years !== undefined && override.years !== null) yearsUsed = Number(override.years);

    const rank = rankingFor(pid);
    const proj = projRound(rank);
    // Rounds saved is how managers talk, but it lies about deep players: a
    // 2nd-round keeper who would go undrafted still shows "+13 rounds". Score
    // him instead on what the pick he burns would otherwise have bought.
    const slot = slotOfRoster[rosterId] || Math.ceil(teamCount() / 2);
    const gain = (rank && rank.vor !== null && rank.vor !== undefined)
      ? Math.round((rank.vor - expectedVorAtPick(pickNumber(cost, slot))) * 10) / 10
      : null;
    keepers.set(pid, {
      playerId: pid,
      rosterId,
      name: playerName(pid),
      pos: playerPos(pid),
      team: playerTeam(pid),
      rank,
      cost,
      yearsUsed,
      eligible: yearsUsed < 2,
      lastRound,
      lastSeason: seasons.length ? seasons[0].season : null,
      undrafted: !lastRound,
      projRound: proj,
      adpRound: adpRound(rank),
      // Rounds of value: what you pay, minus where the projections say he goes.
      surplus: proj === null ? null : cost - proj,
      costPick: pickNumber(cost, slot),
      gain: gain,
      overridden: !!(override.cost || override.years !== undefined),
    });
  }

  S.keepers = keepers;
}

function keepersForRoster(rosterId, eligibleOnly) {
  const out = [];
  for (const k of S.keepers.values()) {
    if (k.rosterId !== rosterId) continue;
    if (eligibleOnly && !k.eligible) continue;
    out.push(k);
  }
  return out.sort((a, b) => {
    const ga = a.gain === null ? -9999 : a.gain;
    const gb = b.gain === null ? -9999 : b.gain;
    if (gb !== ga) return gb - ga;
    return (a.rank ? a.rank.vorRank : 9999) - (b.rank ? b.rank.vorRank : 9999);
  });
}

const MAX_KEEPERS = 3;

/**
 * Keepers the league has actually locked in. Sleeper stores them in two places
 * depending on how the commissioner set them up: on each roster as a list of
 * player ids, and/or as draft picks already flagged is_keeper. Read both.
 */
function actualKeepersByRoster() {
  const byRoster = new Map();
  const add = (rosterId, playerId) => {
    const rid = Number(rosterId);
    const pid = String(playerId);
    if (!rid || !playerId) return;
    if (!byRoster.has(rid)) byRoster.set(rid, new Set());
    byRoster.get(rid).add(pid);
  };
  for (const r of S.rosters) {
    for (const pid of (r.keepers || [])) add(r.roster_id, pid);
  }
  for (const p of S.picks) {
    if (p.is_keeper && p.player_id) add(p.roster_id, p.player_id);
  }
  return byRoster;
}

/** Switch the board back to the league's real keepers. */
function applyActualKeepers() {
  S.predicted = new Set();
  S.unmatchedKeepers = [];
  for (const pid of S.actualKeepers) {
    if (S.keepers.has(pid)) S.predicted.add(pid);
    else S.unmatchedKeepers.push(playerName(pid));
  }
  S.keeperMode = 'actual';
  persistPredicted();
}

/**
 * Card order for display. Cards show the rounds badge, so lead with rounds and
 * break ties on points. Auto-predict deliberately does not use this — it picks
 * on points, which does not mistake a deep sleeper at a 14th for a bargain.
 */
function displayOrder(list) {
  return list.slice().sort((a, b) =>
    // Whoever is actually being kept sits at the top; the rest rank by value.
    ((S.predicted.has(b.playerId) ? 1 : 0) - (S.predicted.has(a.playerId) ? 1 : 0))
    || ((b.surplus === null ? -99 : b.surplus) - (a.surplus === null ? -99 : a.surplus))
    || ((b.gain === null ? -9999 : b.gain) - (a.gain === null ? -9999 : a.gain)));
}

/** Default prediction: every team keeps its three biggest bargains. */
function autoPredict() {
  const picked = new Set();
  const capacity = pickCapacity();
  for (const r of S.rosters) {
    const owned = capacity.get(r.roster_id) || new Map();
    const used = new Map();
    const eligible = keepersForRoster(r.roster_id, true)
      // A keeper is only worth a slot if he beats what that pick would buy.
      .filter((k) => k.gain !== null && k.gain > 0);
    let taken = 0;
    for (const k of eligible) {
      if (taken >= MAX_KEEPERS) break;
      // Since he cannot slide, skip anyone whose round is already spoken for
      // and move on to the next-best keeper the team can actually pay for.
      if ((owned.get(k.cost) || 0) - (used.get(k.cost) || 0) <= 0) continue;
      used.set(k.cost, (used.get(k.cost) || 0) + 1);
      picked.add(k.playerId);
      taken += 1;
    }
  }
  S.predicted = picked;
  persistPredicted();
}

/** No team may carry more than the league allows; drop its weakest guesses. */
function enforceKeeperCap() {
  for (const r of S.rosters) {
    const list = predictedForRoster(r.roster_id);
    if (list.length <= MAX_KEEPERS) continue;
    const ranked = list.slice().sort((a, b) => (b.gain === null ? -9999 : b.gain) - (a.gain === null ? -9999 : a.gain));
    for (const k of ranked.slice(MAX_KEEPERS)) S.predicted.delete(k.playerId);
  }
}

function persistPredicted() {
  lsSet(LS.predicted, Array.from(S.predicted));
}

function predictedForRoster(rosterId) {
  const out = [];
  for (const pid of S.predicted) {
    const k = S.keepers.get(pid);
    if (k && k.rosterId === rosterId) out.push(k);
  }
  return out.sort((a, b) => a.cost - b.cost);
}

/**
 * Place predicted keepers onto the board. Two keepers on the same team who
 * cost the same round collide, so the cheaper-valued one slides to the next
 * open earlier round (and, failing that, to the next open later round).
 */
/**
 * How many picks each roster actually holds in each round, after trades.
 * Every roster starts with one pick per round at its own slot; a trade moves
 * that pick's ownership, so a team can hold two picks in a round and none in
 * another. Returns rosterId -> Map(round -> count).
 */
function pickCapacity() {
  const rounds = roundCount();
  const owners = pickOwnerMap();
  const cap = new Map();
  const slots = rosterToSlot();
  for (const r of S.rosters) {
    if (!slots[r.roster_id]) continue;
    for (let round = 1; round <= rounds; round += 1) {
      const owner = owners.get(round + ':' + r.roster_id) || r.roster_id;
      if (!cap.has(owner)) cap.set(owner, new Map());
      const m = cap.get(owner);
      m.set(round, (m.get(round) || 0) + 1);
    }
  }
  return cap;
}

/**
 * A keeper is paid for with a pick in his exact cost round — he never slides to
 * another round. If the team has no pick left there, he simply cannot be kept,
 * and the manager has to give one of them up.
 */
/** What is already on the draft board: player -> round, and picks spent per team. */
function placedPicks() {
  const byPlayer = new Map();
  const spent = new Map();
  for (const p of S.picks) {
    if (!p.player_id) continue;
    const round = Number(p.round);
    byPlayer.set(String(p.player_id), round);
    const rid = Number(p.roster_id);
    if (!spent.has(rid)) spent.set(rid, new Map());
    const m = spent.get(rid);
    m.set(round, (m.get(round) || 0) + 1);
  }
  return { byPlayer, spent };
}

function assignKeeperRounds() {
  const assignments = new Map(); // playerId -> {round, onBoard}
  const blocked = [];
  const mismatched = [];
  const capacity = pickCapacity();
  const { byPlayer: placed, spent } = placedPicks();

  for (const r of S.rosters) {
    // Count picks per round: a team holding two picks in a round can pay for
    // two keepers out of it, and a team that traded its pick away pays none.
    const owned = capacity.get(r.roster_id) || new Map();
    // Picks already on the board are spent and cannot pay for anything else.
    const used = new Map(spent.get(r.roster_id) || []);
    const list = predictedForRoster(r.roster_id)
      .slice()
      .sort((a, b) => (a.cost - b.cost) || ((b.gain || 0) - (a.gain || 0)));
    for (const k of list) {
      // Your league has already put him on the board. That placement is the
      // truth — this tool does not get to place him a second time.
      const at = placed.get(k.playerId);
      if (at !== undefined) {
        assignments.set(k.playerId, { round: at, onBoard: true });
        if (at !== k.cost) {
          mismatched.push({ team: teamName(r.roster_id), name: k.name, league: at, derived: k.cost });
        }
        continue;
      }
      const round = k.cost;
      const held = owned.get(round) || 0;
      if (held - (used.get(round) || 0) <= 0) {
        blocked.push({
          team: teamName(r.roster_id),
          name: k.name,
          round,
          reason: held === 0 ? 'no pick in that round' : 'that pick is already paying for another keeper',
        });
        continue;
      }
      used.set(round, (used.get(round) || 0) + 1);
      assignments.set(k.playerId, { round });
    }
  }
  return { assignments, blocked, mismatched };
}

/* ------------------------------------------------------------- board model */

function actualPickMap() {
  const map = new Map();
  for (const p of S.picks) {
    if (p.pick_no) map.set(Number(p.pick_no), p);
  }
  return map;
}

function draftedKeys() {
  const keys = new Set();
  for (const p of S.picks) {
    if (!p.player_id) continue;
    keys.add(normName(playerName(String(p.player_id))));
  }
  return keys;
}

function projectionScore(p) {
  const teams = teamCount();
  if (p.adpPick) return p.adpPick;
  return Math.max(p.vorRank || 999, teams * 14);
}

/**
 * Full board: real picks where they exist, predicted keepers on top of the
 * rounds they consume, and (optionally) an ADP-driven guess at who is left
 * for every pick still open.
 */
function buildBoard(opts) {
  const teams = teamCount();
  const rounds = roundCount();
  const actual = actualPickMap();
  const { assignments, blocked, mismatched } = opts.useKeepers
    ? assignKeeperRounds()
    : { assignments: new Map(), blocked: [], mismatched: [] };

  // "ownerRosterId:round" -> keepers waiting to be placed on a pick that team
  // actually holds. A team that traded its 5th away cannot pay a 5th for a
  // keeper, so these are consumed against real owned picks rather than slots.
  const keeperQueue = new Map();
  for (const [pid, info] of assignments.entries()) {
    if (info.onBoard) continue; // already drawn from the real pick
    const k = S.keepers.get(pid);
    if (!k) continue;
    const key = k.rosterId + ':' + info.round;
    if (!keeperQueue.has(key)) keeperQueue.set(key, []);
    keeperQueue.get(key).push(Object.assign({}, k));
  }

  const taken = draftedKeys();
  for (const [pid] of assignments.entries()) taken.add(normName(playerName(pid)));

  const pool = S.rankings
    .filter((p) => !taken.has(p.key))
    .sort((a, b) => projectionScore(a) - projectionScore(b));
  let poolIdx = 0;

  const s2r = slotToRoster();
  const owners = pickOwnerMap();
  const cells = [];
  for (let round = 1; round <= rounds; round += 1) {
    const row = [];
    for (let slot = 1; slot <= teams; slot += 1) {
      const pickNo = pickNumber(round, slot);
      const fromRosterId = s2r[slot] || null;
      const tradedTo = fromRosterId ? owners.get(round + ':' + fromRosterId) : null;
      const rosterId = tradedTo || fromRosterId;
      const traded = !!(tradedTo && tradedTo !== fromRosterId);
      const base = { pickNo, round, slot, rosterId, fromRosterId, traded };
      const real = actual.get(pickNo);
      let cell = Object.assign({}, base, { kind: 'empty' });
      if (real && real.player_id) {
        const pid = String(real.player_id);
        // A completed pick records who actually made it, trades included.
        const madeBy = Number(real.roster_id) || rosterId;
        cell = Object.assign({}, base, {
          rosterId: madeBy,
          traded: !!(fromRosterId && madeBy !== fromRosterId),
          kind: 'pick',
          name: playerName(pid),
          pos: playerPos(pid),
          nflTeam: playerTeam(pid),
          isKeeper: !!real.is_keeper,
          rank: rankingFor(pid),
        });
      } else {
        const queued = rosterId ? keeperQueue.get(rosterId + ':' + round) : null;
        if (queued && queued.length) {
          const k = queued.shift();
          cell = Object.assign({}, base, {
            kind: 'keeper',
            name: k.name, pos: k.pos, nflTeam: k.team,
            cost: k.cost, rank: k.rank,
          });
        } else if (opts.project) {
          const next = pool[poolIdx];
          poolIdx += 1;
          if (next) {
            cell = Object.assign({}, base, {
              kind: 'proj',
              name: next.name, pos: next.pos, nflTeam: next.team, rank: next,
            });
          }
        }
      }
      row.push(cell);
    }
    cells.push(row);
  }

  // Anything still queued wanted a round its team no longer holds a pick in.
  const orphans = [];
  for (const [key, list] of keeperQueue.entries()) {
    for (const k of list) {
      orphans.push({ team: teamName(k.rosterId), name: k.name, round: Number(key.split(':')[1]) });
    }
  }
  return { cells, blocked, mismatched, assignments, orphans };
}

function onTheClock() {
  const made = S.picks.filter((p) => p.player_id).length;
  if (!S.draft || S.draft.status !== 'drafting') return null;
  return made + 1;
}

/** One line telling you whether the board is showing real keepers or a guess. */
function keeperSourceNotice() {
  if (S.keeperMode === 'actual') {
    return el('div', { class: 'notice ok' }, [
      el('strong', { text: 'Keepers are set. ' }),
      S.predicted.size + ' keeper' + (S.predicted.size === 1 ? '' : 's') + ' across '
      + S.keeperTeamCount + ' teams, read from your league — not predicted.'
      + (S.unmatchedKeepers.length
        ? ' ' + S.unmatchedKeepers.length + ' could not be matched to a player: ' + S.unmatchedKeepers.join(', ') + '.'
        : ''),
    ]);
  }
  if (S.actualKeepers.size) {
    return el('div', { class: 'notice' }, [
      el('strong', { text: 'What-if set, not your real keepers. ' }),
      'Your league has keepers set; you are looking at an edited set. ',
      el('button', {
        class: 'btn small', text: 'Reset to actual keepers',
        onclick: () => { applyActualKeepers(); renderActive(); },
      }),
    ]);
  }
  return el('div', { class: 'notice' }, [
    el('strong', { text: 'Predicted keepers. ' }),
    'Your league has not set keepers in Sleeper yet, so these are this tool\'s best guess.',
  ]);
}

/* -------------------------------------------------------------- rendering */

function posChip(pos) {
  return el('span', { class: 'pos ' + pos, text: pos || '—' });
}

function renderBoard() {
  const host = $('#boardHost');
  host.replaceChildren();
  if (!S.draft) {
    host.appendChild(el('div', { class: 'notice err', text: 'No draft found on this league yet.' }));
    return;
  }
  const useKeepers = $('#optKeepers').checked;
  const project = $('#optProject').checked;
  const { cells, blocked, mismatched, orphans } = buildBoard({ useKeepers, project });
  const s2r = slotToRoster();
  const clock = onTheClock();

  if (useKeepers) host.appendChild(keeperSourceNotice());

  if (mismatched && mismatched.length) {
    host.appendChild(el('div', { class: 'notice' }, [
      el('strong', { text: 'Keeper cost differs from what your league charged: ' }),
      mismatched.map((m) => m.name + ' (' + m.team + ') — league ' + ordinal(m.league)
        + ', this tool worked out ' + ordinal(m.derived)).join('; ')
        + '. The board shows your league\'s round, which is the real one. The Keepers tab '
        + 'cost and value columns are using the derived round, so correct them in the override editor.',
    ]));
  }

  if (blocked.length) {
    host.appendChild(el('div', { class: 'notice err' }, [
      el('strong', { text: 'Cannot be kept: ' }),
      blocked.map((c) => c.team + ' — ' + c.name + ' (' + ordinal(c.round) + ', ' + c.reason + ')').join('; ')
        + '. A keeper has to be paid for in his exact cost round, so these are not on the board. '
        + (S.keeperMode === 'actual'
          ? 'Your league did set them, so the cost this tool worked out is probably wrong — check it '
            + 'against the prior draft and correct it in the override editor on the Keepers tab.'
          : 'Drop one of the clashing keepers on the Keeper Sim tab.'),
    ]));
  }

  if (orphans && orphans.length) {
    host.appendChild(el('div', { class: 'notice' }, [
      el('strong', { text: 'Keeper has no pick to pay with: ' }),
      orphans.map((o) => o.team + ' — ' + o.name + ' needs a ' + ordinal(o.round)).join('; ')
        + '. That round was traded away, so the keeper could not be placed.',
    ]));
  }

  const tradedCount = cells.reduce((n, row) => n + row.filter((c) => c.traded).length, 0);

  const head = el('tr', {}, [el('th', { class: 'rnd', text: 'R' })]);
  for (let slot = 1; slot <= teamCount(); slot += 1) {
    const rid = s2r[slot];
    head.appendChild(el('th', { class: rid && rid === S.myRosterId ? 'is-mine' : '' }, [
      el('div', { text: rid ? teamName(rid) : 'Slot ' + slot }),
      el('div', { class: 'dim num', style: 'font-weight:400', text: 'slot ' + slot }),
    ]));
  }

  const body = el('tbody');
  for (const row of cells) {
    const tr = el('tr', {}, [el('td', { class: 'rnd', text: row[0].round })]);
    for (const cell of row) {
      const classes = [];
      if (cell.kind === 'keeper') classes.push('is-keeper');
      if (cell.kind === 'proj') classes.push('is-proj');
      if (cell.rosterId && cell.rosterId === S.myRosterId) classes.push('is-mine');
      if (clock && cell.pickNo === clock) classes.push('on-clock');

      if (cell.traded) classes.push('is-traded');

      const ownerTag = cell.traded && cell.rosterId
        ? el('span', { class: 'owner', title: 'traded from ' + teamName(cell.fromRosterId), text: '→ ' + teamName(cell.rosterId) })
        : null;

      let inner;
      if (cell.kind === 'empty') {
        inner = el('div', { class: 'cell-pick' }, [
          el('span', { class: 'cell-empty', text: '#' + cell.pickNo }),
          ownerTag,
        ]);
      } else {
        inner = el('div', { class: 'cell-pick' }, [
          el('span', { class: 'pn', text: '#' + cell.pickNo + (cell.kind === 'keeper' ? ' · KEEPER' : (cell.isKeeper ? ' · KEEPER' : '')) }),
          el('span', { class: 'nm' + (cell.kind === 'proj' ? ' proj' : ''), text: cell.name }),
          el('span', { class: 'mt' }, [posChip(cell.pos), ' ' + (cell.nflTeam || '')]),
          ownerTag,
        ]);
        if (cell.rank) {
          inner.style.cursor = 'pointer';
          inner.addEventListener('click', () => showPlayer(cell.rank));
        }
      }
      tr.appendChild(el('td', { class: classes.join(' ') }, [inner]));
    }
    body.appendChild(tr);
  }

  host.appendChild(el('div', { class: 'legend' }, [
    el('span', {}, [el('i', { style: 'background:rgba(188,140,255,.5)' }),
      S.keeperMode === 'actual' ? 'keeper' : 'predicted keeper']),
    el('span', {}, [el('i', { style: 'background:rgba(88,166,255,.5)' }), 'your team']),
    el('span', {}, [el('i', { style: 'background:rgba(63,185,80,.5)' }), 'on the clock']),
    el('span', {}, [el('i', { style: 'background:rgba(210,153,34,.4)' }), 'projected (ADP)']),
    tradedCount
      ? el('span', {}, [el('i', { style: 'background:rgba(248,81,73,.45)' }), tradedCount + ' traded — arrow names who owns it now'])
      : el('span', { class: 'dim', text: 'no picks traded' }),
  ]));
  host.appendChild(el('div', { class: 'board-scroll' }, [
    el('table', { class: 'board' }, [el('thead', {}, [head]), body]),
  ]));

  const made = S.picks.filter((p) => p.player_id).length;
  $('#boardMeta').textContent = S.draft.status === 'complete'
    ? 'Draft complete — ' + made + ' picks.'
    : (S.draft.status === 'drafting'
      ? 'Live: ' + made + ' picks in, #' + (made + 1) + ' on the clock.'
      : 'Pre-draft — ' + roundCount() + ' rounds, ' + teamCount() + ' teams, draft order set.');
}

/* ------------------------------------------------------ available players */

const availState = { sort: 'vorRank', dir: 1, pos: 'ALL', q: '', hideKeepers: true };

function availableRows() {
  const gone = draftedKeys();
  if (availState.hideKeepers) {
    for (const pid of S.predicted) gone.add(normName(playerName(pid)));
  }
  let rows = S.rankings.filter((p) => !gone.has(p.key));
  if (availState.pos !== 'ALL') rows = rows.filter((p) => p.pos === availState.pos);
  if (availState.q) {
    const q = availState.q.toLowerCase();
    rows = rows.filter((p) => p.name.toLowerCase().includes(q) || (p.team || '').toLowerCase().includes(q));
  }
  const key = availState.sort;
  rows.sort((a, b) => {
    const av = a[key], bv = b[key];
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    if (av === bv) return (a.vorRank || 0) - (b.vorRank || 0);
    return av > bv ? availState.dir : -availState.dir;
  });
  return rows;
}

const AVAIL_COLS = [
  { key: 'vorRank', label: '#', dir: 1, cls: 'num right' },
  { key: 'name', label: 'Player', dir: 1, cls: 'name' },
  { key: 'pos', label: 'Pos', dir: 1 },
  { key: 'team', label: 'Tm', dir: 1 },
  { key: 'bye', label: 'Bye', dir: 1, cls: 'num right' },
  { key: 'tier', label: 'Tier', dir: 1, cls: 'right' },
  { key: 'posRank', label: 'PosRk', dir: 1, cls: 'num right' },
  { key: 'points', label: 'Proj', dir: -1, cls: 'num right' },
  { key: 'vor', label: 'VOR', dir: -1, cls: 'num right' },
  { key: 'adpPick', label: 'ADP', dir: 1, cls: 'num right' },
  { key: 'risk', label: 'Risk', dir: 1, cls: 'num right' },
  { key: 'upside', label: 'Upside', dir: -1, cls: 'num right' },
];

function renderAvailable() {
  const host = $('#availHost');
  host.replaceChildren();
  const rows = availableRows();
  $('#availMeta').textContent = rows.length + ' players available'
    + (availState.hideKeepers
      ? (S.keeperMode === 'actual' ? ' (keepers removed)' : ' (predicted keepers removed)')
      : '');

  const head = el('tr');
  for (const col of AVAIL_COLS) {
    const active = availState.sort === col.key;
    head.appendChild(el('th', {
      class: 'sortable ' + (col.cls && col.cls.includes('right') ? 'right' : ''),
      text: col.label + (active ? (availState.dir === 1 ? ' ▲' : ' ▼') : ''),
      onclick: () => {
        if (availState.sort === col.key) availState.dir = -availState.dir;
        else { availState.sort = col.key; availState.dir = col.dir; }
        renderAvailable();
      },
    }));
  }

  const body = el('tbody');
  let lastTier = null;
  for (const p of rows.slice(0, 400)) {
    const tierBreak = availState.sort === 'vorRank' && availState.pos !== 'ALL'
      && lastTier !== null && p.tier !== lastTier;
    lastTier = p.tier;
    const tr = el('tr', { class: tierBreak ? 'tier-break' : '', onclick: () => showPlayer(p) });
    tr.style.cursor = 'pointer';
    tr.appendChild(el('td', { class: 'num right dim', text: p.vorRank }));
    tr.appendChild(el('td', { class: 'name', text: p.name }));
    tr.appendChild(el('td', {}, [posChip(p.pos)]));
    tr.appendChild(el('td', { class: 'muted', text: p.team || '—' }));
    tr.appendChild(el('td', { class: 'num right muted', text: p.bye || '—' }));
    tr.appendChild(el('td', { class: 'right' }, [el('span', { class: 'tier-chip', text: 'T' + (p.tier || '?') })]));
    tr.appendChild(el('td', { class: 'num right muted', text: p.pos + (p.posRank || '') }));
    tr.appendChild(el('td', { class: 'num right', text: fmt(p.points) }));
    tr.appendChild(el('td', { class: 'num right ' + (p.vor > 0 ? 'good' : 'dim'), text: fmt(p.vor) }));
    tr.appendChild(el('td', { class: 'num right muted', text: p.adp || '—' }));
    tr.appendChild(el('td', { class: 'num right muted', text: fmt(p.risk) }));
    tr.appendChild(el('td', { class: 'num right muted', text: fmt(p.upside) }));
    body.appendChild(tr);
  }
  host.appendChild(el('div', { class: 'table-wrap' }, [el('table', {}, [el('thead', {}, [head]), body])]));
  if (rows.length > 400) {
    host.appendChild(el('p', { class: 'sub', text: 'Showing the top 400 of ' + rows.length + '. Filter to narrow.' }));
  }
}

/* ---------------------------------------------------------- player detail */

function showPlayer(p) {
  if (!p) return;
  const k = Array.from(S.keepers.values()).find((x) => x.rank === p);
  const close = () => backdrop.remove();
  const backdrop = el('div', { class: 'player-modal-backdrop', onclick: (e) => { if (e.target === backdrop) close(); } }, [
    el('div', { class: 'player-modal' }, [
      el('h3', { text: p.name }),
      el('p', { class: 'sub' }, [
        posChip(p.pos), ' · ' + (p.team || 'FA') + ' · Bye ' + (p.bye || '—')
        + ' · ' + p.pos + (p.posRank || '') + ' · Tier ' + (p.tier || '?'),
      ]),
      el('dl', { class: 'kv' }, [
        el('dt', { text: 'Projected points' }), el('dd', { text: fmt(p.points) }),
        el('dt', { text: 'Value over replacement' }), el('dd', { text: fmt(p.vor) + '  (overall #' + p.vorRank + ')' }),
        el('dt', { text: 'ADP' }), el('dd', { text: p.adp ? p.adp + '  (pick ' + p.adpPick + ')' : 'undrafted' }),
        el('dt', { text: 'Risk / Upside' }), el('dd', { text: fmt(p.risk) + ' / ' + fmt(p.upside) }),
        k ? el('dt', { text: 'Keeper' }) : null,
        k ? el('dd', {
          text: teamName(k.rosterId) + ' · projects ' + marketLabel(k.projRound)
            + ', costs ' + ordinal(k.cost)
            + (k.surplus === null ? '' : ' · ' + signed(k.surplus) + ' rd')
            + (k.gain === null ? '' : ' / ' + (k.gain > 0 ? '+' : '') + fmt(k.gain, 0) + ' pts')
            + (k.eligible ? '' : ' · INELIGIBLE (kept ' + k.yearsUsed + 'y)'),
        }) : null,
      ]),
      p.outlook ? el('h4', { text: '2026 outlook' }) : null,
      p.outlook ? el('p', { text: p.outlook }) : null,
      p.dynasty ? el('h4', { text: 'Dynasty' }) : null,
      p.dynasty ? el('p', { text: p.dynasty }) : null,
      el('div', { class: 'row', style: 'margin-top:14px' }, [
        el('button', { class: 'btn', text: 'Close', onclick: close }),
      ]),
    ]),
  ]);
  document.body.appendChild(backdrop);
}

/* ----------------------------------------------------------- keepers view */

let keeperSort = 'rounds';

function renderKeepers() {
  const host = $('#keeperHost');
  host.replaceChildren();
  host.appendChild(keeperSourceNotice());

  if (!S.history.length) {
    host.appendChild(el('div', { class: 'notice' }, [
      el('strong', { text: 'No prior-season draft found. ' }),
      'Sleeper had no linked previous league, so every rostered player is being '
      + 'treated as undrafted (a ' + Math.min(14, roundCount()) + 'th-round keeper). '
      + 'Use the override editor below to set real costs.',
    ]));
  } else {
    host.appendChild(el('div', { class: 'notice ok' }, [
      el('strong', { text: 'Keeper costs derived from ' }),
      S.history.map((h) => h.season + ' (' + h.picks.filter((p) => p.player_id).length + ' picks'
        + (h.picks.some((p) => p.is_keeper) ? ', ' + h.picks.filter((p) => p.is_keeper).length + ' flagged keepers' : ', no keeper flags') + ')')
        .join(' · '),
    ]));
  }

  // ---- best values league-wide
  const byRounds = (a, b) => (b.surplus === null ? -99 : b.surplus) - (a.surplus === null ? -99 : a.surplus);
  const byPoints = (a, b) => b.gain - a.gain;
  const all = Array.from(S.keepers.values())
    .filter((k) => k.eligible && k.gain !== null)
    .sort((a, b) => (keeperSort === 'rounds' ? byRounds(a, b) || byPoints(a, b) : byPoints(a, b) || byRounds(a, b))
      || (a.rank ? a.rank.vorRank : 999) - (b.rank ? b.rank.vorRank : 999));

  const valueBody = el('tbody');
  for (const k of all.slice(0, 40)) {
    const tr = el('tr', { onclick: () => showPlayer(k.rank) });
    tr.style.cursor = 'pointer';
    tr.appendChild(el('td', { class: 'name', text: k.name }));
    tr.appendChild(el('td', {}, [posChip(k.pos)]));
    tr.appendChild(el('td', { class: 'muted', text: k.team || '—' }));
    tr.appendChild(el('td', { class: 'muted', text: teamName(k.rosterId) }));
    tr.appendChild(el('td', {
      class: 'num right', title: k.rank ? 'projected #' + k.rank.vorRank + ' overall' : '',
      text: marketLabel(k.projRound),
    }));
    tr.appendChild(el('td', {
      class: 'num right',
      title: k.undrafted ? 'undrafted last year' : 'went ' + ordinal(k.lastRound) + ' in ' + k.lastSeason,
      text: ordinal(k.cost),
    }));
    tr.appendChild(el('td', {
      class: 'right surplus ' + (k.surplus === null ? 'dim' : k.surplus > 2 ? 'good' : k.surplus > 0 ? 'warn' : 'bad'),
      text: k.surplus === null ? '—' : signed(k.surplus) + ' rd',
    }));
    tr.appendChild(el('td', {
      class: 'right surplus ' + (k.gain > 25 ? 'good' : k.gain > 0 ? 'warn' : 'bad'),
      text: (k.gain > 0 ? '+' : '') + fmt(k.gain, 0) + ' pts',
    }));
    tr.appendChild(el('td', { class: 'num right dim', text: marketLabel(k.adpRound) }));
    tr.appendChild(el('td', { class: 'num right muted', text: k.rank ? '#' + k.rank.vorRank : '—' }));
    tr.appendChild(el('td', { class: 'muted', text: k.yearsUsed === 0 ? 'yr 1 of 2' : 'yr 2 of 2 (last year)' }));
    valueBody.appendChild(tr);
  }

  host.appendChild(el('div', { class: 'card' }, [
    el('div', { class: 'row' }, [
      el('h2', { style: 'margin:0', text: 'Best keeper values in the league' }),
      el('span', { class: 'spacer' }),
      el('span', { class: 'sub', style: 'margin:0', text: 'sort by' }),
      el('button', {
        class: 'btn small' + (keeperSort === 'rounds' ? ' primary' : ''),
        text: 'rounds saved',
        onclick: () => { keeperSort = 'rounds'; lsSet(LS.keeperSort, keeperSort); renderKeepers(); },
      }),
      el('button', {
        class: 'btn small' + (keeperSort === 'points' ? ' primary' : ''),
        text: 'points gained',
        onclick: () => { keeperSort = 'points'; lsSet(LS.keeperSort, keeperSort); renderKeepers(); },
      }),
    ]),
    el('p', { class: 'sub', style: 'margin-top:8px' , text: 'Proj Rd is where the projections say he belongs — every player '
      + 'ranked by points over replacement, dealt out ' + teamCount() + ' to a round. Cost is the round keeping him burns. '
      + 'Rounds is the gap between them: +4 means you get a 4th-round-caliber player for the price of an 8th. Points is the '
      + 'same question in scoring terms — his value minus what that pick would have returned anyway — and it is the safer '
      + 'tiebreak, because a deep sleeper can show a fat round surplus at a 14th and still be worth almost nothing.' }),
    el('div', { class: 'table-wrap' }, [
      el('table', {}, [
        el('thead', {}, [el('tr', {}, [
          el('th', { text: 'Player' }), el('th', { text: 'Pos' }), el('th', { text: 'Tm' }),
          el('th', { text: 'Fantasy team' }),
          el('th', { class: 'right', text: 'Proj Rd' }), el('th', { class: 'right', text: 'Cost' }),
          el('th', { class: 'right', text: 'Rounds' }), el('th', { class: 'right', text: 'Points' }),
          el('th', { class: 'right', text: 'ADP Rd' }), el('th', { class: 'right', text: 'Board' }),
          el('th', { text: 'Keeper yr' }),
        ])]),
        valueBody,
      ]),
    ]),
  ]));

  // ---- per team
  const cards = el('div', { class: 'grid-cards' });
  for (const r of S.rosters.slice().sort((a, b) => teamName(a.roster_id).localeCompare(teamName(b.roster_id)))) {
    const eligible = keepersForRoster(r.roster_id, false)
      .filter((k) => k.eligible || S.actualKeepers.has(k.playerId));
    const blocked = keepersForRoster(r.roster_id, false)
      .filter((k) => !k.eligible && !S.actualKeepers.has(k.playerId));
    const list = el('ul');
    for (const k of displayOrder(eligible)) {
      list.appendChild(el('li', {}, [
        el('div', { class: 'who' }, [
          el('span', { class: 'n', text: k.name }),
          el('span', { class: 'm' }, [
            posChip(k.pos), ' ' + (k.team || 'FA') + ' · projects ' + marketLabel(k.projRound)
            + ', costs ' + ordinal(k.cost)
            + ' · ' + (k.undrafted ? 'undrafted ' + (k.lastSeason || '') : 'went ' + ordinal(k.lastRound) + ' in ' + k.lastSeason)
            + (k.yearsUsed ? ' · final keeper year' : ''),
            S.actualKeepers.has(k.playerId)
              ? el('span', { class: 'good', style: 'font-weight:600', text: ' · KEPT' }) : null,
          ]),
        ]),
        el('span', {
          class: 'surplus ' + (k.surplus === null ? 'dim' : k.surplus > 2 ? 'good' : k.surplus > 0 ? 'warn' : 'bad'),
          text: k.surplus === null ? '—' : signed(k.surplus) + ' rd',
          title: k.gain === null ? '' : 'worth ' + (k.gain > 0 ? '+' : '') + fmt(k.gain, 0)
            + ' projected points over what this pick would otherwise buy',
        }),
      ]));
    }
    if (!eligible.length) list.appendChild(el('li', { class: 'empty', text: 'No eligible keepers.' }));
    if (blocked.length) {
      list.appendChild(el('li', { class: 'empty', text: 'Burned (2 years used): ' + blocked.map((k) => k.name).join(', ') }));
    }
    cards.appendChild(el('div', { class: 'team-card' }, [
      el('header', {}, [
        el('span', { class: 'tn', text: teamName(r.roster_id) }),
        el('span', { class: 'cnt', text: eligible.length + ' eligible' }),
      ]),
      list,
    ]));
  }
  host.appendChild(el('div', { class: 'card' }, [
    el('h2', { text: 'Every player available to be kept, by team' }),
    el('p', { class: 'sub', text: 'Eligibility = on the end-of-season roster and not already kept two years running. '
      + 'The keeper clock follows the player, so a guy kept by two different managers back-to-back is out.' }),
    cards,
  ]));

  host.appendChild(renderOverrideEditor());
}

function renderOverrideEditor() {
  const rows = Array.from(S.keepers.values()).sort((a, b) => a.name.localeCompare(b.name));
  const sel = el('select', { class: 'grow' }, [el('option', { value: '', text: '— pick a player —' })]
    .concat(rows.map((k) => el('option', {
      value: k.playerId,
      text: k.name + ' (' + teamName(k.rosterId) + ') — ' + ordinal(k.cost) + ', ' + k.yearsUsed + 'y used'
        + (k.overridden ? ' [overridden]' : ''),
    }))));
  const cost = el('input', { type: 'number', min: '1', max: String(roundCount()), placeholder: 'round', style: 'width:90px' });
  const years = el('select', {}, [
    el('option', { value: '', text: 'years kept…' }),
    el('option', { value: '0', text: '0 — fresh' }),
    el('option', { value: '1', text: '1 — one year left' }),
    el('option', { value: '2', text: '2 — burned' }),
  ]);

  return el('div', { class: 'card' }, [
    el('h2', { text: 'Overrides' }),
    el('p', { class: 'sub', text: 'Sleeper only knows a player was a keeper if the pick was flagged that way at the time. '
      + 'If your league did not flag them, correct the cost or the years-used here — overrides are saved in this browser.' }),
    el('div', { class: 'row' }, [
      sel, cost, years,
      el('button', {
        class: 'btn primary', text: 'Save override',
        onclick: () => {
          const pid = sel.value;
          if (!pid) return;
          const entry = S.overrides[pid] || {};
          if (cost.value) entry.cost = Number(cost.value);
          if (years.value !== '') entry.years = Number(years.value);
          S.overrides[pid] = entry;
          lsSet(LS.overrides, S.overrides);
          rebuild();
        },
      }),
      el('button', {
        class: 'btn', text: 'Clear all overrides',
        onclick: () => { S.overrides = {}; lsSet(LS.overrides, {}); rebuild(); },
      }),
    ]),
    Object.keys(S.overrides).length
      ? el('p', { class: 'sub', style: 'margin-top:10px' , text: Object.keys(S.overrides).length + ' override(s) active: '
          + Object.keys(S.overrides).map((pid) => playerName(pid)).join(', ') })
      : null,
  ]);
}

/* --------------------------------------------------------- keeper sim view */

function renderSim() {
  const host = $('#simHost');
  host.replaceChildren();

  const { assignments, blocked } = assignKeeperRounds();
  const totalKept = assignments.size;

  host.appendChild(keeperSourceNotice());
  host.appendChild(el('div', { class: 'card' }, [
    el('h2', { text: S.keeperMode === 'actual' ? 'Keepers' : 'Predict the keepers' }),
    el('p', { class: 'sub', text: S.keeperMode === 'actual'
      ? 'These are your league\'s real keepers, read from Sleeper. Tick and untick only to explore '
      + 'what-ifs — the board follows, and Reset puts the real set back.'
      : 'Auto-predict gives every team its three biggest bargains — the keepers a rational manager takes. '
      + 'Tick and untick to model what you think your league will actually do; the draft board updates to match.' }),
    el('div', { class: 'row' }, [
      S.actualKeepers.size
        ? el('button', {
          class: 'btn' + (S.keeperMode === 'actual' ? '' : ' primary'), text: 'Reset to actual keepers',
          onclick: () => { applyActualKeepers(); renderActive(); },
        })
        : null,
      el('button', { class: 'btn' + (S.actualKeepers.size ? '' : ' primary'), text: 'Auto-predict all teams', onclick: () => { autoPredict(); S.keeperMode = 'whatif'; renderActive(); } }),
      el('button', { class: 'btn', text: 'Clear all', onclick: () => { S.predicted.clear(); S.keeperMode = 'whatif'; persistPredicted(); renderActive(); } }),
      el('span', { class: 'spacer' }),
      el('span', { class: 'muted', text: totalKept + ' keepers across ' + S.rosters.length + ' teams · '
        + totalKept + ' of ' + (roundCount() * teamCount()) + ' picks consumed' }),
    ]),
    blocked.length ? el('p', { class: 'sub bad', style: 'margin-top:8px', text: 'Cannot be kept — a keeper must be paid '
      + 'for in his exact round: ' + blocked.map((c) => c.team + ' ' + c.name + ' (' + ordinal(c.round) + ')').join('; ')
      + (S.keeperMode === 'actual' ? '. The league set these, so check the cost in the override editor.'
        : '. Untick one of each clashing pair.') }) : null,
  ]));

  const cards = el('div', { class: 'grid-cards' });
  const r2s = rosterToSlot();
  const sorted = S.rosters.slice().sort((a, b) => (r2s[a.roster_id] || 99) - (r2s[b.roster_id] || 99));
  for (const r of sorted) {
    // Sleeper's word beats our inference: a player the league actually kept
    // stays on the list even if we worked out his keeper clock had run out.
    const eligible = keepersForRoster(r.roster_id, false)
      .filter((k) => k.eligible || S.actualKeepers.has(k.playerId));
    const chosen = predictedForRoster(r.roster_id);
    const list = el('ul');
    for (const k of displayOrder(eligible)) {
      const on = S.predicted.has(k.playerId);
      const assigned = assignments.get(k.playerId);
      const box = el('input', {
        type: 'checkbox', checked: on,
        onchange: (e) => {
          if (e.target.checked) {
            if (predictedForRoster(r.roster_id).length >= MAX_KEEPERS) {
              e.target.checked = false;
              return;
            }
            S.predicted.add(k.playerId);
          } else {
            S.predicted.delete(k.playerId);
          }
          S.keeperMode = 'whatif';
          persistPredicted();
          renderActive();
        },
      });
      list.appendChild(el('li', { class: on ? 'sel' : '' }, [
        box,
        el('div', { class: 'who' }, [
          el('span', { class: 'n', text: k.name }),
          el('span', { class: 'm' }, [
            posChip(k.pos), ' ' + (k.team || 'FA') + ' · projects ' + marketLabel(k.projRound)
            + ', costs ' + ordinal(k.cost),
            S.actualKeepers.has(k.playerId)
              ? el('span', { class: 'good', style: 'font-weight:600', text: ' · KEPT' }) : null,
            !k.eligible ? el('span', { class: 'warn', text: ' · we had him at 2 years used' }) : null,
            on && !assigned ? el('span', { class: 'bad', style: 'font-weight:600',
              text: ' · no ' + ordinal(k.cost) + ' left to pay with' }) : null,
          ]),
        ]),
        el('span', {
          class: 'surplus ' + (k.surplus === null ? 'dim' : k.surplus > 2 ? 'good' : k.surplus > 0 ? 'warn' : 'bad'),
          text: k.surplus === null ? '—' : signed(k.surplus) + ' rd',
          title: k.gain === null ? '' : 'worth ' + (k.gain > 0 ? '+' : '') + fmt(k.gain, 0)
            + ' projected points over what this pick would otherwise buy',
        }),
      ]));
    }
    if (!eligible.length) list.appendChild(el('li', { class: 'empty', text: 'No eligible keepers.' }));
    cards.appendChild(el('div', { class: 'team-card' }, [
      el('header', {}, [
        el('span', { class: 'tn', text: teamName(r.roster_id) }),
        el('span', { class: 'muted', style: 'font-size:11px', text: 'slot ' + (r2s[r.roster_id] || '?') }),
        el('span', { class: 'cnt', text: chosen.length + '/' + MAX_KEEPERS }),
      ]),
      list,
    ]));
  }
  host.appendChild(cards);

  // ---- what it does to your picks
  if (S.myRosterId) {
    const board = buildBoard({ useKeepers: true, project: true });
    const lines = [];
    let acquired = 0;
    for (let round = 1; round <= roundCount(); round += 1) {
      // Walk every pick you own this round, not just your own slot — a pick you
      // traded for is yours, and a round you spent on a keeper is gone.
      for (const cell of board.cells[round - 1]) {
        if (cell.rosterId !== S.myRosterId || cell.kind === 'keeper') continue;
        if (cell.traded) acquired += 1;
        lines.push(el('tr', {}, [
          el('td', { class: 'num right muted', text: ordinal(round) }),
          el('td', { class: 'num right muted', text: '#' + cell.pickNo }),
          el('td', { class: 'name', text: cell.kind === 'empty' ? '—' : cell.name }),
          el('td', {}, [cell.pos ? posChip(cell.pos) : '']),
          el('td', { class: 'muted', text: cell.traded ? 'from ' + teamName(cell.fromRosterId) : '' }),
          el('td', { class: 'muted', text: cell.rank ? 'ADP ' + (cell.rank.adp || '—') + ' · tier ' + (cell.rank.tier || '?') : '' }),
        ]));
      }
    }
    host.appendChild(el('div', { class: 'card' }, [
      el('h2', { text: 'Your board after keepers' }),
      el('p', { class: 'sub', text: lines.length + ' picks you own'
        + (acquired ? ', ' + acquired + ' of them traded for' : '')
        + '. Rounds you spend on keepers drop out. Everything left is who the ADP pool projects '
        + 'to still be there at your pick once every predicted keeper is off the table.' }),
      el('div', { class: 'table-wrap' }, [
        el('table', {}, [
          el('thead', {}, [el('tr', {}, [
            el('th', { class: 'right', text: 'Rd' }), el('th', { class: 'right', text: 'Pick' }),
            el('th', { text: 'Projected best available' }), el('th', { text: 'Pos' }),
            el('th', { text: 'Acquired' }), el('th', { text: '' }),
          ])]),
          el('tbody', {}, lines),
        ]),
      ]),
    ]));
  }
}

/* ---------------------------------------------------------- league view */

const SCORING_LABELS = {
  pass_yd: 'Passing yards', pass_td: 'Passing TD', pass_int: 'Interception', pass_2pt: 'Passing 2pt',
  rush_yd: 'Rushing yards', rush_td: 'Rushing TD', rush_2pt: 'Rushing 2pt',
  rec: 'Reception (PPR)', rec_yd: 'Receiving yards', rec_td: 'Receiving TD', rec_2pt: 'Receiving 2pt',
  fum_lost: 'Fumble lost', fum: 'Fumble', fum_rec_td: 'Fumble recovery TD',
  bonus_rec_te: 'TE reception bonus',
  xpm: 'Extra point made', xpmiss: 'Extra point miss',
  fgm: 'FG made', fgmiss: 'FG miss',
  fgm_0_19: 'FG 0-19', fgm_20_29: 'FG 20-29', fgm_30_39: 'FG 30-39',
  fgm_40_49: 'FG 40-49', fgm_50p: 'FG 50+',
  def_td: 'DEF TD', sack: 'Sack', int: 'DEF interception', ff: 'Forced fumble',
  fum_rec: 'Fumble recovery', safe: 'Safety', blk_kick: 'Blocked kick',
  pts_allow_0: 'Pts allowed 0', pts_allow_1_6: 'Pts allowed 1-6', pts_allow_7_13: 'Pts allowed 7-13',
  pts_allow_14_20: 'Pts allowed 14-20', pts_allow_21_27: 'Pts allowed 21-27',
  pts_allow_28_34: 'Pts allowed 28-34', pts_allow_35p: 'Pts allowed 35+',
  st_td: 'Special teams TD', pr_td: 'Punt return TD', kr_td: 'Kick return TD',
};

function renderLeague() {
  const host = $('#leagueHost');
  host.replaceChildren();
  const L = S.league;
  if (!L) return;

  const starters = starterSlots();
  const bench = rosterPositions().filter((p) => p === 'BN').length;
  const ir = rosterPositions().filter((p) => p === 'IR').length;

  host.appendChild(el('div', { class: 'card' }, [
    el('h2', { text: L.name }),
    el('p', { class: 'sub', text: L.season + ' season · ' + L.status + ' · ' + L.total_rosters + ' teams' }),
    el('dl', { class: 'kv' }, [
      el('dt', { text: 'Scoring' }), el('dd', { text: (L.scoring_settings && L.scoring_settings.rec === 1 ? 'Full PPR' : (L.scoring_settings && L.scoring_settings.rec ? L.scoring_settings.rec + ' PPR' : 'Standard')) }),
      el('dt', { text: 'Roster size' }), el('dd', { text: rosterPositions().length + ' (' + starters.length + ' starters, ' + bench + ' bench' + (ir ? ', ' + ir + ' IR' : '') + ')' }),
      el('dt', { text: 'Draft' }), el('dd', { text: S.draft ? (S.draft.type + ' · ' + roundCount() + ' rounds · ' + S.draft.status) : 'none' }),
      el('dt', { text: 'Playoff teams' }), el('dd', { text: (L.settings && L.settings.playoff_teams) || '—' }),
      el('dt', { text: 'Waivers' }), el('dd', { text: (L.settings && L.settings.waiver_type === 2 ? 'FAAB (' + (L.settings.waiver_budget || 0) + ')' : 'rolling/reverse') }),
      el('dt', { text: 'Prior seasons found' }), el('dd', { text: S.history.length ? S.history.map((h) => h.season).join(', ') : 'none linked' }),
    ]),
    el('h4', { style: 'margin:14px 0 6px;font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em', text: 'Starting lineup' }),
    el('div', { class: 'starters' }, starters.map((p) => el('span', { class: 'slot', text: p }))),
    el('h4', { style: 'margin:14px 0 6px;font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em', text: 'Replacement level' }),
    el('p', { class: 'sub', style: 'margin:0 0 6px', text: 'Derived from these exact starter slots — every VOR number on the board is measured against it.' }),
    el('div', { class: 'starters' }, ['QB', 'RB', 'WR', 'TE'].map((pos) => el('span', {
      class: 'slot',
      text: pos + ' ' + fmt((S.replacement || {})[pos], 0) + ' pts',
    }))),
  ]));

  const sc = L.scoring_settings || {};
  const entries = Object.entries(sc).filter(([, v]) => v !== 0).sort((a, b) => {
    const la = SCORING_LABELS[a[0]] ? 0 : 1, lb = SCORING_LABELS[b[0]] ? 0 : 1;
    return la - lb || a[0].localeCompare(b[0]);
  });
  host.appendChild(el('div', { class: 'card' }, [
    el('h2', { text: 'Point settings' }),
    el('p', { class: 'sub', text: 'Pulled live from your league. Every non-zero rule Sleeper reports.' }),
    el('div', { class: 'scoring-grid' }, entries.map(([k, v]) => el('div', {}, [
      el('span', { text: SCORING_LABELS[k] || k }),
      el('span', { class: v > 0 ? 'good' : 'bad', text: (v > 0 ? '+' : '') + v }),
    ]))),
    el('details', { class: 'raw' }, [
      el('summary', { text: 'Raw league JSON' }),
      el('pre', { text: JSON.stringify({ settings: L.settings, scoring_settings: sc, roster_positions: L.roster_positions }, null, 2) }),
    ]),
  ]));

  const owners = pickOwnerMap();
  const orderBody = el('tbody');
  for (let slot = 1; slot <= teamCount(); slot += 1) {
    const rid = slotToRoster()[slot];
    orderBody.appendChild(el('tr', { class: rid === S.myRosterId ? 'sel' : '' }, [
      el('td', { class: 'num right', text: slot }),
      el('td', { class: 'name', text: rid ? teamName(rid) : '—' }),
      el('td', { class: 'muted' }, [rid ? [1, 2, 3].map((r) => {
        const owner = owners.get(r + ':' + rid);
        return '#' + pickNumber(r, slot) + (owner && owner !== rid ? ' (→ ' + teamName(owner) + ')' : '');
      }).join(', ') + ' …' : '']),
      el('td', { class: 'num right muted', text: rid ? predictedForRoster(rid).length + ' keepers' : '' }),
    ]));
  }
  host.appendChild(el('div', { class: 'card' }, [
    el('h2', { text: 'Draft order' }),
    el('p', { class: 'sub', text: 'Snake, as already set by your commissioner.' }),
    el('div', { class: 'table-wrap' }, [
      el('table', {}, [
        el('thead', {}, [el('tr', {}, [
          el('th', { class: 'right', text: 'Slot' }), el('th', { text: 'Team' }),
          el('th', { text: 'Early picks' }), el('th', { class: 'right', text: 'Predicted' }),
        ])]),
        orderBody,
      ]),
    ]),
  ]));
}

/* ---------------------------------------------------------------- wiring */

const VIEWS = ['league', 'board', 'available', 'keepers', 'sim'];
let activeView = 'board';

function showView(name) {
  activeView = name;
  for (const v of VIEWS) {
    $('#view-' + v).hidden = v !== name;
    $('#tab-' + v).setAttribute('aria-selected', String(v === name));
  }
  try { localStorage.setItem('cofp.view', name); } catch (e) { /* ignore */ }
  renderActive();
}

function renderActive() {
  if (!S.league) return;
  if (activeView === 'league') renderLeague();
  else if (activeView === 'board') renderBoard();
  else if (activeView === 'available') renderAvailable();
  else if (activeView === 'keepers') renderKeepers();
  else if (activeView === 'sim') renderSim();
}

/** Keeper math depends on rosters, history and overrides — redo it, then repaint. */
function rebuild() {
  buildKeepers();
  renderActive();
}

function populateTeamSelect() {
  const sel = $('#myTeam');
  const r2s = rosterToSlot();
  sel.replaceChildren(el('option', { value: '', text: '— which team is yours? —' }));
  for (const r of S.rosters.slice().sort((a, b) => (r2s[a.roster_id] || 99) - (r2s[b.roster_id] || 99))) {
    sel.appendChild(el('option', {
      value: r.roster_id,
      text: (r2s[r.roster_id] ? 'slot ' + r2s[r.roster_id] + ' · ' : '') + teamName(r.roster_id),
    }));
  }
  if (S.myRosterId) sel.value = String(S.myRosterId);
}

async function refreshPicks(quiet) {
  if (!S.draft) return;
  try {
    const picks = await api('/draft/' + S.draft.draft_id + '/picks');
    const before = S.picks.filter((p) => p.player_id).length;
    S.picks = picks || [];
    const after = S.picks.filter((p) => p.player_id).length;
    const draft = await api('/draft/' + S.draft.draft_id);
    if (draft) S.draft = draft;
    if (!quiet || after !== before) renderActive();
    setStatus('Live · ' + after + ' picks · ' + new Date().toLocaleTimeString(),
      S.draft.status === 'drafting' ? 'live' : 'ok');
  } catch (e) {
    setStatus('Poll failed: ' + e.message, 'err');
  }
}

function setLive(on) {
  if (S.pollTimer) { clearInterval(S.pollTimer); S.pollTimer = null; }
  if (on) {
    S.pollTimer = setInterval(() => refreshPicks(true), 10000);
    refreshPicks(true);
  }
  $('#liveToggle').textContent = on ? 'Stop live updates' : 'Start live updates';
  $('#liveToggle').classList.toggle('primary', !on);
}

/** Offline bundle written by scripts/fetch_league.py, used when the API is unreachable. */
async function loadBundle() {
  const res = await fetch('data/league.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('no data/league.json');
  const b = await res.json();
  S.league = b.league;
  S.rosters = b.rosters || [];
  S.users = b.users || [];
  S.draft = b.draft || null;
  S.picks = b.picks || [];
  S.history = b.history || [];
  S.tradedPicks = b.tradedPicks || [];
  S.nflPlayers = b.players || {};
  S.leagueId = b.league && b.league.league_id;
  return b;
}

async function boot(leagueId, opts) {
  const banner = $('#banner');
  banner.replaceChildren();
  $('#loadBtn').disabled = true;
  try {
    await loadLeague(leagueId);
    setStatus('Loaded ' + S.league.name, 'ok');
  } catch (err) {
    // Live API unreachable (offline, blocked network, corporate proxy).
    let recovered = false;
    try {
      await loadBundle();
      recovered = true;
      banner.appendChild(el('div', { class: 'notice' }, [
        el('strong', { text: 'Using the offline snapshot. ' }),
        'Could not reach api.sleeper.app (' + err.message + '), so this is data/league.json. '
        + 'Live pick updates are off until the API is reachable.',
      ]));
      setStatus('Offline snapshot', 'warn');
    } catch (e2) { /* fall through */ }

    if (!recovered) {
      const snap = lsGet(LS.snapshot, null);
      if (snap && snap.league) {
        S.league = snap.league; S.rosters = snap.rosters; S.users = snap.users;
        S.draft = snap.draft; S.picks = snap.picks; S.history = snap.history;
        S.nflPlayers = (lsGet(LS.players, {}) || {}).map || {};
        recovered = true;
        banner.appendChild(el('div', { class: 'notice' }, [
          el('strong', { text: 'Showing the last cached load. ' }),
          'api.sleeper.app is unreachable (' + err.message + ').',
        ]));
        setStatus('Cached', 'warn');
      }
    }

    if (!recovered) {
      banner.appendChild(el('div', { class: 'notice err' }, [
        el('strong', { text: 'Could not load the league. ' }),
        err.message + '. ',
        el('br'),
        'If you opened this file directly, serve it instead — from the repo root run ',
        el('code', { text: 'python3 -m http.server 8000' }),
        ' and open ', el('code', { text: 'http://localhost:8000' }), '. ',
        'If your network blocks Sleeper, run ', el('code', { text: 'python3 scripts/fetch_league.py' }),
        ' somewhere with access to write data/league.json.',
      ]));
      setStatus('Load failed', 'err');
      $('#loadBtn').disabled = false;
      return;
    }
  }

  computeValue();
  buildKeepers();

  // Real keepers beat any guess, including a stale one saved in this browser,
  // so they are re-read from Sleeper on every load rather than restored.
  const byRoster = actualKeepersByRoster();
  S.actualKeepers = new Set();
  S.keeperTeamCount = byRoster.size;
  for (const set of byRoster.values()) for (const pid of set) S.actualKeepers.add(pid);

  if (S.actualKeepers.size) {
    applyActualKeepers();
  } else {
    S.keeperMode = 'whatif';
    const saved = lsGet(LS.predicted, null);
    if (saved && saved.length) S.predicted = new Set(saved.filter((pid) => S.keepers.has(pid)));
    else autoPredict();
    enforceKeeperCap();
    persistPredicted();
  }

  populateTeamSelect();
  $('#leagueTitle').textContent = S.league.name + ' · ' + S.league.season
    + (S.myRosterId ? ' · ' + teamName(S.myRosterId) : '');
  // On a phone the board should be the first thing on screen, not the setup form.
  if (window.innerWidth < 900) $('#setupCard').removeAttribute('open');
  $('#loadBtn').disabled = false;
  renderActive();

  if (S.draft && S.draft.status === 'drafting' && !opts?.noLive) setLive(true);
}

function init() {
  S.overrides = lsGet(LS.overrides, {}) || {};
  keeperSort = lsGet(LS.keeperSort, 'rounds') || 'rounds';
  S.myRosterId = lsGet(LS.team, null);
  const savedView = (() => { try { return localStorage.getItem('cofp.view'); } catch (e) { return null; } })();
  if (savedView && VIEWS.indexOf(savedView) !== -1) activeView = savedView;

  for (const v of VIEWS) $('#tab-' + v).addEventListener('click', () => showView(v));

  $('#leagueInput').value = lsGet(LS.league, DEFAULT_LEAGUE) || DEFAULT_LEAGUE;
  $('#loadBtn').addEventListener('click', () => boot($('#leagueInput').value.trim()));
  $('#refreshBtn').addEventListener('click', () => refreshPicks(false));
  $('#liveToggle').addEventListener('click', () => setLive(!S.pollTimer));
  $('#myTeam').addEventListener('change', (e) => {
    S.myRosterId = e.target.value ? Number(e.target.value) : null;
    lsSet(LS.team, S.myRosterId);
    if (S.league) {
      $('#leagueTitle').textContent = S.league.name + ' · ' + S.league.season
        + (S.myRosterId ? ' · ' + teamName(S.myRosterId) : '');
    }
    renderActive();
  });

  $('#optKeepers').addEventListener('change', renderBoard);
  $('#optProject').addEventListener('change', renderBoard);
  $('#availSearch').addEventListener('input', (e) => { availState.q = e.target.value; renderAvailable(); });
  $('#availPos').addEventListener('change', (e) => { availState.pos = e.target.value; renderAvailable(); });
  $('#availHideKeepers').addEventListener('change', (e) => { availState.hideKeepers = e.target.checked; renderAvailable(); });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { const m = $('.player-modal-backdrop'); if (m) m.remove(); }
  });

  showView(activeView);
  loadRankings()
    .then(() => boot($('#leagueInput').value.trim()))
    .catch((err) => {
      $('#banner').appendChild(el('div', { class: 'notice err', text: err.message
        + ' — serve the folder over http (python3 -m http.server 8000) rather than opening index.html directly.' }));
      setStatus('Rankings failed to load', 'err');
    });
}

document.addEventListener('DOMContentLoaded', init);
