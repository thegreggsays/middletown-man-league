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
const fs = require('fs');
const path = require('path');

const CACHE_MINUTES = Number(process.env.SHEET_CACHE_MINUTES || 5);
let cache = { at: 0, data: null };

/* ----------------------------------------------------------------
   TWO FILES THAT LIVE IN THE REPO INSTEAD OF THE SHEET

   The team-name mapping and the Yahoo transaction log are pasted in
   by hand rather than maintained like the rest of the sheet, so they
   sit next to the code as CSVs. Committing a new one and pushing is
   the whole update — no tab to keep in sync.

   Either file can still live in the sheet as a tab of the same name;
   the repo copy simply wins when it's there.
   ---------------------------------------------------------------- */

const LOCAL_DIR = process.env.LEAGUE_DATA_DIR || __dirname;

function readLocalTab(file) {
  try {
    const p = path.join(LOCAL_DIR, file);
    if (!fs.existsSync(p)) return null;
    const rows = parseCSV(fs.readFileSync(p, 'utf8'));
    // An empty or header-only file is treated as absent, so a stray blank
    // file in the repo can't silently blank out a working sheet tab.
    return rows.filter(r => r.some(c => String(c || '').trim())).length > 1
      ? rows
      : null;
  } catch (e) {
    console.error('[league-sheet] could not read ' + file + ': ' + e.message);
    return null;
  }
}

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
  dan: 'Rogan',        // Team Key says Dan, the keeper tab says Rogan — same team
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

  // One name containing the other is only meaningful at word boundaries:
  // "Amon Ra" inside "Amon Ra St Brown" is the same player, but "Dan"
  // inside "Jayden Daniels" is not.
  const containsAsWords = (hay, needle) => {
    if (needle.length < 3) return false;
    const i = hay.indexOf(needle);
    if (i === -1) return false;
    const before = i === 0 || hay[i - 1] === ' ';
    const after = i + needle.length === hay.length || hay[i + needle.length] === ' ';
    return before && after;
  };
  if (containsAsWords(A, B) || containsAsWords(B, A)) return true;

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

  // The block is twelve owners deep. Other seasons' leftovers can sit further
  // down the same columns, so stop at the first gap once the block has begun
  // rather than scanning to the bottom of the sheet.
  let started = false;
  let blanks = 0;

  for (let r = cols.firstRow; r < grid.length; r++) {
    const owner = canonOwner(cell(grid, r, cols.owner));

    if (!owner) {
      if (started && ++blanks >= 1) break;
      continue;
    }
    blanks = 0;
    if (owner.toLowerCase() === 'player' || owner.toLowerCase() === 'team') continue;
    if (byOwner.size >= 12 && !byOwner.has(owner)) break;
    started = true;

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
  // Stop at the end of the board rather than scanning to the bottom of the
  // tab. If anything is ever pasted below it — another season's board, a
  // scratch list — reading on would mix two drafts together and quietly
  // reprice everyone's keepers off the wrong rounds.
  let started = false;
  let blanks = 0;

  for (let r = cols.firstRow; r < grid.length; r++) {
    const rnd = cell(grid, r, cols.round);
    const player = cell(grid, r, cols.player);

    if (!rnd && !player) {
      if (started && ++blanks >= 2) break;
      continue;
    }
    blanks = 0;

    if (!rnd || !player) continue;
    if (!/^\d+(\.0+)?$/.test(rnd)) continue;

    // A repeated "Rd / Pick / Team / Player" header means a second block
    // begins here, so the one we came for has ended.
    if (started && /^(rd|round)$/i.test(rnd)) break;
    started = true;

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


/* ================================================================
   STANDINGS, ROSTERS AND ACTIVITY
   Yahoo's API application never came back, so the league pastes its
   own data into the sheet instead:

     * Standings  — a block on the season tab, headed "Rank | Team |
       W-L-T | PF | PA | Streak", pasted from Yahoo.
     * Rosters    — a block headed "Rosters", twelve teams of
       "Pos | Player" separated by blank rows.
     * Team Key   — a tab mapping Yahoo team names to owner names.
     * Activity   — a tab holding the Yahoo transaction page pasted
       straight in, one cell per line.

   Blocks are found by their own section headings rather than fixed
   column letters, so inserting a column somewhere doesn't break them.
   ================================================================ */

/** Find a cell matching one of `names` in the first few rows; returns {row, col}. */
function findAnchor(grid, names, maxRows = 8) {
  const want = names.map(n => n.toLowerCase());
  for (let r = 0; r < Math.min(maxRows, grid.length); r++) {
    const row = grid[r] || [];
    for (let c = 0; c < row.length; c++) {
      const v = String(row[c] || '').trim().toLowerCase();
      if (v && want.includes(v)) return { row: r, col: c };
    }
  }
  return null;
}

/** Yahoo pastes carry invisible icon glyphs and trailing interface text. */
function stripYahooChrome(raw) {
  let s = String(raw || '').split('\n')[0];
  s = s.replace(/[-]/g, '');
  s = s.split(/Video Forecast|No new player Notes|New Player Note|Player Note|Notes?\b/)[0];
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * A roster cell reads "Zay FlowersQ" or "Zach CharbonnetPUP-R" — the status
 * flag is glued to the surname with no separator. Peel the known ones off.
 */
function stripStatusSuffix(name) {
  return String(name || '')
    // Case-sensitive on purpose. Yahoo writes these flags in capitals, so
    // demanding capitals is what stops a real name that ends in a lowercase
    // letter from being eaten: "Sam Darnold" keeps its "d" and "C.J. Stroud"
    // keeps its "d", while "Zay FlowersQ" still loses its "Q".
    .replace(/(PUP-R|IR-R|NFI-R|SUSP|GTD|CEL|IR|PUP|NA|O|Q|D)$/, (m, _g, off) => {
      // Strip only where the flag is glued onto the end of a name, which
      // means the character before it is a lowercase letter — or a period,
      // for the suffixed names: "Travis Etienne Jr.IR", "Marvin Harrison Jr.O".
      const prev = name[off - 1];
      if (!prev) return m;
      return /[a-z.]/.test(prev) ? '' : m;
    })
    .trim();
}

/** "Malik Washington Mia - WR" -> "Malik Washington" */
function stripNflTeamSuffix(raw) {
  return String(raw || '')
    .replace(/\s+[A-Za-z]{2,3}\s+-\s+[A-Z/]+\b.*$/, '')
    .trim();
}

/** Team Key tab: Yahoo team name -> owner. */
function readTeamKey(grid) {
  const map = new Map();
  for (const row of grid) {
    const team = String((row || [])[0] || '').trim();
    const owner = String((row || [])[1] || '').trim();
    if (!team || !owner) continue;
    // Skip the header row, whichever wording it uses.
    if (/^(yahoo )?team( name)?$/i.test(team)) continue;
    map.set(team.toLowerCase(), canonOwner(owner));
  }
  return map;
}

/* ----------------------------------------------------------------
   A WORD ON WHAT GOOGLE ACTUALLY SENDS

   The CSV feed types each column by majority vote. In a column that is
   mostly numbers — Rank, PF, PA — any text cell comes back EMPTY. So the
   headings "Standings" and "Rank" never arrive, and a reader that looks
   for them finds nothing and quietly shows the placeholder instead.

   Both readers below therefore locate their block by the shape of the
   data itself, which no amount of column typing can hide: a run of
   W-L-T records for the standings, a column of position codes for the
   rosters. Headings are used only as an optional hint.
   ---------------------------------------------------------------- */

const RECORD_RE = /^\d{1,2}-\d{1,2}(-\d{1,2})?$/;

/** The column holding the longest run of W-L-T records, and where it starts. */
function findRecordColumn(grid) {
  const width = grid.reduce((m, r) => Math.max(m, (r || []).length), 0);
  let best = null;

  for (let c = 0; c < width; c++) {
    let run = 0, start = -1;
    for (let r = 0; r < grid.length; r++) {
      if (RECORD_RE.test(cell(grid, r, c))) {
        if (run === 0) start = r;
        run++;
        if (!best || run > best.run) best = { col: c, start, run };
      } else if (run) {
        run = 0;
      }
    }
  }
  // Six is the floor: fewer than that is a trade note or a stray score,
  // not a league table.
  return best && best.run >= 6 ? best : null;
}

/**
 * Standings block, pasted from Yahoo. Yahoo's layout is fixed —
 *   Rank | Team | W-L-T | PF | PA | Streak | Waiver | Moves
 * — so once the record column is found the rest are known by offset. Any
 * headings that did survive the feed are honoured over the offsets, in case
 * the block was ever rearranged.
 */
function readStandings(grid, teamKey) {
  const found = findRecordColumn(grid);
  if (!found) return [];

  const col = {
    rank:   found.col - 2,
    team:   found.col - 1,
    record: found.col,
    pf:     found.col + 1,
    pa:     found.col + 2,
    streak: found.col + 3,
    waiver: found.col + 4,
    moves:  found.col + 5
  };

  // Headings, where they made it through, take precedence.
  for (let r = Math.max(0, found.start - 3); r < found.start; r++) {
    const row = grid[r] || [];
    for (let c = Math.max(0, found.col - 3); c < Math.min(row.length, found.col + 9); c++) {
      const h = String(row[c] || '').trim().toLowerCase();
      if (h === 'rank') col.rank = c;
      else if (h === 'team') col.team = c;
      else if (h === 'w-l-t' || h === 'record' || h === 'w-l') col.record = c;
      else if (h === 'pf' || h === 'points for') col.pf = c;
      else if (h === 'pa' || h === 'points against') col.pa = c;
      else if (h === 'streak') col.streak = c;
      else if (h === 'waiver') col.waiver = c;
      else if (h === 'moves') col.moves = c;
    }
  }

  const out = [];
  for (let r = found.start; r < grid.length; r++) {
    const rec = cell(grid, r, col.record);
    if (!RECORD_RE.test(rec)) {
      if (out.length) break;        // block has ended
      continue;
    }
    const teamName = cell(grid, r, col.team);
    if (!teamName) continue;
    const [w, l, t] = rec.split('-').map(n => Number(n) || 0);

    out.push({
      rank: Number(cell(grid, r, col.rank)) || out.length + 1,
      teamName,
      owner: teamKey.get(teamName.toLowerCase()) || teamName,
      record: rec,
      wins: w || 0, losses: l || 0, ties: t || 0,
      pointsFor: Number(cell(grid, r, col.pf)) || 0,
      pointsAgainst: Number(cell(grid, r, col.pa)) || 0,
      streak: cell(grid, r, col.streak),
      waiverPriority: Number(cell(grid, r, col.waiver)) || null,
      moves: Number(cell(grid, r, col.moves)) || null
    });
    if (out.length >= 20) break;
  }
  return out;
}

/**
 * Rosters block. Twelve teams of "Pos | Player", separated by blank rows.
 * Yahoo's paste carries no team name, so each block's owner is worked out
 * from the players in it — see attributeRosterBlocks. An owner name typed
 * into the blank row above a block is honoured first.
 */
const POSITION_CODES = new Set([
  'QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'D/ST', 'DST', 'BN', 'IR', 'IR+',
  'W/R/T', 'W/R', 'R/W/T', 'FLEX', 'Q/W/R/T', 'OP', 'SUPERFLEX'
]);

/**
 * The column that is mostly position codes, and the first row one appears
 * in. A roster paste has well over a hundred of them; nothing else on the
 * tab comes close.
 */
function findPositionColumn(grid) {
  const width = grid.reduce((m, r) => Math.max(m, (r || []).length), 0);
  let best = null;

  for (let c = 0; c < width; c++) {
    let hits = 0, nonEmpty = 0, first = -1;
    for (let r = 0; r < grid.length; r++) {
      const v = cell(grid, r, c).toUpperCase();
      if (!v) continue;
      nonEmpty++;
      if (POSITION_CODES.has(v)) {
        hits++;
        if (first === -1) first = r;
      }
    }
    if (hits >= 40 && hits >= nonEmpty * 0.6 && (!best || hits > best.hits)) {
      best = { col: c, first, hits };
    }
  }
  return best;
}

function readRosterBlocks(grid) {
  const found = findPositionColumn(grid);
  if (!found) return [];

  const posCol = found.col;
  const nameCol = found.col + 1;

  const blocks = [];
  let current = null;
  let pendingLabel = '';

  // Start one row above the first position code so a hand-typed owner label
  // sitting directly over the first block is still picked up.
  for (let r = Math.max(0, found.first - 1); r < grid.length; r++) {
    const pos = cell(grid, r, posCol);
    const raw = cell(grid, r, nameCol);

    if (!pos && !raw) {              // blank row: block boundary
      if (current && current.players.length) blocks.push(current);
      current = null;
      continue;
    }

    // a lone cell in the position column is a hand-typed owner label —
    // unless it's the block's own heading, or a stray position code
    if (pos && !raw) {
      const p = pos.toUpperCase();
      pendingLabel = (p === 'ROSTERS' || p === 'ROSTER' || p === 'POS' || POSITION_CODES.has(p))
        ? '' : pos;
      continue;
    }

    const player = stripStatusSuffix(stripYahooChrome(raw));
    if (!player) continue;

    // The cell's first line ends "<NFL team> - <position>", e.g. "Buf - RB".
    // That's the player's real position, as opposed to the roster slot he's
    // sitting in (BN, IR, W/R/T), which is what the position column holds.
    // No word boundary before the team code: Yahoo glues it straight onto
    // the preceding label ("Player NoteNE - QB"), so look for a capital
    // letter starting a 2-3 letter code right before the dash instead.
    const tail = String(raw).split('\n')[0]
      .match(/([A-Z][A-Za-z]{1,2})\s*-\s*(QB|RB|WR|TE|K|DEF|D\/ST|DST)(?![A-Za-z])/);
    const position = tail ? tail[2].toUpperCase().replace('D/ST', 'DEF').replace('DST', 'DEF') : null;
    const nflTeam = tail ? tail[1].toUpperCase() : null;

    // Yahoo lists each team starting at its QB slot, and a team has exactly
    // one. So a second QB slot means the next team has begun — which is the
    // only reliable boundary when two rosters are pasted with no blank row
    // between them, as Google's copy of the sheet turned out to have.
    const slot = pos.toUpperCase();
    if (current && slot === 'QB' && current.players.some(p => p.pos === 'QB')) {
      blocks.push(current);
      current = null;
    }

    if (!current) { current = { label: pendingLabel, players: [] }; pendingLabel = ''; }
    current.players.push({ pos: slot, player, position, nflTeam });
  }
  if (current && current.players.length) blocks.push(current);

  return blocks;
}

/**
 * Work out whose roster each block is. Two independent signals:
 * the declared keepers, and who added each player in the activity log.
 * They're cross-checked, and any disagreement is reported rather than
 * silently resolved.
 */
function attributeRosterBlocks(blocks, declaredKeepers, activity) {
  const addedBy = new Map();
  for (const t of activity) {
    if (t.action === 'drop') continue;
    const k = norm(t.player);
    if (!addedBy.has(k)) addedBy.set(k, new Map());
    const m = addedBy.get(k);
    m.set(t.owner, (m.get(t.owner) || 0) + 1);
  }

  const conflicts = [];
  const used = new Set();

  const result = blocks.map((block, i) => {
    if (block.label) return { ...block, owner: canonOwner(block.label), basis: 'label' };

    const names = block.players.map(p => norm(p.player));

    // signal 1 — declared keepers sitting on this roster
    const keeperVotes = new Map();
    for (const row of declaredKeepers) {
      for (const k of row.keepers) {
        if (names.some(n => samePlayer(n, k.player))) {
          keeperVotes.set(row.owner, (keeperVotes.get(row.owner) || 0) + 1);
        }
      }
    }

    // signal 2 — players this owner is logged as having added
    const activityVotes = new Map();
    for (const n of names) {
      const m = addedBy.get(n);
      if (!m) continue;
      for (const [owner, count] of m) {
        activityVotes.set(owner, (activityVotes.get(owner) || 0) + count);
      }
    }

    const best = m => [...m.entries()].sort((a, b) => b[1] - a[1])[0];
    const kTop = best(keeperVotes);
    const aTop = best(activityVotes);

    if (kTop && aTop && kTop[0] !== aTop[0]) {
      conflicts.push(`roster block ${i + 1}: keepers say ${kTop[0]}, activity says ${aTop[0]}`);
    }

    const owner = (kTop && kTop[0]) || (aTop && aTop[0]) || '';
    return {
      ...block,
      owner,
      basis: kTop ? 'keepers' : aTop ? 'activity' : 'unknown'
    };
  });

  result.forEach(b => { if (b.owner) used.add(b.owner); });
  return { blocks: result, conflicts };
}

/**
 * Activity tab — the Yahoo transaction page pasted in, one cell per line.
 * Each transaction ends with a "logo" line, so that's the delimiter. Within
 * a block the shape is: icons, then player/source pairs, then the team name,
 * then the timestamp.
 */
function readActivity(grid, teamKey) {
  const lines = [];
  for (const row of grid) {
    for (const v of (row || [])) {
      const s = String(v || '').trim();
      if (s) lines.push(s);
    }
  }
  if (!lines.length) return [];

  const isIcon = s => /^[-]+$/.test(s);
  const isLogo = s => s.toLowerCase() === 'logo';
  const isDate = s => /^[A-Z][a-z]{2}\s+\d{1,2},/.test(s);
  const CAME_FROM = new Set(['free agent', 'waiver', 'waivers']);
  const WENT_TO = new Set(['to waivers', 'to free agent', 'to free agents']);

  const chunks = [];
  let cur = [];
  for (const line of lines) {
    if (isLogo(line)) { if (cur.length) chunks.push(cur); cur = []; }
    else cur.push(line);
  }
  if (cur.length) chunks.push(cur);

  const out = [];

  for (const chunk of chunks) {
    const teamLine = chunk.find(x => teamKey.has(x.toLowerCase()));
    const owner = teamLine ? teamKey.get(teamLine.toLowerCase()) : '';
    const dateLine = chunk.find(isDate) || '';
    if (!owner) continue;

    const body = chunk.filter(x =>
      !isIcon(x) && x !== teamLine && x !== dateLine);

    /* A trade lists every asset going one way, THEN "Traded to", then the
       team receiving them. Yahoo's paste can split one trade across chunks,
       so each chunk is handled as its own one-way leg. */
    const tradeAt = body.findIndex(x => x.toLowerCase() === 'traded to');
    if (tradeAt !== -1) {
      for (const asset of body.slice(0, tradeAt)) {
        if (CAME_FROM.has(asset.toLowerCase()) || WENT_TO.has(asset.toLowerCase())) continue;
        out.push({
          owner, date: dateLine, action: 'trade',
          player: stripNflTeamSuffix(asset),
          source: 'trade', acquisition: 'trade',
          isPick: /^(round|rd)\s*\d+/i.test(asset)
        });
      }
      continue;
    }

    for (let i = 0; i < body.length; i++) {
      const item = body[i];
      const next = (body[i + 1] || '').toLowerCase();

      if (CAME_FROM.has(item.toLowerCase()) || WENT_TO.has(item.toLowerCase())) continue;

      if (CAME_FROM.has(next)) {
        out.push({
          owner, date: dateLine, action: 'add',
          player: stripNflTeamSuffix(item),
          source: body[i + 1],
          acquisition: 'waiver',
          isPick: false
        });
        i++;
        continue;
      }

      if (WENT_TO.has(next)) {
        out.push({
          owner, date: dateLine, action: 'drop',
          player: stripNflTeamSuffix(item),
          source: body[i + 1],
          acquisition: null,
          isPick: false
        });
        i++;
        continue;
      }
    }
  }

  // newest first is how Yahoo pastes it; keep that order and add an index
  return out.map((t, i) => ({ ...t, seq: out.length - i }));
}

/* ---------------------------------------------------------------- */
/* The keeper rules                                                 */
/* ---------------------------------------------------------------- */

/**
 * SIMPLIFIED KEEPER COSTS (adopted by league vote)
 *
 * The whole rule is two questions:
 *   1. Is he on your roster right now?
 *   2. Did you draft him, or did you trade for him?
 * Both yes -> keeper. That's it. Nothing in between counts, so dropping a
 * player you drafted and picking him back up later does NOT cost you his
 * keeper rights. Only a player who was never yours by draft or trade — a
 * straight waiver or free-agent pickup — goes back into the pool.
 *
 * 1. Cost = one round earlier than where he was originally drafted
 * 2. Drafted in round 1 -> not keepable (overrides everything below)
 * 3. Already kept two seasons -> not keepable
 * 4. Acquired by trade -> keepable, priced off the ORIGINAL draft round
 * 5. Never drafted by you and never traded for -> not keepable
 */
function computeKeeperCosts({ rosters, draft, inSeasonTrades, exhausted }) {
  const draftIndex = draft.map(d => ({ ...d, n: norm(d.player) }));

  // Flagged rather than guessed at: a player acquired by trade whom nobody
  // drafted has no round to price off. Surfaced so it can be ruled on.
  const noCostBasis = [];

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

  // Used only for the odd case of trading for a player nobody drafted, who
  // therefore has no round to price off. Pricing him at the last round keeps
  // him keepable without inventing a bargain.
  const lastRound = draft.reduce((m, d) => Math.max(m, Number(d.round) || 0), 0) || 14;

  const out = rosters.map(r => {
    const hit = draftIndex.find(d => samePlayer(d.player, r.player));
    // The transaction log, where it exists, is the authority on how a player
    // arrived. It beats inference from the trade blocks, because it records
    // waiver pickups too — which the trade log never will.
    const wasTraded = r.acquisition === 'trade'
      || (!r.acquisition && tradedNames.some(n => samePlayer(n, r.player)));
    const isExhausted = exhausted.some(
      e => e.owner === r.owner && samePlayer(e.player, r.player)
    );

    /* ----------------------------------------------------------------
       THE SIMPLIFIED KEEPER RULE, as the league voted it.

       Two questions, and nothing else:
         1. Is he on your roster right now?
         2. Did you draft him, or did you trade for him?

       Both yes and he's a keeper. Question 1 is answered just by being
       in this list, since it's built from the current rosters.

       The point of "simplified" is that nothing in between matters. A
       player you drafted, dropped in October and picked back up in
       December is still a player you drafted, so question 2 is still
       yes and he's still keepable at his draft cost. Only a player who
       was never yours by draft or trade goes back to the pool.
       ---------------------------------------------------------------- */

    const youDraftedHim  = !!hit && hit.owner === r.owner;
    const youTradedForHim = !youDraftedHim && wasTraded;

    let cost, status, reason = null;

    if (youDraftedHim) {
      cost = Math.max(1, hit.round - 1);
      // Worth showing on the row that he left and came back, since it looks
      // like a waiver guy at a glance but prices as a drafted one.
      status = r.acquisition === 'waiver'
        ? `Drafted Rd${hit.round}, dropped and re-added`
        : 'Same team';
    } else if (youTradedForHim && hit) {
      cost = Math.max(1, hit.round - 1);
      status = `Traded (orig. Rd${hit.round} by ${hit.owner})`;
    } else if (youTradedForHim) {
      // traded for, but nobody drafted him, so there's no round to price off
      cost = lastRound;
      status = 'Traded, undrafted';
      noCostBasis.push(`${r.owner}: ${r.player} (traded for, never drafted)`);
    } else if (!hit) {
      // never drafted by anyone and never traded — a free-agent add
      cost = 0;
      status = 'Undrafted';
      reason = 'waiver pickup';
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
      acquisition: r.acquisition || null,
      acquiredFrom: r.acquiredFrom || null,
      status,
      costRound: cost,
      costLabel: cost === 0 ? 'N/A' : ordinal(cost),
      reason
    };
  });

  // Carried along on the array so the caller can report it without the
  // return shape changing for everything that already reads these rows.
  out.noCostBasis = noCostBasis;
  return out;
}

/* ---------------------------------------------------------------- */
/* Main                                                             */
/* ---------------------------------------------------------------- */

async function loadLeagueData(sheetId, opts = {}) {
  const fresh = Date.now() - cache.at < CACHE_MINUTES * 60 * 1000;
  if (fresh && cache.data && !opts.force) return cache.data;

  // The last two are optional: they're pasted in by hand, and the site
  // simply does less when they aren't there yet. A CSV committed next to the
  // code wins over a sheet tab of the same name.
  const localTeamKey = readLocalTab('team-key.csv');
  const localActivity = readLocalTab('activity.csv');

  const [cur, prev, prev2, teamKeyTab, activityTab] = await Promise.all([
    fetchTab(sheetId, '2026-2027'),
    fetchTab(sheetId, '2025-2026'),
    fetchTab(sheetId, '2024-2025').catch(() => []),
    localTeamKey || fetchTab(sheetId, 'Team Key').catch(() => []),
    localActivity || fetchTab(sheetId, 'Activity').catch(() => [])
  ]);

  const teamKeySource = localTeamKey ? 'team-key.csv (repo)' : 'Team Key tab (sheet)';
  const activitySource = localActivity ? 'activity.csv (repo)' : 'Activity tab (sheet)';

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

  /* ---- The league's own data, in place of the Yahoo API --------- */
  const teamKey = readTeamKey(teamKeyTab);
  const activity = readActivity(activityTab, teamKey);

  // player moves only; traded draft picks are shown but don't change a roster
  const transactions = activity.filter(t => !t.isPick);

  const standings = readStandings(cur, teamKey);
  const pickTradesFromActivity = activity.filter(t => t.isPick);

  /* Rosters pasted from Yahoo carry no team name, so each block is attributed
     from the players in it, cross-checking keepers against the activity log. */
  const rosterBlocks = readRosterBlocks(cur);
  let attribution = { blocks: [], conflicts: [] };
  let sheetRosters = [];

  if (rosterBlocks.length) {
    attribution = attributeRosterBlocks(rosterBlocks, declared, transactions);
    for (const b of attribution.blocks) {
      if (!b.owner) continue;
      for (const p of b.players) {
        sheetRosters.push({
          owner: b.owner, pos: p.pos, player: p.player,
          position: p.position || null, nflTeam: p.nflTeam || null
        });
      }
    }
  }

  /* A pasted roster is today's truth, so it wins over the draft board.
     Each player still needs to know HOW he arrived, because under Simplified
     Keeper Costs that decides whether he can be kept at all. */
  if (sheetRosters.length) {
    const draftedBy = new Map();
    for (const p of costDraft) draftedBy.set(norm(p.player), p.owner);

    const tradedTo = new Map();
    for (const t of transactions) {
      if (t.action === 'trade') tradedTo.set(norm(t.player), t.owner);
    }

    displayRosters = sheetRosters.map(r => {
      const key = norm(r.player);
      const drafter = [...draftedBy.entries()]
        .find(([k]) => samePlayer(k, r.player));
      const tradedHere = [...tradedTo.entries()]
        .find(([k, owner]) => owner === r.owner && samePlayer(k, r.player));

      let acquisition;
      if (drafter && drafter[1] === r.owner) acquisition = 'draft';
      else if (tradedHere) acquisition = 'trade';
      else if (drafter) acquisition = 'waiver';     // drafted elsewhere, now here
      else acquisition = 'waiver';                  // never drafted at all

      return { ...r, acquisition, round: null, pick: null };
    });

    displayRosterSeason = '2026-2027';
    rosterBasis = 'pasted Yahoo rosters';
  }

  const costRostersFinal = sheetRosters.length ? displayRosters : costRosters;

  const keeperCosts = computeKeeperCosts({
    rosters: costRostersFinal,
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
      standingsRows: standings.length,
      activityRows: activity.length,
      rosterBlocks: rosterBlocks.length,
      rosterAttribution: attribution.blocks.map(b =>
        `${b.owner || '(unidentified)'} — ${b.players.length} players, via ${b.basis}`),
      rosterConflicts: attribution.conflicts,
      teamKeyEntries: teamKey.size,
      keeperCostBasis: `${costSeason} draft + current rosters`,
      keeperCostSeason: costSeason,
      inSeasonTradesLogged: inSeasonPrev.length,
      notFoundOnDraftBoard: unmatched,
      teamKeySource,
      activitySource,
      keeperNoCostBasis: keeperCosts.noCostBasis || [],
      keepersEligible: keeperCosts.filter(k => k.costRound > 0).length,
      keepersBackToPool: keeperCosts.filter(k => k.costRound === 0).length,
      keepersDroppedAndReadded:
        keeperCosts.filter(k => /dropped and re-added/.test(k.status || '')).length,
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

    // the league's own log, standing in for the Yahoo API
    standings,
    transactions,
    activity,
    pickTradesFromActivity,

    exhausted,
    tradeSections: [
      { season: '2026-2027', label: 'Preseason Trades', trades: preseasonCur },
      { season: '2026-2027', label: '2027 In-Season Trades', trades: inSeasonCur },
      { season: '2025-2026', label: 'Preseason Trades', trades: preseasonPrev },
      { season: '2025-2026', label: '2026 In-Season Trades', trades: inSeasonPrev }
    ],
    outstandingPicks: outstandingPicks(
      [preseasonCur, inSeasonCur, preseasonPrev, inSeasonPrev].flat(),
      pickTradesFromActivity,
      2027
    )
  };

  cache = { at: Date.now(), data };
  return data;
}

/* ----------------------------------------------------------------
   OUTSTANDING PICKS

   What everyone actually wants to know from the trade log: whose picks
   does each owner hold going into the next drafts, and which of their
   own are gone. Only picks for drafts that haven't happened yet count —
   anything from a draft already held is history.

   The sheet re-lists a running trade on each new season's tab, so the
   same 2027 pick can appear twice. Everything is reduced to single
   (year, round, from, to) facts first, which collapses the repeats.
   ---------------------------------------------------------------- */

function roundNumber(item) {
  const m = String(item || '').match(/(\d{1,2})/);
  return m ? Number(m[1]) : null;
}

function outstandingPicks(trades, activityPicks, fromYear) {
  const facts = new Map();     // key -> { year, round, from, to }

  const add = (year, round, from, to) => {
    if (!year || !round || !from || !to || from === to) return;
    if (Number(year) < fromYear) return;
    const key = `${year}|${round}|${from}|${to}`;
    if (!facts.has(key)) facts.set(key, { year: Number(year), round, from, to });
  };

  // Sheet trade blocks: "<owner> Get" lists what that side receives, and in
  // a two-party trade it comes from the other side.
  for (const t of trades) {
    if (!t || !t.a || !t.b) continue;
    for (const asset of t.a.assets || []) {
      const round = roundNumber(asset.item);
      if (round && !/[A-Za-z]{3,}/.test(String(asset.item).replace(/^(rd|round)\s*/i, ''))) {
        add(asset.year, round, t.b.owner, t.a.owner);
      }
    }
    for (const asset of t.b.assets || []) {
      const round = roundNumber(asset.item);
      if (round && !/[A-Za-z]{3,}/.test(String(asset.item).replace(/^(rd|round)\s*/i, ''))) {
        add(asset.year, round, t.a.owner, t.b.owner);
      }
    }
  }

  // Yahoo's log says who received a pick but not who sent it. Pair the two
  // legs of each trade by timestamp: everyone else in the same trade is the
  // counterparty. A pick traded during the season is for the next draft.
  const byDate = new Map();
  for (const p of activityPicks || []) {
    if (!byDate.has(p.date)) byDate.set(p.date, []);
    byDate.get(p.date).push(p);
  }
  for (const legs of byDate.values()) {
    const owners = [...new Set(legs.map(l => l.owner))];
    if (owners.length !== 2) continue;       // can't tell who sent what
    for (const leg of legs) {
      const from = owners.find(o => o !== leg.owner);
      add(fromYear, roundNumber(leg.player), from, leg.owner);
    }
  }

  // Shape it per owner per year.
  const owners = new Map();
  const bucket = (owner, year) => {
    if (!owners.has(owner)) owners.set(owner, new Map());
    const byYear = owners.get(owner);
    if (!byYear.has(year)) byYear.set(year, { gets: [], gives: [] });
    return byYear.get(year);
  };
  for (const f of facts.values()) {
    bucket(f.to, f.year).gets.push({ round: f.round, from: f.from });
    bucket(f.from, f.year).gives.push({ round: f.round, to: f.to });
  }

  const byRound = (a, b) => a.round - b.round;
  return [...owners.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([owner, byYear]) => ({
      owner,
      years: [...byYear.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([year, v]) => ({
          year,
          gets: v.gets.sort(byRound),
          gives: v.gives.sort(byRound),
          net: v.gets.length - v.gives.length
        }))
    }));
}

module.exports = { loadLeagueData, parseCSV, samePlayer, ordinal, canonOwner,
                   OWNER_ALIASES, editDistanceAtMost, outstandingPicks };
