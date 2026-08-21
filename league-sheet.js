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
  'cmc': 'Christian McCaffrey'
};

function expandNickname(name) {
  const k = String(name || '').trim().toLowerCase();
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
  // Only accept when one side gave no first name at all (the sheet often
  // just says "Achane" or "Higgins"), or the first names agree.
  const fa = pa.join(' '), fb = pb.join(' ');
  if (!fa || !fb) return true;
  return fa === fb || fa[0] === fb[0] || fa.startsWith(fb) || fb.startsWith(fa);
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

/**
 * Keeper declarations. Column positions differ between tabs because the
 * sheet grew an extra blank column in the 2025-2026 season.
 */
function readKeepers(grid, cols) {
  const out = [];
  for (let r = 1; r <= 12; r++) {
    const owner = canonOwner(cell(grid, r, cols.owner));
    if (!owner) continue;
    const keepers = [];
    for (const pair of cols.pairs) {
      const player = cell(grid, r, pair[0]);
      const round = cell(grid, r, pair[1]);
      if (!isEmpty(player)) keepers.push({ player, round });
    }
    out.push({ owner, keepers });
  }
  return out;
}

/** Draft board: round, overall pick, owner, player. */
function readDraft(grid) {
  const picks = [];
  for (let r = 30; r < grid.length; r++) {
    const rnd = cell(grid, r, 0);
    const player = cell(grid, r, 3);
    if (!rnd || !player) continue;
    if (!/^\d+(\.0+)?$/.test(rnd)) continue;   // "3" or "3.0" depending on export

    const raw = cell(grid, r, 2);
    const from = (raw.match(/\(from ([^)]*)\)/i) || [])[1] || null;
    picks.push({
      round: Math.round(Number(rnd)),
      pick: Math.round(Number(cell(grid, r, 1))) || 0,
      owner: canonOwner(raw.replace(/\s*\(from [^)]*\)/i, '')),
      tradedFrom: from ? canonOwner(from) : null,
      player: expandNickname(player)
    });
  }
  return picks;
}

/** End-of-season rosters, used to price keepers. */
function readRosters(grid, cols) {
  const out = [];
  for (let r = 1; r < grid.length; r++) {
    const owner = canonOwner(cell(grid, r, cols.owner));
    const pos = cell(grid, r, cols.pos);
    const player = cell(grid, r, cols.player);
    if (!owner || !player || pos === 'Pos') continue;
    if (player === '(Empty)') continue;
    out.push({ owner, pos, player: cleanPlayer(player) });
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
    if (y) years[c] = String(y).replace(/\.0$/, '');
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
 * 1. Base cost = one round earlier than where he was drafted
 * 2. Drafted in round 1 -> not keepable (beats everything below)
 * 3. Already kept two years -> not keepable
 * 4. Acquired by trade -> still one round earlier than the original draft slot
 * 5. Picked up off waivers -> flat 5th, unless originally drafted in rounds 1-4,
 *    in which case rule 1 applies instead
 */
function computeKeeperCosts({ rosters, draft, inSeasonTrades, exhausted }) {
  const draftIndex = draft.map(d => ({ ...d, n: norm(d.player) }));

  // players named in the in-season trade log moved by trade, not waivers
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
      cost = 5;
      status = 'Undrafted';
    } else if (hit.owner === r.owner) {
      cost = Math.max(1, hit.round - 1);
      status = 'Same team';
    } else if (wasTraded) {
      cost = Math.max(1, hit.round - 1);
      status = `Traded (orig. Rd${hit.round} by ${hit.owner})`;
    } else if (hit.round < 5) {
      cost = Math.max(1, hit.round - 1);
      status = `Waiver (orig. Rd${hit.round} by ${hit.owner})`;
    } else {
      cost = 5;
      status = `Waiver (orig. Rd${hit.round} by ${hit.owner})`;
    }

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

  // column layouts differ per tab
  const CUR_KEEPERS = { owner: 0, pairs: [[1, 2], [3, 4]] };
  const PREV_KEEPERS = { owner: 0, pairs: [[2, 3], [4, 5]] };

  const declared = readKeepers(cur, CUR_KEEPERS);
  const lastSeason = readKeepers(prev, PREV_KEEPERS);
  const twoSeasonsAgo = prev2.length ? readKeepers(prev2, CUR_KEEPERS) : [];

  const keptIn = (list, owner, player) => {
    const row = list.find(x => x.owner === owner);
    return !!(row && row.keepers.some(k => samePlayer(k.player, player)));
  };

  // YEARS KEPT, derived: kept last season too => this is year two
  const keepers = declared.map(row => ({
    owner: row.owner,
    keepers: row.keepers.map(k => ({
      ...k,
      year: keptIn(lastSeason, row.owner, k.player) ? 2 : 1
    }))
  }));

  // players who already used both years and must go back in the pool
  const exhausted = [];
  for (const row of lastSeason) {
    for (const k of row.keepers) {
      if (keptIn(twoSeasonsAgo, row.owner, k.player)) {
        exhausted.push({ owner: row.owner, player: k.player });
      }
    }
  }

  const draft = readDraft(prev);
  const rosters = readRosters(prev, { owner: 17, pos: 18, player: 19 });
  const preseasonPrev = readTrades(prev, 7, 4);
  const inSeasonPrev = readTrades(prev, 12, 4);
  const preseasonCur = readTrades(cur, 6, 4);
  const inSeasonCur = readTrades(cur, 10, 4);

  const keeperCosts = computeKeeperCosts({
    rosters, draft, inSeasonTrades: inSeasonPrev, exhausted
  });

  // Anything showing as undrafted is either a genuine waiver pickup or a name
  // the matcher couldn't resolve. Surfacing the list is how typos get caught.
  const unmatched = keeperCosts
    .filter(k => k.draftRound === null)
    .map(k => `${k.owner}: ${k.player}`);

  const data = {
    fetchedAt: new Date().toISOString(),
    dataQuality: {
      draftPicks: draft.length,
      rosterPlayers: rosters.length,
      notFoundOnDraftBoard: unmatched
    },
    keepers,
    keeperCosts,
    draft,
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

module.exports = { loadLeagueData, parseCSV, samePlayer, ordinal, canonOwner, OWNER_ALIASES };
