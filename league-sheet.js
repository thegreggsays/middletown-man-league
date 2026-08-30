/**
 * league-sheet.js — reads the league Google Sheet and does all the math.
 *
 * HOW IT GETS THE DATA
 * Google can hand out any sheet tab as plain CSV, no key or login needed, as
 * long as the sheet is shared "anyone with the link can view." We ask for each
 * tab by name and parse what comes back.
 *
 * IMPORTANT: cell COLOURS do not survive this. Google only exports the text.
 * That's why "years kept" is worked out by comparing seasons instead: if an
 * owner kept a player last year and is keeping him again, that's year two.
 *
 * Results are cached for a few minutes so a page refresh doesn't hammer Google.
 */

const fetch = require('node-fetch');

const CACHE_MINUTES = Number(process.env.SHEET_CACHE_MINUTES || 5);
let cache = { at: 0, data: null };

/* ---------------------------------------------------------------- */
/* CSV                                                              */
/* ---------------------------------------------------------------- */

/** Minimal CSV parser that respects quoted fields containing commas. */
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  row.push(field);
  if (row.length > 1 || row[0] !== '') rows.push(row);
  return rows;
}

async function fetchTab(sheetId, tabName) {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq`
    + `?tqx=out:csv&sheet=${encodeURIComponent(tabName)}`;

  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`tab "${tabName}": HTTP ${res.status}`);

  const text = await res.text();
  if (text.trim().startsWith('<')) {
    throw new Error(
      `tab "${tabName}": Google returned a web page instead of data. ` +
      `The sheet is probably not shared publicly.`
    );
  }
  return parseCSV(text);
}

/** Safe cell read — sheets often come back ragged. */
const cell = (grid, r, c) => ((grid[r] || [])[c] || '').trim();

/* ---------------------------------------------------------------- */
/* Name matching                                                    */
/* ---------------------------------------------------------------- */


/**
 * Roster cells pasted from Yahoo carry interface text after the name —
 * "Video Forecast", "Final", stray private-use glyphs. Strip it, or the
 * player won't match the draft board and everyone looks undrafted.
 */

/**
 * Shorthand used on the draft board that no matching rule could guess.
 * "CMC" is not close to "Christian McCaffrey" by any string comparison, and
 * getting it wrong is expensive — he'd silently price as a 5th-round keeper
 * instead of being ineligible.
 *
 * Add a line here whenever a nickname shows up in the DATA QUALITY list.
 * Left side = what's typed in the sheet, right side = the real name.
 */
const NICKNAMES = {
  'cmc': 'Christian McCaffrey',
  'devonte adams': 'Davante Adams'      // spelled this way on the draft board
};

function expandNickname(name) {
  const k = String(name || '').trim().toLowerCase()
    .replace(/[.']/g, '').replace(/\s+/g, ' ');
  return NICKNAMES[k] || name;
}

function cleanPlayer(raw) {
  return String(raw || '')
    .split('\n')[0]
    .replace(/[\uE000-\uF8FF]/g, '')
    .split(/Video Forecast|Final|Notes?\b/)[0]
    .replace(/\s+/g, ' ')
    .trim();
}

function norm(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/'/g, '')
    .replace(/-/g, ' ')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}


/**
 * Owners whose name changed in the sheet, or whose franchise changed hands.
 * Without this, a keeper's history breaks at the rename and the two-year
 * limit silently stops applying.
 *
 * Left side = how it appears in older tabs, right side = current name.
 * Add a line here whenever someone new takes over a team.
 */
const OWNER_ALIASES = {
  rebeyo: 'Rebel',     // same owner, spelled both ways across tabs
  mark: 'Marc',        // spelled both ways across tabs
  prender: 'Marc',     // Marc took over this franchise
  flynn: 'Palumberi'   // Palumberi took over this franchise
};

function canonOwner(name) {
  const k = String(name || '').trim().toLowerCase();
  return OWNER_ALIASES[k] || String(name || '').trim();
}

const EMPTY = new Set(['', 'none', 'n/a', 'na', '-']);
const isEmpty = v => EMPTY.has(String(v || '').trim().toLowerCase());

/**
 * The sheet is hand-typed, so names drift: "Ladd McConke", "Achane",
 * "Higgins", "Puca Nacua". Match on last name plus a loose first-name check
 * rather than demanding an exact string.
 */

/** Levenshtein distance, but it gives up as soon as it exceeds max. */
function editDistanceAtMost(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return false;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return false;      // no path back under the limit
    prev = cur;
  }
  return prev[b.length] <= max;
}

/**
 * How much misspelling to forgive in a first name. Short names get one edit —
 * "Brian" and "Bijan" are two apart and must stay separate people. Long names
 * get two, which covers hand-typed ones like "Tetaitora" for "Tetairoa".
 */
function firstNameTypoBudget(a, b) {
  return Math.min(a.length, b.length) >= 8 ? 2 : 1;
}

function samePlayer(a, b) {
  const A = norm(a), B = norm(b);
  if (!A || !B) return false;
  if (A === B) return true;
  if (A.includes(B) || B.includes(A)) return true;

  const pa = A.split(' '), pb = B.split(' ');
  const la = pa.pop(), lb = pb.pop();
  if (la.length < 4 || lb.length < 4) return false;

  const lastMatch = la === lb || la.startsWith(lb) || lb.startsWith(la); // McConke / McConkey
  if (!lastMatch) return false;

  // Surname alone is NOT enough — "Hunter Henry" is not "Derrick Henry".
  // Accept when one side gave no first name at all (the sheet often just says
  // "Achane" or "Higgins"), otherwise the first names have to genuinely agree.
  const fa = pa.join(' '), fb = pb.join(' ');
  if (!fa || !fb) return true;
  if (fa === fb) return true;

  // an initial standing in for the full name: "a j brown" / "aj brown"
  if (fa.length <= 2 || fb.length <= 2) return fa[0] === fb[0];

  // one is a genuine prefix of the other: "mike" / "michael" style
  if (fa.startsWith(fb) || fb.startsWith(fa)) return true;

  // otherwise allow a single typo only — catches "Derick"/"Derrick" and
  // "Sawuon"/"Saquon" while still rejecting "Brian"/"Bijan", which differ by
  // two characters and are different people.
  return editDistanceAtMost(fa, fb, firstNameTypoBudget(fa, fb));
}

function ordinal(n) {
  if (n <= 0) return 'N/A';
  const v = n % 100;
  const s = (v >= 11 && v <= 13) ? 'th'
    : ({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] || 'th';
  return `${n}${s}`;
}

function roundNumber(text) {
  const m = String(text || '').match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

/* ---------------------------------------------------------------- */
/* Section readers                                                  */
/* ---------------------------------------------------------------- */

/** Turn "1st" / "2nd" from the Times Kept column into a number. */
function timesKept(text) {
  const m = String(text || '').match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

/**
 * Keeper declarations, "Keepers By Team".
 * One row per keeper: owner | player | round | times kept.
 * Rows are grouped per owner, so an owner with no keeper still gets a row
 * with the player cell blank.
 */
function readKeepers(grid, cols) {
  const byOwner = new Map();

  for (let r = cols.firstRow; r < grid.length; r++) {
    const owner = canonOwner(cell(grid, r, cols.owner));
    if (!owner) continue;
    if (owner.toLowerCase() === 'player' || owner.toLowerCase() === 'team') continue;

    if (!byOwner.has(owner)) byOwner.set(owner, { owner, keepers: [] });

    const player = cell(grid, r, cols.player);
    if (isEmpty(player)) continue;

    byOwner.get(owner).keepers.push({
      player,
      round: cell(grid, r, cols.round),
      timesKept: timesKept(cell(grid, r, cols.times))
    });
  }
  return [...byOwner.values()];
}

/** Older season tabs still use the wide layout: owner | k1 | rd | k2 | rd. */
function readKeepersLegacy(grid) {
  const out = [];
  for (let r = 1; r <= 14; r++) {
    const owner = canonOwner(cell(grid, r, 0));
    if (!owner || owner.toLowerCase() === 'player') continue;
    const keepers = [];
    for (const [pc, rc] of [[1, 2], [3, 4]]) {
      const player = cell(grid, r, pc);
      if (!isEmpty(player)) keepers.push({ player, round: cell(grid, r, rc), timesKept: null });
    }
    out.push({ owner, keepers });
  }
  return out;
}

/**
 * Draft board — "Draft Order - By Round w/ Trades".
 * Columns: Rd | Pick | Team | Player, one row per pick.
 * A team cell may read "Fito (From Hexx)" when the pick was traded.
 */
function readDraft(grid, cols) {
  const picks = [];
  for (let r = cols.firstRow; r < grid.length; r++) {
    const rnd = cell(grid, r, cols.round);
    const player = cell(grid, r, cols.player);
    if (!rnd || !player) continue;
    if (!/^\d+(\.0+)?$/.test(rnd)) continue;

    const raw = cell(grid, r, cols.team);
    const from = (raw.match(/\(from ([^)]*)\)/i) || [])[1] || null;

    picks.push({
      round: Math.round(Number(rnd)),
      pick: Math.round(Number(cell(grid, r, cols.pick))) || 0,
      owner: canonOwner(raw.replace(/\s*\(from [^)]*\)/i, '')),
      tradedFrom: from ? canonOwner(from) : null,
      player: expandNickname(player)
    });
  }
  return picks;
}

/**
 * End-of-season rosters, used to price keepers.
 * The export repeats section headers inside each team's block
 * ("Pos / Offense", "Kickers", "Defense/Special Teams") — those rows carry a
 * team name but no player, so they have to be filtered out or they'd be
 * treated as rostered players.
 */
const ROSTER_NOISE = new Set([
  'pos', 'offense', 'kickers', 'defense/special teams', 'bench', 'team', ''
]);

function readRosters(grid, cols) {
  const out = [];
  for (let r = cols.firstRow; r < grid.length; r++) {
    const owner = canonOwner(cell(grid, r, cols.owner));
    const pos = cell(grid, r, cols.pos);
    const raw = cell(grid, r, cols.player);
    if (!owner || !raw) continue;

    if (ROSTER_NOISE.has(pos.toLowerCase())) continue;
    if (ROSTER_NOISE.has(raw.toLowerCase())) continue;

    const player = cleanPlayer(raw);
    if (!player || player === '(Empty)') continue;

    out.push({ owner, pos, player });
  }
  return out;
}

/**
 * Trade blocks. Rows are read top to bottom; consecutive rows naming the same
 * owner are one side of a deal, and sides pair off two at a time.
 */
function readTrades(grid, startCol, width) {
  const years = {};
  for (let c = startCol + 1; c < startCol + width; c++) {
    const y = cell(grid, 1, c);
    if (y) years[c] = String(y).replace(/\.0+$/, '');
  }

  const rows = [];
  for (let r = 2; r < 30; r++) {
    const label = cell(grid, r, startCol);
    if (!label) continue;
    const owner = canonOwner(label.replace(/\s*gets?\s*$/i, ''));
    const assets = [];
    for (let c = startCol + 1; c < startCol + width; c++) {
      const v = cell(grid, r, c);
      if (v) assets.push({ year: years[c] || '', item: v });
    }
    if (assets.length) rows.push({ owner, assets });
  }

  const sides = [];
  for (const row of rows) {
    if (sides.length && sides[sides.length - 1].owner === row.owner) {
      sides[sides.length - 1].assets.push(...row.assets);
    } else {
      sides.push({ owner: row.owner, assets: [...row.assets] });
    }
  }

  const trades = [];
  for (let i = 0; i + 1 < sides.length; i += 2) {
    trades.push({ a: sides[i], b: sides[i + 1] });
  }
  if (sides.length % 2) trades.push({ a: sides[sides.length - 1], b: null });
  return trades;
}

/* ---------------------------------------------------------------- */
/* The keeper rules                                                 */
/* ---------------------------------------------------------------- */

/**
 * SIMPLIFIED KEEPER COSTS (adopted by league vote)
 *
 * You may only keep a player you drafted yourself, or acquired by trade.
 * Anyone picked up off waivers or free agency goes back into the pool.
 *
 * 1. Cost = one round earlier than where he was originally drafted
 * 2. Drafted in round 1 -> not keepable (overrides everything below)
 * 3. Already kept two seasons -> not keepable
 * 4. Acquired by trade -> keepable, priced off the ORIGINAL draft round
 * 5. Picked up off waivers, or never drafted at all -> not keepable
 */
function computeKeeperCosts({ rosters, draft, inSeasonTrades, exhausted }) {
  const draftIndex = draft.map(d => ({ ...d, n: norm(d.player) }));

  // players named in the in-season trade log changed hands by trade, not waivers
  const tradedNames = [];
  for (const t of inSeasonTrades) {
    for (const side of [t.a, t.b]) {
      if (!side) continue;
      for (const asset of side.assets) {
        if (!/^(rd|round|pick)\b/i.test(asset.item) && !/^\d/.test(asset.item)) {
          tradedNames.push(asset.item);
        }
      }
    }
  }

  return rosters.map(r => {
    const hit = draftIndex.find(d => samePlayer(d.player, r.player));
    const wasTraded = tradedNames.some(n => samePlayer(n, r.player));
    const isExhausted = exhausted.some(
      e => e.owner === r.owner && samePlayer(e.player, r.player)
    );

    let cost, status, reason = null;

    if (!hit) {
      // never drafted by anyone — a free-agent add
      cost = 0;
      status = 'Undrafted';
      reason = 'waiver pickup';
    } else if (hit.owner === r.owner) {
      cost = Math.max(1, hit.round - 1);
      status = 'Same team';
    } else if (wasTraded) {
      cost = Math.max(1, hit.round - 1);
      status = `Traded (orig. Rd${hit.round} by ${hit.owner})`;
    } else {
      // drafted by someone else and not traded — so he came off waivers
      cost = 0;
      status = `Waiver (orig. Rd${hit.round} by ${hit.owner})`;
      reason = 'waiver pickup';
    }

    // these two override anything above
    if (hit && hit.round === 1) { cost = 0; reason = '1st rounder'; }
    else if (isExhausted) { cost = 0; reason = 'kept twice'; }

    return {
      owner: r.owner,
      player: r.player,
      pos: r.pos,
      draftRound: hit ? hit.round : null,
      status,
      costRound: cost,
      costLabel: cost === 0 ? 'N/A' : ordinal(cost),
      reason
    };
  });
}

/* ---------------------------------------------------------------- */
/* Main                                                             */
/* ---------------------------------------------------------------- */

async function loadLeagueData(sheetId, opts = {}) {
  const fresh = Date.now() - cache.at < CACHE_MINUTES * 60 * 1000;
  if (fresh && cache.data && !opts.force) return cache.data;

  const [cur, prev, prev2] = await Promise.all([
    fetchTab(sheetId, '2026-2027'),
    fetchTab(sheetId, '2025-2026'),
    fetchTab(sheetId, '2024-2025').catch(() => [])
  ]);

  /* --------------------------------------------------------------
     COLUMN MAP (0-based). The two current tabs share a layout, but
     2025-2026 carries one extra trade year, which pushes everything
     to its right over by one column.
     -------------------------------------------------------------- */
  const CUR = {
    keepers: { firstRow: 2, owner: 8, player: 9, round: 10, times: 11 },   // I J K L
    draft:   { firstRow: 2, round: 3, pick: 4, team: 5, player: 6 },       // D E F G
    rosters: { firstRow: 2, owner: 22, pos: 23, player: 24 },              // W X Y
    preseason: { col: 13, width: 3 },                                      // N + O P
    inSeason:  { col: 17, width: 4 }                                       // R + S T U
  };
  const PREV = {
    keepers: { firstRow: 2, owner: 8, player: 9, round: 10, times: 11 },   // I J K L
    draft:   { firstRow: 2, round: 3, pick: 4, team: 5, player: 6 },       // D E F G
    rosters: { firstRow: 2, owner: 23, pos: 24, player: 25 },              // X Y Z
    preseason: { col: 13, width: 4 },                                      // N + O P Q
    inSeason:  { col: 18, width: 4 }                                       // S + T U V
  };

  const declared = readKeepers(cur, CUR.keepers);
  const lastSeason = readKeepers(prev, PREV.keepers);
  const twoSeasonsAgo = prev2.length ? readKeepersLegacy(prev2) : [];

  const findKeep = (list, owner, player) => {
    const row = list.find(x => x.owner === owner);
    if (!row) return null;
    return row.keepers.find(k => samePlayer(k.player, player)) || null;
  };

  /* YEARS KEPT
     Prefer the sheet's own "Times Kept" column. Where it's blank, fall back
     to comparing seasons: kept last year too means this is year two. */
  const derivedYears = [];
  const keepers = declared.map(row => ({
    owner: row.owner,
    keepers: row.keepers.map(k => {
      if (k.timesKept) return { ...k, year: k.timesKept, source: 'sheet' };
      const kept = !!findKeep(lastSeason, row.owner, k.player);
      derivedYears.push(`${row.owner}: ${k.player}`);
      return { ...k, year: kept ? 2 : 1, source: 'derived' };
    })
  }));

  /* ---- What each part of the site is built from ---------------- */

  const prevDraft = readDraft(prev, PREV.draft);
  const prevRosters = readRosters(prev, PREV.rosters);
  const curDraft = readDraft(cur, CUR.draft);

  const preseasonPrev = readTrades(prev, PREV.preseason.col, PREV.preseason.width);
  const inSeasonPrev = readTrades(prev, PREV.inSeason.col, PREV.inSeason.width);
  const preseasonCur = readTrades(cur, CUR.preseason.col, CUR.preseason.width);
  const inSeasonCur = readTrades(cur, CUR.inSeason.col, CUR.inSeason.width);

  /* A season's draft board starts life holding only the keepers, pre-slotted
     into the rounds they cost — so an "empty" board still has rows in it.
     Treat it as a real draft only once it holds something the keeper list
     doesn't account for. */
  const declaredKeeperCount = declared.reduce((n, o) => n + o.keepers.length, 0);
  const curNonKeeperPicks = curDraft.filter(p =>
    !declared.some(o => o.keepers.some(k => samePlayer(k.player, p.player)))
  ).length;
  const curDraftIsReal = curNonKeeperPicks > 0;

  const displayDraft = curDraftIsReal ? curDraft : prevDraft;
  const displayDraftSeason = curDraftIsReal ? '2026-2027' : '2025-2026';
  const preSlottedKeepers = curDraftIsReal ? 0 : curDraft.length;

  /* Rosters for the current season come from the DRAFT BOARD (cols D-G).
     That's the league's starting point for the year — keepers are already
     slotted into it, so it's the whole team. The "Ending Rosters" columns
     are deliberately not used: they only get filled in at the END of a
     season. Once Yahoo is connected, live rosters replace this entirely.

     Positions aren't on the draft board. Last season's roster column looks
     like positions but is really the LINEUP SLOT from the final week, so a
     good back who happened to be benched reads "BN". Only genuine position
     slots carry over; anything else is left blank rather than guessed at. */
  const REAL_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'D/ST']);
  const posByPlayer = new Map();
  for (const r of prevRosters) {
    const slot = String(r.pos || '').toUpperCase();
    if (REAL_POSITIONS.has(slot)) posByPlayer.set(norm(r.player), slot);
  }
  const guessPosition = name =>
    /\b(def|d\/st|defense)\b/i.test(name) ? 'DEF' : '';

  let displayRosters, displayRosterSeason, rosterBasis;
  if (curDraftIsReal) {
    displayRosters = curDraft
      .slice()
      .sort((a, b) => a.pick - b.pick)
      .map(p => ({
        owner: p.owner,
        player: p.player,
        pos: posByPlayer.get(norm(p.player)) || guessPosition(p.player),
        round: p.round,
        pick: p.pick
      }));
    displayRosterSeason = '2026-2027';
    rosterBasis = 'draft board';
  } else {
    displayRosters = prevRosters.map(r => ({ ...r, round: null, pick: null }));
    displayRosterSeason = '2025-2026';
    rosterBasis = 'ending rosters';
  }

  /* ---- Keeper cost basis ---------------------------------------
     Prices come off the most recent COMPLETED draft, against the roster as
     it stands now. Once the new draft is in, everything shifts forward a
     season: you keep into 2027 based on where you took him in 2026. */
  const costDraft = curDraftIsReal ? curDraft : prevDraft;
  const costRosters = displayRosters;
  const costSeason = curDraftIsReal ? '2026-2027' : '2025-2026';
  const costInSeasonTrades = curDraftIsReal ? inSeasonCur : inSeasonPrev;

  /* EXHAUSTED — already kept twice, so back in the pool. Read off whichever
     keeper list is current, trusting the "Times Kept" column and falling
     back to comparing seasons where it's blank. */
  const exhaustedSource = curDraftIsReal ? declared : lastSeason;
  const exhaustedPrior = curDraftIsReal ? lastSeason : twoSeasonsAgo;

  const exhausted = [];
  const missingTimesKept = [];
  for (const row of exhaustedSource) {
    for (const k of row.keepers) {
      let twice;
      if (k.timesKept) {
        twice = k.timesKept >= 2;
      } else {
        twice = !!findKeep(exhaustedPrior, row.owner, k.player);
        missingTimesKept.push(`${row.owner}: ${k.player}`);
      }
      if (twice) exhausted.push({ owner: row.owner, player: k.player });
    }
  }

  const keeperCosts = computeKeeperCosts({
    rosters: costRosters,
    draft: costDraft,
    inSeasonTrades: costInSeasonTrades,
    exhausted
  });

  const unmatched = keeperCosts
    .filter(k => k.draftRound === null)
    .map(k => `${k.owner}: ${k.player}`);

  const data = {
    fetchedAt: new Date().toISOString(),
    dataQuality: {
      draftPicks: displayDraft.length,
      draftSeasonShown: displayDraftSeason,
      currentDraftEntries: curDraft.length,
      currentDraftNonKeeperPicks: curNonKeeperPicks,
      declaredKeepers: declaredKeeperCount,
      currentDraftLooksLikeKeepersOnly: !curDraftIsReal && curDraft.length > 0,
      rosterPlayers: displayRosters.length,
      rosterSeasonShown: displayRosterSeason,
      rosterBasis,
      keeperCostBasis: `${costSeason} draft + current rosters`,
      keeperCostSeason: costSeason,
      inSeasonTradesLogged: inSeasonPrev.length,
      notFoundOnDraftBoard: unmatched,
      timesKeptBlank_lastSeason: missingTimesKept,
      timesKeptBlank_thisSeason: derivedYears
    },
    keepers,
    keeperCosts,

    // what the Draft Results tab shows
    draft: displayDraft,
    draftSeason: displayDraftSeason,
    preSlottedKeepers,

    // what the Rosters tab shows
    rosters: displayRosters,
    rosterSeason: displayRosterSeason,
    rosterBasis,

    exhausted,
    tradeSections: [
      { season: '2026-2027', label: 'Preseason Trades', trades: preseasonCur },
      { season: '2026-2027', label: '2027 In-Season Trades', trades: inSeasonCur },
      { season: '2025-2026', label: 'Preseason Trades', trades: preseasonPrev },
      { season: '2025-2026', label: '2026 In-Season Trades', trades: inSeasonPrev }
    ]
  };

  cache = { at: Date.now(), data };
  return data;
}

module.exports = { loadLeagueData, parseCSV, samePlayer, ordinal, canonOwner,
                   OWNER_ALIASES, editDistanceAtMost };
