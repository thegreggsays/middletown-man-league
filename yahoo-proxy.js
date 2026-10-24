/**
 * Middletown Man League — Yahoo Fantasy proxy + transaction logger
 * ==================================================================
 * Yahoo's Fantasy API uses OAuth2 and sends no CORS headers, so the
 * site can't call it directly. This server holds the credentials,
 * talks to Yahoo, and serves the site clean JSON.
 *
 * It also POLLS Yahoo on a timer and writes every add, drop and trade
 * into a local SQLite file. That archive is the point: Yahoo only
 * exposes a rolling window of recent transactions, so anything not
 * captured is gone for good. Once this is running, history accrues
 * on its own and survives seasons.
 *
 * SETUP
 *   npm init -y
 *   npm install express cors dotenv node-fetch@2 better-sqlite3
 *
 *   .env:
 *     YAHOO_CLIENT_ID=...
 *     YAHOO_CLIENT_SECRET=...
 *     YAHOO_REDIRECT_URI=https://your-server.com/auth/callback
 *     LEAGUE_KEYS=nfl.l.111111,nfl.l.222222   # one per season, oldest first
 *     POLL_MINUTES=15
 *     PORT=3000
 *
 *   node yahoo-proxy.js
 *   Visit /auth/start once to authorize. Token refresh is automatic after that.
 *
 *   This server also serves index.html, so the website and its data come from
 *   one address. In index.html set:  const API_BASE = '';
 *
 * ENDPOINTS
 *   GET  /activity?limit=&type=&owner=&season=   normalized transaction feed
 *   GET  /activity/stats                         per-owner counts
 *   POST /activity/sync                          force a poll right now
 *   GET  /news                                   fantasy news, merged + fetched server-side
 *   GET  /announcement                           the pinned announcement
 *   POST /announcement                           overwrite it (needs the code)
 *   GET  /dues                                   who's paid, pot totals, payouts
 *   POST /dues                                   record a payment (needs the code)
 *   GET  /marc-rankings                          Marc's ranking images
 *   POST /marc-rankings                          upload one (needs the code)
 *   GET  /rosters                                rosters for the parlay dropdown
 *   GET  /parlay?week=N                          weekly TD picks + who has scored
 *   POST /parlay                                 submit or change a pick
 *   GET  /votes                                  rule-change proposals + tallies
 *   POST /votes/proposal                         new proposal (needs the code)
 *   POST /votes/:id/cast                         cast a vote (one per owner)
 *   GET  /board                                  message board posts (auto-purged at 6 months)
 *   POST /board                                  new post
 *   GET  /league-data                            keepers, costs, draft, trades from the Sheet
 *   GET  /power                                  projection-averaged power rankings
 *   GET  /history                                champions + lifetime records
 *   GET  /standings                              current season standings
 *   GET  /health                                 status
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { loadLeagueData } = require('./league-sheet');

const app = express();
app.use(cors());
app.use(express.json({ limit: '8mb' }));   // Marc's rankings are images

// Serve the website itself. Because the site and the data live on the same
// server, the browser treats them as one thing — no cross-origin setup needed.
//
// Only index.html is served, deliberately. A blanket static mount on this
// folder would also hand out league.db, the Yahoo token file and the server
// source to anyone who guessed the filename, since they all sit right here.
app.get(['/', '/index.html'], (_req, res) =>
  res.sendFile(path.join(__dirname, 'index.html')));

// The phone version — same server, same data, laid out for a thumb.
app.get(['/m', '/mobile', '/mobile.html'], (_req, res) =>
  res.sendFile(path.join(__dirname, 'mobile.html')));

const BASE = 'https://fantasysports.yahooapis.com/fantasy/v2';

/* ================================================================
   WHERE DATA LIVES

   Railway rebuilds the container from the repo on every deploy, so
   anything written inside the app folder is gone the moment new code
   ships. The database and the Yahoo tokens therefore live in DATA_DIR,
   which points at a mounted volume in production.

   With DATA_DIR unset this falls back to the app folder, which still
   works fine for running locally — it just doesn't survive a deploy.
   ================================================================ */

const DATA_DIR = process.env.DATA_DIR || __dirname;
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (e) {
  console.error('[data] could not create ' + DATA_DIR + ': ' + e.message);
}

const TOKEN_FILE = path.join(DATA_DIR, '.tokens.json');
const LEAGUE_KEYS = (process.env.LEAGUE_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
const POLL_MINUTES = Number(process.env.POLL_MINUTES || 15);

/* ================================================================
   DATABASE
   ================================================================ */

const DB_FILE = path.join(DATA_DIR, 'league.db');

// If a database was committed to the repo, or left in the app folder from
// before DATA_DIR existed, take it over to the volume on first boot.
//
// Worth being clear about what this does NOT cover: a host that rebuilds the
// container from the repo throws the old container's disk away, so a database
// that only ever lived there is already gone by the time this runs. Carrying
// data across a move onto a volume means /backup first and /restore after.
try {
  const legacy = path.join(__dirname, 'league.db');
  if (DATA_DIR !== __dirname && fs.existsSync(legacy) && !fs.existsSync(DB_FILE)) {
    fs.copyFileSync(legacy, DB_FILE);
    console.log('[data] carried a database found in the app folder over to ' + DB_FILE);
  }
} catch (e) {
  console.error('[data] could not carry the old database over: ' + e.message);
}

// A restore staged by the previous boot is swapped in here, before anything
// opens the database — doing it at startup avoids replacing a file that has
// live connections against it.
try {
  const staged = DB_FILE + '.restore';
  if (fs.existsSync(staged)) {
    // Drop the live database's journal files first: they describe the old
    // database and must not be read against the incoming one.
    for (const suffix of ['-wal', '-shm']) {
      try { fs.unlinkSync(DB_FILE + suffix); } catch (e) { /* not there */ }
    }
    fs.renameSync(staged, DB_FILE);
    // The staged copy picks up journals of its own when it gets checked on
    // upload, and those are stale the moment it is renamed.
    for (const suffix of ['-wal', '-shm']) {
      try { fs.unlinkSync(staged + suffix); } catch (e) { /* not there */ }
    }
    console.log('[data] restored the database from an uploaded backup');
  }
} catch (e) {
  console.error('[data] could not apply the staged restore: ' + e.message);
}

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
console.log('[data] database: ' + DB_FILE);

db.exec(`
  CREATE TABLE IF NOT EXISTS transactions (
    transaction_key TEXT PRIMARY KEY,
    league_key      TEXT NOT NULL,
    season          TEXT,
    type            TEXT NOT NULL,      -- add / drop / add-drop / trade / commish
    status          TEXT,
    timestamp       INTEGER NOT NULL,   -- unix seconds, from Yahoo
    logged_at       INTEGER NOT NULL,   -- when we first saw it
    raw             TEXT NOT NULL       -- full Yahoo payload, kept for reprocessing
  );

  CREATE TABLE IF NOT EXISTS moves (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_key TEXT NOT NULL,
    player_key      TEXT,
    player_name     TEXT,
    position        TEXT,
    nfl_team        TEXT,
    action          TEXT,               -- add / drop
    source          TEXT,               -- waivers / freeagents / team name
    destination     TEXT,               -- team name / waivers / freeagents
    owner           TEXT,               -- the manager this move belongs to
    FOREIGN KEY (transaction_key) REFERENCES transactions(transaction_key)
  );

  CREATE TABLE IF NOT EXISTS posts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    author     TEXT NOT NULL,
    body       TEXT NOT NULL,
    reply_to   INTEGER,
    created_at INTEGER NOT NULL      -- unix seconds
  );

  CREATE TABLE IF NOT EXISTS announcement (
    id         INTEGER PRIMARY KEY CHECK (id = 1),   -- only ever one row
    body       TEXT NOT NULL,
    author     TEXT,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS proposals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    body        TEXT,
    author      TEXT,
    created_at  INTEGER NOT NULL,
    closed_at   INTEGER
  );

  CREATE TABLE IF NOT EXISTS votes (
    proposal_id INTEGER NOT NULL,
    owner       TEXT NOT NULL,
    choice      TEXT NOT NULL,          -- yes | no
    cast_at     INTEGER NOT NULL,
    PRIMARY KEY (proposal_id, owner)    -- one vote per owner, enforced here
  );

  CREATE TABLE IF NOT EXISTS parlay_picks (
    season     INTEGER NOT NULL,
    week       INTEGER NOT NULL,
    owner      TEXT NOT NULL,
    player     TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (season, week, owner)      -- one pick per owner per week
  );

  CREATE INDEX IF NOT EXISTS idx_parlay ON parlay_picks(season, week);

  CREATE TABLE IF NOT EXISTS marc_rankings (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    week       INTEGER,
    caption    TEXT,
    mime       TEXT NOT NULL,
    data       TEXT NOT NULL,        -- base64 image
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_marc ON marc_rankings(created_at DESC);

  CREATE TABLE IF NOT EXISTS dues (
    season     INTEGER NOT NULL,
    owner      TEXT NOT NULL,
    paid       REAL NOT NULL DEFAULT 0,
    note       TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (season, owner)
  );

  CREATE TABLE IF NOT EXISTS weekly_winners (
    season     INTEGER NOT NULL,
    week       INTEGER NOT NULL,
    owner      TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (season, week)
  );

  CREATE INDEX IF NOT EXISTS idx_posts_time ON posts(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_posts_reply ON posts(reply_to);

  CREATE INDEX IF NOT EXISTS idx_tx_time   ON transactions(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_tx_season ON transactions(season);
  CREATE INDEX IF NOT EXISTS idx_mv_owner  ON moves(owner);
  CREATE INDEX IF NOT EXISTS idx_mv_tx     ON moves(transaction_key);
`);

const insertTx = db.prepare(`
  INSERT OR IGNORE INTO transactions
    (transaction_key, league_key, season, type, status, timestamp, logged_at, raw)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertMove = db.prepare(`
  INSERT INTO moves
    (transaction_key, player_key, player_name, position, nfl_team, action, source, destination, owner)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const txExists = db.prepare('SELECT 1 FROM transactions WHERE transaction_key = ?');

/* ================================================================
   OAUTH
   ================================================================ */

const readTokens = () => {
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch { return null; }
};
const writeTokens = t => fs.writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2));

async function exchange(params) {
  const basic = Buffer.from(
    `${process.env.YAHOO_CLIENT_ID}:${process.env.YAHOO_CLIENT_SECRET}`
  ).toString('base64');

  const res = await fetch('https://api.login.yahoo.com/oauth2/get_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams(params)
  });

  if (!res.ok) throw new Error(`token exchange failed: ${await res.text()}`);
  const json = await res.json();
  json.expires_at = Date.now() + (json.expires_in - 60) * 1000;
  return json;
}

async function accessToken() {
  let t = readTokens();
  if (!t) throw new Error('Not authorized — visit /auth/start first.');
  if (Date.now() < t.expires_at) return t.access_token;
  t = await exchange({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
  writeTokens(t);
  return t.access_token;
}

app.get('/auth/start', (_req, res) => {
  res.redirect(
    'https://api.login.yahoo.com/oauth2/request_auth' +
    `?client_id=${encodeURIComponent(process.env.YAHOO_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(process.env.YAHOO_REDIRECT_URI)}` +
    '&response_type=code'
  );
});

app.get('/auth/callback', async (req, res) => {
  try {
    writeTokens(await exchange({
      grant_type: 'authorization_code',
      code: req.query.code,
      redirect_uri: process.env.YAHOO_REDIRECT_URI
    }));
    res.send('Authorized. Close this tab — the logger starts on the next poll.');
  } catch (e) {
    res.status(500).send('Auth failed: ' + e.message);
  }
});

/* ================================================================
   YAHOO FETCH + PARSING
   Yahoo's JSON nests arrays under numeric keys, so everything below
   defends against both array and object shapes.
   ================================================================ */

async function yahoo(pathPart) {
  const token = await accessToken();
  const res = await fetch(`${BASE}${pathPart}?format=json`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw new Error(`Yahoo ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Collapse Yahoo's array-of-fragments into one object. */
function merge(node) {
  if (Array.isArray(node)) {
    return Object.assign({}, ...node.filter(x => x && typeof x === 'object' && !Array.isArray(x)));
  }
  return node && typeof node === 'object' ? node : {};
}

/** Yahoo returns {0:{...}, 1:{...}, count:N}. Turn that into a real array. */
function numbered(node) {
  if (!node || typeof node !== 'object') return [];
  const n = Number(node.count);
  const out = [];
  for (let i = 0; i < (Number.isFinite(n) ? n : Object.keys(node).length); i++) {
    if (node[i] !== undefined) out.push(node[i]);
  }
  return out;
}

/** Pull the player rows out of one transaction. */
function parseMoves(txNode) {
  const playersNode = merge(txNode[1] || {}).players || merge(txNode).players;
  const rows = [];

  for (const entry of numbered(playersNode)) {
    const p = entry.player;
    if (!p) continue;

    const meta = merge(p[0]);
    const dataRaw = merge(p[1]).transaction_data;
    const data = Array.isArray(dataRaw) ? merge(dataRaw) : (dataRaw || {});

    const action = data.type || '';
    const source =
      data.source_team_name ||
      (data.source_type === 'freeagents' ? 'Free Agents'
        : data.source_type === 'waivers' ? 'Waivers'
        : data.source_type || '');
    const destination =
      data.destination_team_name ||
      (data.destination_type === 'waivers' ? 'Waivers'
        : data.destination_type === 'freeagents' ? 'Free Agents'
        : data.destination_type || '');

    // the manager the move belongs to: whoever received, else whoever gave up
    const owner = action === 'add'
      ? (data.destination_team_name || '')
      : (data.source_team_name || '');

    rows.push({
      player_key: meta.player_key || '',
      player_name: (meta.name && (meta.name.full || meta.name.ascii_full)) || '',
      position: meta.display_position || '',
      nfl_team: meta.editorial_team_abbr || '',
      action,
      source,
      destination,
      owner
    });
  }
  return rows;
}

/* ================================================================
   POLLER — the background logger
   ================================================================ */

let lastSync = null;
let lastError = null;

async function syncLeague(leagueKey) {
  const data = await yahoo(`/league/${leagueKey}/transactions;types=add,drop,commish,trade`);
  const leagueArr = data.fantasy_content.league;
  const leagueMeta = merge(leagueArr[0]);
  const season = String(leagueMeta.season || '');
  const txNode = merge(leagueArr[1]).transactions;

  let inserted = 0;

  const writeAll = db.transaction(items => {
    for (const item of items) {
      const txNodeRaw = item.transaction;
      if (!txNodeRaw) continue;

      const meta = merge(txNodeRaw[0]);
      const key = meta.transaction_key;
      if (!key || txExists.get(key)) continue;   // already archived — skip

      insertTx.run(
        key,
        leagueKey,
        season,
        meta.type || '',
        meta.status || '',
        Number(meta.timestamp || 0),
        Math.floor(Date.now() / 1000),
        JSON.stringify(txNodeRaw)
      );

      for (const m of parseMoves(txNodeRaw)) {
        insertMove.run(
          key, m.player_key, m.player_name, m.position,
          m.nfl_team, m.action, m.source, m.destination, m.owner
        );
      }
      inserted++;
    }
  });

  writeAll(numbered(txNode));
  return inserted;
}

async function syncAll() {
  if (!LEAGUE_KEYS.length) { lastError = 'No LEAGUE_KEYS configured.'; return 0; }
  if (!readTokens()) { lastError = 'Not authorized yet.'; return 0; }

  let total = 0;
  try {
    for (const key of LEAGUE_KEYS) total += await syncLeague(key);
    lastSync = new Date().toISOString();
    lastError = null;
    if (total) console.log(`[logger] archived ${total} new transaction(s)`);
  } catch (e) {
    lastError = e.message;
    console.error('[logger] sync failed:', e.message);
  }
  return total;
}

// run on boot, then on a timer
setTimeout(syncAll, 3000);
setInterval(syncAll, POLL_MINUTES * 60 * 1000);

/* ================================================================
   ROUTES
   ================================================================ */

app.get('/health', (_req, res) => {
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM transactions').get();
  res.json({
    ok: true,
    authorized: !!readTokens(),
    leagues: LEAGUE_KEYS.length,
    archived: c,
    lastSync,
    lastError,
    pollMinutes: POLL_MINUTES,
    sheetConfigured: !!process.env.SHEET_ID
  });
});

app.post('/activity/sync', async (_req, res) => {
  const n = await syncAll();
  res.json({ inserted: n, lastSync, lastError });
});

/**
 * Normalized feed for the site. One object per transaction, with its
 * player moves attached, newest first.
 */
app.get('/activity', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const where = [];
  const args = [];

  if (req.query.type)   { where.push('t.type = ?');   args.push(req.query.type); }
  if (req.query.season) { where.push('t.season = ?'); args.push(req.query.season); }
  if (req.query.owner)  {
    where.push('EXISTS (SELECT 1 FROM moves m2 WHERE m2.transaction_key = t.transaction_key AND m2.owner = ?)');
    args.push(req.query.owner);
  }

  const sql = `
    SELECT t.transaction_key, t.season, t.type, t.status, t.timestamp
    FROM transactions t
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY t.timestamp DESC
    LIMIT ?
  `;
  const rows = db.prepare(sql).all(...args, limit);
  const movesFor = db.prepare('SELECT * FROM moves WHERE transaction_key = ? ORDER BY id');

  res.json({
    count: rows.length,
    lastSync,
    transactions: rows.map(r => ({
      id: r.transaction_key,
      season: r.season,
      type: r.type,
      status: r.status,
      timestamp: r.timestamp,
      date: new Date(r.timestamp * 1000).toISOString(),
      moves: movesFor.all(r.transaction_key).map(m => ({
        player: m.player_name,
        position: m.position,
        nflTeam: m.nfl_team,
        action: m.action,
        source: m.source,
        destination: m.destination,
        owner: m.owner
      }))
    }))
  });
});

/** Per-owner activity counts — handy for end-of-year awards. */
app.get('/activity/stats', (req, res) => {
  const season = req.query.season;
  const rows = db.prepare(`
    SELECT m.owner,
           SUM(CASE WHEN m.action = 'add'  THEN 1 ELSE 0 END) AS adds,
           SUM(CASE WHEN m.action = 'drop' THEN 1 ELSE 0 END) AS drops,
           COUNT(DISTINCT CASE WHEN t.type = 'trade' THEN t.transaction_key END) AS trades
    FROM moves m
    JOIN transactions t ON t.transaction_key = m.transaction_key
    WHERE m.owner != '' ${season ? 'AND t.season = ?' : ''}
    GROUP BY m.owner
    ORDER BY adds DESC
  `).all(...(season ? [season] : []));
  res.json({ owners: rows });
});

/** Champions + lifetime records, walked across every configured season. */
app.get('/history', async (_req, res) => {
  try {
    if (!LEAGUE_KEYS.length) throw new Error('Set LEAGUE_KEYS in .env (one league key per season).');

    const champions = [];
    const tally = {};

    for (const key of LEAGUE_KEYS) {
      const data = await yahoo(`/league/${key}/standings`);
      const leagueArr = data.fantasy_content.league;
      const season = Number(merge(leagueArr[0]).season);
      const teamsNode = merge(merge(leagueArr[1]).standings[0]).teams;

      for (const entry of numbered(teamsNode)) {
        const team = entry.team;
        if (!team) continue;

        const info = merge(team[0]);
        const stats = merge(team[1] || {});
        const outcome = (stats.team_standings || {}).outcome_totals || {};

        const managers = info.managers || [];
        const owner = (merge(managers[0]).manager || {}).nickname || info.name || 'Unknown';

        const wins = Number(outcome.wins || 0);
        const losses = Number(outcome.losses || 0);
        const ties = Number(outcome.ties || 0);
        const rank = Number((stats.team_standings || {}).rank || 0);
        const points = Number((stats.team_points || {}).total || 0);

        tally[owner] ||= {
          owner, titles: 0, titleYears: [], wins: 0, losses: 0,
          ties: 0, playoffs: 0, pointsFor: 0, seasons: 0
        };
        const t = tally[owner];
        t.wins += wins; t.losses += losses; t.ties += ties;
        t.pointsFor += points; t.seasons += 1;
        if (rank && rank <= 6) t.playoffs += 1;   // adjust to your playoff size

        if (rank === 1) {
          t.titles += 1;
          t.titleYears.push(season);
          champions.push({
            season, owner,
            record: `${wins}-${losses}${ties ? '-' + ties : ''}`,
            points: Math.round(points)
          });
        }
      }
    }

    res.json({
      champions,
      owners: Object.values(tally).map(o => ({
        ...o,
        pointsFor: Math.round(o.pointsFor),
        titleYears: o.titleYears.sort()
      }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


/* ================================================================
   POWER RANKINGS
   Pulls season-long projections from several public sources, averages
   each player's projected points across whichever sources returned
   him, then totals each roster.

   Sources are opt-in via .env — the endpoint uses whichever it has
   keys for and reports back which ones it actually used, so the site
   never implies more consensus than it has:

     FANTASYPROS_API_KEY=...     # https://www.fantasypros.com/api-data/
     FANTASYNERDS_API_KEY=...    # https://api.fantasynerds.com/docs/nfl

   ESPN's public endpoint needs no key and is always included.
   ================================================================ */

const SCORING = process.env.SCORING || 'HALF';   // PPR | HALF | STD

/** Normalize names so the same player matches across sources. */
function nameKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/'/g, '')
    .replace(/-/g, ' ')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function projFantasyPros(season) {
  const key = process.env.FANTASYPROS_API_KEY;
  if (!key) return null;
  const res = await fetch(
    `https://api.fantasypros.com/public/v2/json/nfl/${season}/projections?scoring=${SCORING}`,
    { headers: { 'x-api-key': key } }
  );
  if (!res.ok) throw new Error(`FantasyPros ${res.status}`);
  const data = await res.json();
  const out = new Map();
  for (const p of data.players || []) {
    const pts = Number(p.fantasy_points ?? p.points ?? p.stats?.fantasy_points);
    if (Number.isFinite(pts)) out.set(nameKey(p.player_name || p.name), pts);
  }
  return out.size ? out : null;
}

async function projFantasyNerds(season) {
  const key = process.env.FANTASYNERDS_API_KEY;
  if (!key) return null;
  const res = await fetch(
    `https://api.fantasynerds.com/v1/nfl/draft-projections?apikey=${key}`
  );
  if (!res.ok) throw new Error(`FantasyNerds ${res.status}`);
  const data = await res.json();
  const rows = Array.isArray(data) ? data : (data.players || []);
  const out = new Map();
  for (const p of rows) {
    const pts = Number(p.proj_pts ?? p.projected_points ?? p.points);
    if (Number.isFinite(pts)) out.set(nameKey(p.name || p.player_name), pts);
  }
  return out.size ? out : null;
}


/**
 * Sleeper — free, no key, no auth.
 * This projections path is undocumented (Sleeper documents leagues/drafts/
 * rosters, not projections), so parse defensively and let it fail quietly:
 * if it breaks, /power just averages fewer sources and says so.
 */
async function projSleeper(season) {
  const positions = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
  const qs = positions.map(p => `position[]=${p}`).join('&');
  const scoreField = SCORING === 'PPR' ? 'pts_ppr'
    : SCORING === 'STD' ? 'pts_std' : 'pts_half_ppr';

  const res = await fetch(
    `https://api.sleeper.app/projections/nfl/${season}?season_type=regular&${qs}&order_by=${scoreField}`,
    { headers: { Accept: 'application/json' } }
  );
  if (!res.ok) throw new Error(`Sleeper ${res.status}`);

  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error('Sleeper: unexpected shape');

  const out = new Map();
  for (const r of rows) {
    const stats = r.stats || {};
    const pts = Number(stats[scoreField] ?? stats.pts_half_ppr ?? stats.pts_ppr ?? stats.pts_std);
    const p = r.player || {};
    const name = p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ');
    if (name && Number.isFinite(pts)) out.set(nameKey(name), pts);
  }
  return out.size ? out : null;
}

async function projEspn(season) {
  // ESPN's public fantasy endpoint — no key required
  const res = await fetch(
    `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/players?view=kona_player_info`,
    { headers: {
        'Accept': 'application/json',
        'x-fantasy-filter': JSON.stringify({
          players: { limit: 800, sortDraftRanks: { sortPriority: 1, sortAsc: true, value: 'STANDARD' } }
        })
      } }
  );
  if (!res.ok) throw new Error(`ESPN ${res.status}`);
  const rows = await res.json();
  const out = new Map();
  for (const r of rows || []) {
    const p = r.player || r;
    const stat = (p.stats || []).find(s => s.seasonId === Number(season) && s.statSourceId === 1);
    const pts = Number(stat?.appliedTotal);
    if (Number.isFinite(pts)) out.set(nameKey(p.fullName), pts);
  }
  return out.size ? out : null;
}

/** Current rosters straight from Yahoo, so this always reflects reality. */
async function currentRosters() {
  const leagueKey = LEAGUE_KEYS[LEAGUE_KEYS.length - 1];
  if (!leagueKey) throw new Error('No LEAGUE_KEYS configured.');

  const data = await yahoo(`/league/${leagueKey}/teams`);
  const teamsNode = merge(merge(data.fantasy_content.league[1]).teams);
  const teams = [];

  for (const entry of numbered(teamsNode)) {
    const info = merge(entry.team[0]);
    const teamKey = info.team_key;
    const owner = (merge((info.managers || [])[0]).manager || {}).nickname || info.name;

    const rosterData = await yahoo(`/team/${teamKey}/roster`);
    const rosterNode = merge(merge(rosterData.fantasy_content.team[1]).roster['0']).players;

    const players = numbered(rosterNode)
      .map(p => merge(p.player[0]))
      .map(m => ({
        name: (m.name && m.name.full) || '',
        position: m.display_position || ''
      }))
      .filter(p => p.name);

    teams.push({ owner, players });
  }
  return teams;
}

/* ----------------------------------------------------------------
   GREGG'S PROJECTIONS

   Each team's roster, priced by public season projections. The sources
   are averaged per player, then the best legal starting lineup is
   picked and totalled. Starters only: a stacked bench doesn't win a
   week, and ranking whole rosters would reward hoarding.

   Rosters come from the league sheet, which is the truth now that the
   Yahoo connection never happened (Yahoo is still tried first if it is
   ever authorised). The lineup shape is read off the pasted roster —
   every slot that isn't bench or IR — so a rule change in Yahoo flows
   through on the next paste with nothing to edit here.
   ---------------------------------------------------------------- */

const FLEX_ELIGIBLE = {
  'W/R/T': ['WR', 'RB', 'TE'], 'W/R': ['WR', 'RB'], 'R/W/T': ['WR', 'RB', 'TE'],
  'FLEX': ['WR', 'RB', 'TE'], 'Q/W/R/T': ['QB', 'WR', 'RB', 'TE'],
  'OP': ['QB', 'WR', 'RB', 'TE'], 'SUPERFLEX': ['QB', 'WR', 'RB', 'TE']
};
const BENCH_SLOTS = new Set(['BN', 'IR', 'IR+', 'NA']);
const DEFAULT_LINEUP = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'W/R/T', 'K', 'DEF'];

/** Projection lookup that copes with how each source names a defense. */
function lookupProjection(maps, player) {
  const tries = [nameKey(player.name)];
  if (player.position === 'DEF') {
    const n = nameKey(player.name).replace(/\s*(d\/st|dst|defense)$/, '');
    tries.push(n + ' d/st', n + ' dst', n + ' defense', n);
    if (player.nflTeam) tries.push(nameKey(player.nflTeam));
  }
  for (const k of tries) {
    const vals = maps.map(m => m.get(k)).filter(Number.isFinite);
    if (vals.length) return vals.reduce((a, b) => a + b, 0) / vals.length;
  }
  return null;
}

const IR_SLOTS = new Set(['IR', 'IR+', 'NA']);

/** Best legal lineup for one team: fixed slots first, flex from what's left.
 *  A player parked on IR can't be started, so he never enters the pool. */
function bestLineup(players, slots) {
  const pool = players
    .filter(p => Number.isFinite(p.pts) && !IR_SLOTS.has(String(p.slot || '').toUpperCase()))
    .sort((a, b) => b.pts - a.pts);
  const used = new Set();
  const starters = [];

  const take = (slot, eligible) => {
    const pick = pool.find(p => !used.has(p) && eligible.includes(p.position));
    if (pick) { used.add(pick); starters.push({ ...pick, slot }); }
  };

  for (const slot of slots) if (!FLEX_ELIGIBLE[slot]) take(slot, [slot]);
  for (const slot of slots) if (FLEX_ELIGIBLE[slot]) take(slot, FLEX_ELIGIBLE[slot]);
  return starters;
}

/** The lineup shape, read off whichever pasted roster is fullest. */
function lineupFromRosters(teams) {
  let best = [];
  for (const t of teams) {
    const slots = t.players.map(p => String(p.slot || '').toUpperCase())
      .filter(s => s && !BENCH_SLOTS.has(s));
    if (slots.length > best.length) best = slots;
  }
  return best.length >= 5 ? best : DEFAULT_LINEUP;
}

async function rostersForProjections() {
  // Yahoo, only if it was ever authorised
  if (readTokens() && LEAGUE_KEYS.length) {
    try {
      const teams = await currentRosters();
      return {
        basis: 'live Yahoo rosters',
        teams: teams.map(t => ({
          owner: canonOwnerName(t.owner),
          players: t.players.map(p => ({ name: p.name, position: p.position, slot: null, nflTeam: null }))
        }))
      };
    } catch (e) { /* fall through */ }
  }

  if (!process.env.SHEET_ID) throw new Error('SHEET_ID not set');
  const league = await loadLeagueData(process.env.SHEET_ID);
  const byOwner = new Map();
  for (const r of league.rosters || []) {
    if (!byOwner.has(r.owner)) byOwner.set(r.owner, []);
    // "position" is the player's real position off the paste; "pos" is the
    // slot he's in. Older roster sources only have the slot.
    const slot = String(r.pos || '').toUpperCase();
    const position = String(r.position || (BENCH_SLOTS.has(slot) || FLEX_ELIGIBLE[slot] ? '' : slot) || '').toUpperCase();
    byOwner.get(r.owner).push({ name: r.player, position, slot, nflTeam: r.nflTeam || null });
  }
  return {
    basis: league.rosterBasis === 'pasted Yahoo rosters'
      ? 'current rosters from the league sheet'
      : (league.rosterSeason || '') + ' rosters from the league sheet',
    teams: [...byOwner.entries()].map(([owner, players]) => ({ owner, players }))
  };
}

let powerCache = { at: 0, data: null };

app.get('/power', async (req, res) => {
  try {
    const fresh = Date.now() - powerCache.at < 30 * 60 * 1000;
    if (fresh && powerCache.data && !req.query.refresh) return res.json(powerCache.data);

    const season = new Date().getFullYear();

    // keyless sources first — ESPN and Sleeper work with no setup at all.
    // The two key-based ones return null when no key is present.
    const attempts = [
      ['ESPN', projEspn],
      ['Sleeper', projSleeper],
      ['FantasyPros', projFantasyPros],
      ['FantasyNerds', projFantasyNerds]
    ];

    const maps = [];
    const used = [];
    const failed = [];

    for (const [label, fn] of attempts) {
      try {
        const m = await fn(season);
        if (m) { maps.push(m); used.push(label); }
      } catch (e) {
        failed.push(`${label}: ${e.message}`);
      }
    }

    if (!maps.length) {
      return res.status(503).json({
        error: 'No projection sources available.',
        detail: failed,
        hint: 'ESPN and Sleeper need no key — if both failed, check the server has outbound internet access.'
      });
    }

    const { basis, teams: rosters } = await rostersForProjections();
    const lineup = lineupFromRosters(rosters);

    const teams = rosters.map(t => {
      const priced = t.players.map(p => ({ ...p, pts: lookupProjection(maps, p) }));
      const starters = bestLineup(priced, lineup);
      const total = starters.reduce((s, p) => s + p.pts, 0);
      const bench = priced.filter(p => Number.isFinite(p.pts) && !starters.includes(p))
        .reduce((s, p) => s + p.pts, 0);

      return {
        owner: t.owner,
        projected: Math.round(total * 10) / 10,
        benchProjected: Math.round(bench * 10) / 10,
        starters: starters.map(p => ({
          slot: p.slot, name: p.name, position: p.position, pts: Math.round(p.pts * 10) / 10
        })),
        playersMatched: priced.filter(p => Number.isFinite(p.pts)).length,
        playersTotal: t.players.length,
        unmatched: priced.filter(p => !Number.isFinite(p.pts)).map(p => p.name)
      };
    }).sort((a, b) => b.projected - a.projected);

    const data = {
      season, scoring: SCORING, sources: used, failed,
      basis, lineup, method: 'best starting lineup, season projections averaged across sources',
      fetchedAt: new Date().toISOString(),
      teams
    };
    powerCache = { at: Date.now(), data };
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


/* ================================================================
   LEAGUE SHEET
   Reads the Google Sheet live so the site tracks whatever's in it.
   Set SHEET_ID in .env to the long id in your sheet's web address:
   docs.google.com/spreadsheets/d/THIS_PART/edit
   The sheet must be shared "anyone with the link can view."
   ================================================================ */


/* ================================================================
   MESSAGE BOARD
   Posts older than BOARD_RETENTION_DAYS (default 180 = 6 months) are
   deleted on a rolling basis. The purge runs hourly and also on boot,
   so nothing lingers just because the server was asleep.

   Set BOARD_PASSWORD in .env to require a shared league password before
   anyone can post. Leave it unset and anyone who finds the site can post.
   ================================================================ */

const RETENTION_DAYS = Number(process.env.BOARD_RETENTION_DAYS || 180);
const BOARD_PASSWORD = process.env.BOARD_PASSWORD || '';

function purgeOldPosts() {
  const cutoff = Math.floor(Date.now() / 1000) - RETENTION_DAYS * 86400;
  // drop replies to purged posts too, so nothing is orphaned
  const gone = db.prepare('DELETE FROM posts WHERE created_at < ?').run(cutoff);
  db.prepare(`
    DELETE FROM posts
    WHERE reply_to IS NOT NULL
      AND reply_to NOT IN (SELECT id FROM posts)
  `).run();
  if (gone.changes) console.log(`[board] purged ${gone.changes} post(s) past ${RETENTION_DAYS} days`);
  return gone.changes;
}

purgeOldPosts();
setInterval(purgeOldPosts, 60 * 60 * 1000);


/* ----------------------------------------------------------------
   ANNOUNCEMENT
   One message, pinned above the board. Posting overwrites whatever
   was there before — there's no history, by design.

   Guarded by ANNOUNCE_CODE (default 6699). The code is checked here on
   the server, so it never appears in the page source.
   ---------------------------------------------------------------- */

const ANNOUNCE_CODE = process.env.ANNOUNCE_CODE || '6699';


/* ----------------------------------------------------------------
   NEWS
   Fetched here rather than in the browser. News sites don't send the
   headers that let another website's JavaScript call them directly,
   but a server has no such restriction. Cached briefly so a room full
   of owners refreshing doesn't hammer the source.
   ---------------------------------------------------------------- */

const NEWS_CACHE_MINUTES = Number(process.env.NEWS_CACHE_MINUTES || 10);
const newsCache = new Map();   // key -> { at, items }

const FF_WORDS = /\b(fantasy|injur|questionable|doubtful|out for|ruled out|return|targets?|carries|snap|touches|start(ing|er)?|bench|waiver|add|drop|trade|sign(s|ed|ing)?|activat|placed on|IR\b|PUP\b|suspend|depth chart|backup|starter|workload|red zone|touchdown|yards|reps|practice|limited|DNP|hamstring|ankle|knee|concussion|rookie|breakout|usage)\b/i;

const NEWS_SOURCES = {
  ffl: [
    'https://site.api.espn.com/apis/fantasy/v2/games/ffl/news?limit=50',
    'https://site.api.espn.com/apis/site/v2/sports/football/nfl/news?limit=50'
  ],
  nfl: [
    'https://site.api.espn.com/apis/site/v2/sports/football/nfl/news?limit=50',
    'https://now.core.api.espn.com/v1/sports/news?limit=50&sport=football'
  ]
};

function stripTags(s) {
  return String(s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function normalizeNews(data) {
  const raw = data.articles || data.feed || data.items || data.news || data.headlines || [];
  return raw.map(a => {
    let link = '';
    if (a.links) {
      if (a.links.web && a.links.web.href) link = a.links.web.href;
      else if (Array.isArray(a.links) && a.links[0]) link = a.links[0].href || '';
    }
    if (!link && a.link) link = typeof a.link === 'string' ? a.link : (a.link.href || '');
    return {
      title: a.headline || a.title || a.shortHeadline || '',
      desc: stripTags(a.description || a.story || a.summary || '').slice(0, 280),
      date: a.published || a.lastModified || a.pubDate || a.date || '',
      link
    };
  }).filter(x => x.title);
}

app.get('/news', async (_req, res) => {
  const hit = newsCache.get('all');
  if (hit && Date.now() - hit.at < NEWS_CACHE_MINUTES * 60 * 1000) {
    return res.json({ source: 'ESPN', cached: true, items: hit.items });
  }

  // Pull every source, merge, drop duplicates, newest first.
  const urls = [...new Set([...NEWS_SOURCES.ffl, ...NEWS_SOURCES.nfl])];
  const problems = [];
  const seen = new Set();
  let merged = [];

  for (const url of urls) {
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!r.ok) { problems.push(`${r.status} from ${new URL(url).host}`); continue; }
      for (const item of normalizeNews(await r.json())) {
        const key = (item.link || item.title).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(item);
      }
    } catch (e) {
      problems.push(e.message);
    }
  }

  if (!merged.length) {
    return res.status(502).json({ error: 'No news source responded.', detail: problems });
  }

  const filtered = merged.filter(i => FF_WORDS.test(i.title + ' ' + i.desc));
  if (filtered.length >= 8) merged = filtered;

  merged.sort((a, b) => {
    const da = Date.parse(a.date) || 0, dbb = Date.parse(b.date) || 0;
    return dbb - da;
  });

  const items = merged.slice(0, 40);
  newsCache.set('all', { at: Date.now(), items });
  res.json({ source: 'ESPN', cached: false, items });
});

app.get('/announcement', (_req, res) => {
  const row = db.prepare('SELECT body, author, updated_at FROM announcement WHERE id = 1').get();
  res.json(row
    ? { body: row.body, author: row.author, updatedAt: row.updated_at }
    : { body: null });
});

app.post('/announcement', (req, res) => {
  const { body, author, code } = req.body || {};

  if (String(code || '') !== ANNOUNCE_CODE) {
    return res.status(401).json({ error: 'Wrong code.' });
  }

  const text = String(body || '').trim().slice(0, 1500);
  const name = String(author || '').trim().slice(0, 40);

  if (!text) {
    db.prepare('DELETE FROM announcement WHERE id = 1').run();
    return res.json({ ok: true, cleared: true });
  }

  db.prepare(`
    INSERT INTO announcement (id, body, author, updated_at)
    VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET body = excluded.body,
                                  author = excluded.author,
                                  updated_at = excluded.updated_at
  `).run(text, name || null, Math.floor(Date.now() / 1000));

  res.json({ ok: true });
});


/* ----------------------------------------------------------------
   LEAGUE VOTE
   Proposing a rule change needs ANNOUNCE_CODE. Voting doesn't — every
   owner just picks their name and votes yes or no.

   One vote per owner is enforced by the primary key on (proposal_id,
   owner), so a second vote replaces the first rather than stacking.

   PASS_THRESHOLD yes votes carries it. With 12 owners, once enough
   owners have voted no that 7 yes is unreachable, it's marked failed
   automatically — no need for anyone to close it.
   ---------------------------------------------------------------- */

const PASS_THRESHOLD = Number(process.env.VOTE_PASS_THRESHOLD || 7);
const LEAGUE_OWNERS = (process.env.LEAGUE_OWNERS ||
  'Rogan,Marc,Palumberi,Jared,Fito,Post,Hexx,Opie,Derek,Rebel,Gregg,Garett')
  .split(',').map(s => s.trim()).filter(Boolean);

function tallyProposal(p) {
  const rows = db.prepare('SELECT owner, choice FROM votes WHERE proposal_id = ?').all(p.id);
  const yes = rows.filter(r => r.choice === 'yes');
  const no = rows.filter(r => r.choice === 'no');
  const remaining = LEAGUE_OWNERS.length - rows.length;

  let status = 'open';
  if (yes.length >= PASS_THRESHOLD) status = 'passed';
  else if (yes.length + remaining < PASS_THRESHOLD) status = 'failed';

  return {
    id: p.id,
    title: p.title,
    body: p.body,
    author: p.author,
    createdAt: p.created_at,
    yes: yes.length,
    no: no.length,
    needed: PASS_THRESHOLD,
    status,
    voters: rows.map(r => ({ owner: r.owner, choice: r.choice }))
  };
}


/* ----------------------------------------------------------------
   TOUCHDOWN PARLAY
   Everyone picks one player a week. We check ESPN's scoring plays to
   see who found the end zone.

   Uses ESPN rather than Yahoo because it needs no key and no approval,
   so it works right away. Nothing here depends on the Yahoo hookup.

   A passing touchdown does NOT count for the quarterback — the receiver
   is the one who scored. ESPN writes those plays as
   "<receiver> 12 Yd pass from <QB>", so only the part before "from"
   counts as the scorer.
   ---------------------------------------------------------------- */

const parlayCache = new Map();   // "season:week" -> { at, scorers, games }

function currentNflSeason() {
  const now = new Date();
  // the season is named for the year it starts; January belongs to the prior one
  return now.getMonth() <= 1 ? now.getFullYear() - 1 : now.getFullYear();
}

function playerNameKey(n) {
  return String(n || '')
    .toLowerCase()
    .replace(/[.'`]/g, '')
    .replace(/-/g, ' ')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Pull every touchdown scorer for a given week. */
async function fetchWeekScorers(season, week) {
  const key = `${season}:${week}`;
  const hit = parlayCache.get(key);
  if (hit && Date.now() - hit.at < 2 * 60 * 1000) return hit;   // 2 min

  const sbUrl = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard'
    + `?week=${week}&seasontype=2&dates=${season}`;
  const sbRes = await fetch(sbUrl, { headers: { Accept: 'application/json' } });
  if (!sbRes.ok) throw new Error(`ESPN scoreboard ${sbRes.status}`);
  const sb = await sbRes.json();

  const events = (sb.events || []).map(e => ({
    id: e.id,
    name: e.shortName,
    state: ((e.status || {}).type || {}).state || 'pre'
  }));

  const scorers = new Set();

  await Promise.all(events.map(async ev => {
    if (ev.state === 'pre') return;   // nothing to read yet
    try {
      const r = await fetch(
        `https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${ev.id}`,
        { headers: { Accept: 'application/json' } });
      if (!r.ok) return;
      const data = await r.json();

      for (const play of data.scoringPlays || []) {
        const type = ((play.type || {}).abbreviation || play.scoringType?.abbreviation || '').toUpperCase();
        const text = String(play.text || '');
        if (type && type !== 'TD') continue;
        if (!type && !/touchdown|\bTD\b|Yd (run|pass|reception|return)/i.test(text)) continue;

        // the scorer is named before " from "
        const scorerPart = text.split(/\sfrom\s/i)[0];

        // ESPN sometimes attaches the athletes directly — prefer that
        const participants = play.participants || [];
        let named = false;
        for (const p of participants) {
          const role = (p.type || '').toLowerCase();
          if (role && role !== 'scorer' && role !== 'rusher' && role !== 'receiver') continue;
          const nm = ((p.athlete || {}).displayName) || '';
          if (nm) { scorers.add(playerNameKey(nm)); named = true; }
        }
        if (!named) {
          // fall back to the leading name in the play text
          const m = scorerPart.match(/^([A-Z][A-Za-z.'`-]+(?:\s[A-Z][A-Za-z.'`-]+){1,2})/);
          if (m) scorers.add(playerNameKey(m[1]));
        }
      }
    } catch (e) { /* skip this game */ }
  }));

  const out = {
    at: Date.now(),
    scorers,
    games: events.map(e => ({ name: e.name, state: e.state }))
  };
  parlayCache.set(key, out);
  return out;
}


/* ----------------------------------------------------------------
   ROSTERS
   Feeds the parlay dropdown. Prefers live Yahoo rosters; falls back to
   the ending rosters in the Google Sheet when Yahoo isn't hooked up.
   The response says which source it used so the page can be honest
   about how current the list is.
   ---------------------------------------------------------------- */


/** Yahoo nicknames don't always match the names used in the sheet. */
function canonOwnerName(name) {
  const n = String(name || '').trim();
  const hit = LEAGUE_OWNERS.find(o => o.toLowerCase() === n.toLowerCase());
  return hit || n;
}

let rosterCache = { at: 0, data: null };


/* ----------------------------------------------------------------
   MARC'S POWER RANKINGS
   Marc posts these as images. Stored as base64 in the same database
   as everything else — no file hosting to set up, and they survive
   redeploys along with the rest of the data.

   Posting needs ANNOUNCE_CODE (6699). Viewing is open.
   ---------------------------------------------------------------- */

const MARC_MAX_BYTES = Number(process.env.MARC_MAX_BYTES || 4 * 1024 * 1024);


/* ----------------------------------------------------------------
   DUES

   Read from the "Schedule & Dues Tracker" tab of the league sheet —
   the same tracker the commissioner has always kept, so there is
   nothing new to maintain (see readDuesTracker in league-sheet.js for
   the layout). Buy-in, payout lines and the weekly prize all come off
   that tab too; the environment variables below are only the fallback
   when the tab doesn't carry them.

   dues.csv and high-scores.csv in the repo are a second fallback, used
   only if the tab can't be read at all.
   ---------------------------------------------------------------- */

const BUY_IN        = Number(process.env.BUY_IN || 100);
const PAYOUT_FIRST  = Number(process.env.PAYOUT_FIRST || 350);
const PAYOUT_SECOND = Number(process.env.PAYOUT_SECOND || 100);
const PAYOUT_THIRD  = Number(process.env.PAYOUT_THIRD || 0);
const PAYOUT_LEAGUE = Number(process.env.PAYOUT_LEAGUE || 50);   // 1st place at the end of the regular season
const WEEKLY_PRIZE  = Number(process.env.WEEKLY_PRIZE || 50);
const WEEKLY_WEEKS  = Number(process.env.WEEKLY_WEEKS || 14);

const { parseCSV: parseCsvRows } = require('./league-sheet');

/** Read a CSV from the repo into objects keyed by its header row. */
function readRepoCsv(file) {
  const p = path.join(__dirname, file);
  if (!fs.existsSync(p)) return null;
  const rows = parseCsvRows(fs.readFileSync(p, 'utf8')).filter(r => r.some(c => String(c || '').trim()));
  if (rows.length < 2) return [];
  const head = rows[0].map(h => String(h || '').trim().toLowerCase());
  return rows.slice(1).map(r => {
    const o = {};
    head.forEach((h, i) => { o[h] = String(r[i] || '').trim(); });
    return o;
  });
}

app.get('/dues', async (_req, res) => {
  const season = currentNflSeason();

  // The tracker tab is the source. The CSVs only step in if the tab can't
  // be read, so the page is never blank.
  let tracker = null;
  let standings = [];
  try {
    if (process.env.SHEET_ID) {
      const league = await loadLeagueData(process.env.SHEET_ID);
      tracker = league.dues || null;
      standings = league.standings || [];
    }
  } catch (e) { /* fall through to the CSVs */ }

  const pay = (tracker && tracker.payouts) || {};
  const payouts = {
    buyIn:       pay.buyIn       || BUY_IN,
    first:       pay.first       ?? PAYOUT_FIRST,
    second:      pay.second      ?? PAYOUT_SECOND,
    third:       pay.third       ?? PAYOUT_THIRD,
    league:      pay.league      ?? PAYOUT_LEAGUE,
    weeklyPrize: pay.weeklyPrize || WEEKLY_PRIZE,
    weeklyWeeks: pay.weeklyWeeks || WEEKLY_WEEKS
  };
  payouts.weeklyTotal = payouts.weeklyPrize * payouts.weeklyWeeks;
  payouts.allocated = payouts.first + payouts.second + payouts.third + payouts.league + payouts.weeklyTotal;

  // ---- per-owner facts, from the tracker or the CSVs ----
  const facts = new Map();   // owner -> { dues, paid, weeks:[{week,score}], first, second, third, note }
  let source;

  if (tracker && tracker.owners.length) {
    source = 'Schedule & Dues Tracker tab';
    for (const o of tracker.owners) {
      const owner = canonOwnerName(o.owner);
      if (!LEAGUE_OWNERS.includes(owner)) continue;      // a name from a past season
      const dues = o.dues ?? payouts.buyIn;
      facts.set(owner, {
        dues,
        paid: o.paid === 'full' ? dues : (o.paid ?? 0),
        paidTracked: o.paid !== null,
        weeks: o.weeks,
        first: o.first, second: o.second, third: o.third, regSeason: o.season,
        note: null
      });
    }
  } else {
    source = 'tracker tab could not be read — nothing logged';
    for (const r of readRepoCsv('dues.csv') || []) {
      const owner = canonOwnerName(r.owner);
      if (!LEAGUE_OWNERS.includes(owner)) continue;
      const dues = r.dues === '' ? payouts.buyIn : Number(r.dues) || 0;
      const fin = Number(r.finish) || 0;
      facts.set(owner, { dues, paid: Number(r.paid) || 0, paidTracked: true, weeks: [],
        first: fin === 1, second: fin === 2, third: fin === 3, regSeason: false, note: r.note || null });
    }
    for (const r of readRepoCsv('high-scores.csv') || []) {
      const owner = canonOwnerName(r.owner); const w = Number(r.week);
      if (!facts.has(owner) || !w) continue;
      facts.get(owner).weeks.push({ week: w, score: Number(r.score) || null });
    }
  }

  // every current owner gets a row, even with nothing logged yet
  for (const o of LEAGUE_OWNERS) {
    if (!facts.has(o)) facts.set(o, { dues: payouts.buyIn, paid: 0, paidTracked: false, weeks: [],
      first: false, second: false, third: false, regSeason: false, note: null });
  }

  // ---- weekly strip ----
  const weekly = [];
  for (let w = 1; w <= payouts.weeklyWeeks; w++) {
    const winners = [...facts.entries()].filter(([, f]) => f.weeks.some(x => x.week === w));
    const hit = winners[0];
    weekly.push({
      week: w,
      owner: hit ? hit[0] : null,
      score: hit ? (hit[1].weeks.find(x => x.week === w).score) : null,
      tie: winners.length > 1 ? winners.map(x => x[0]) : null
    });
  }

  const owners = LEAGUE_OWNERS.map(o => {
    const f = facts.get(o);
    const weeks = f.weeks.map(x => x.week).sort((a, b) => a - b);
    const highScore = weeks.length * payouts.weeklyPrize;
    const finishPrize = (f.first ? payouts.first : 0) + (f.second ? payouts.second : 0) + (f.third ? payouts.third : 0);
    const finish = f.first ? 1 : f.second ? 2 : f.third ? 3 : null;
    const seasonPrize = f.regSeason ? payouts.league : 0;
    const won = highScore + finishPrize + seasonPrize;
    return {
      owner: o,
      dues: f.dues,
      paid: f.paid,
      paidTracked: f.paidTracked,
      owed: Math.max(0, f.dues - f.paid),
      status: !f.paidTracked ? 'untracked' : f.paid >= f.dues ? 'paid' : f.paid > 0 ? 'partial' : 'unpaid',
      note: f.note,
      highScoreWeeks: weeks,
      highScore,            // weekly high-score winnings
      regSeason: !!f.regSeason,
      season: seasonPrize,  // 1st place at the end of the regular season
      finish,
      finishPrize,
      won,
      net: won - f.dues
    };
  });

  const expected = owners.reduce((n, o) => n + o.dues, 0);
  const collected = owners.reduce((n, o) => n + o.paid, 0);
  const weeklyLogged = weekly.filter(w => w.owner).length;

  res.json({
    season, source,
    buyIn: payouts.buyIn,
    expected, collected,
    outstanding: expected - collected,
    owners, weekly, weeklyLogged,
    weeklyPaidOut: weeklyLogged * payouts.weeklyPrize,
    payouts
  });
});

// Payments used to be recorded through the site into the database. They
// live in dues.csv now, so these say so instead of silently writing to a
// table nothing reads.
app.post(['/dues', '/dues/weekly'], (_req, res) => {
  res.status(410).json({
    error: 'Dues are kept in dues.csv and high-scores.csv in the repo now. Edit the file and push.'
  });
});

/* ----------------------------------------------------------------
   RANKINGS KEPT AS FILES IN THE REPO

   Drop an image into power-rankings/ named for its week and it shows
   up — week-1.jpg, week-2.png, and so on. Anything after the week
   number becomes the caption, so

       power-rankings/week-3 Chinese Food Special Edition.jpg

   lists as Week 3, "Chinese Food Special Edition".

   These are committed alongside the code, so unlike an upload they
   cost nothing to keep and can't be lost with the database.
   ---------------------------------------------------------------- */

const RANKINGS_DIR = path.join(__dirname, 'power-rankings');
const RANKING_TYPES = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png',  '.gif': 'image/gif',
  '.webp': 'image/webp'
};

function rankingFiles() {
  let names;
  try {
    names = fs.readdirSync(RANKINGS_DIR);
  } catch (e) {
    return [];                       // folder isn't there, which is fine
  }

  return names.map(name => {
    const ext = path.extname(name).toLowerCase();
    if (!RANKING_TYPES[ext]) return null;

    const m = path.basename(name, ext).match(/^week[\s_-]*(\d{1,2})(.*)$/i);
    if (!m) return null;

    const caption = m[2].replace(/[_-]+/g, ' ').trim();
    return {
      id: 'file:' + name,
      week: Number(m[1]),
      caption: caption || null,
      createdAt: null,
      fromFile: true,
      url: '/power-rankings/' + encodeURIComponent(name)
    };
  }).filter(Boolean);
}

app.get('/marc-rankings', (_req, res) => {
  const rows = db.prepare(`
    SELECT id, week, caption, created_at FROM marc_rankings
    ORDER BY created_at DESC LIMIT 60
  `).all();

  const uploaded = rows.map(r => ({
    id: r.id, week: r.week, caption: r.caption, createdAt: r.created_at,
    fromFile: false,
    url: '/marc-rankings/' + r.id + '/image'
  }));

  // A committed file is the deliberate copy, so where both exist for a
  // week the file wins and the upload is dropped rather than shown twice.
  // Two files for the same week — say week-5.jpg left behind next to
  // "week-5 Something Funny.jpg" — show once. The captioned one wins.
  const byWeek = new Map();
  for (const f of rankingFiles()) {
    const cur = byWeek.get(f.week);
    if (!cur || (f.caption && !cur.caption) || (!!f.caption === !!cur.caption && f.id > cur.id)) byWeek.set(f.week, f);
  }
  const files = [...byWeek.values()];
  const claimed = new Set(files.map(f => f.week));

  const items = files
    .concat(uploaded.filter(u => !claimed.has(u.week)))
    .sort((a, b) => (b.week || 0) - (a.week || 0)
      || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

  res.json({ items });
});

// Serve the image files themselves. Named explicitly and resolved against
// the folder so a crafted path can't climb out of it into the app folder.
app.get('/power-rankings/:name', (req, res) => {
  const name = path.basename(req.params.name);
  const ext = path.extname(name).toLowerCase();
  if (!RANKING_TYPES[ext]) return res.status(404).send('Not found');

  const file = path.join(RANKINGS_DIR, name);
  if (path.dirname(path.resolve(file)) !== path.resolve(RANKINGS_DIR)) {
    return res.status(404).send('Not found');
  }
  if (!fs.existsSync(file)) return res.status(404).send('Not found');

  res.set('Content-Type', RANKING_TYPES[ext]);
  res.set('Cache-Control', 'public, max-age=3600');
  res.sendFile(file);
});

app.get('/marc-rankings/:id/image', (req, res) => {
  const row = db.prepare('SELECT mime, data FROM marc_rankings WHERE id = ?')
    .get(Number(req.params.id));
  if (!row) return res.status(404).send('Not found');
  const buf = Buffer.from(row.data, 'base64');
  res.set('Content-Type', row.mime);
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(buf);
});

app.post('/marc-rankings', (req, res) => {
  const { image, mime, week, caption, code } = req.body || {};

  if (String(code || '') !== ANNOUNCE_CODE) {
    return res.status(401).json({ error: 'Wrong code.' });
  }
  if (!image || !mime) return res.status(400).json({ error: 'No image received.' });
  if (!/^image\/(png|jpe?g|gif|webp)$/i.test(mime)) {
    return res.status(400).json({ error: 'Images only (png, jpg, gif, webp).' });
  }

  const bytes = Buffer.byteLength(image, 'base64');
  if (bytes > MARC_MAX_BYTES) {
    return res.status(413).json({
      error: `That image is ${(bytes / 1048576).toFixed(1)}MB — the limit is ${(MARC_MAX_BYTES / 1048576).toFixed(0)}MB.`
    });
  }

  const info = db.prepare(`
    INSERT INTO marc_rankings (week, caption, mime, data, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(Number(week) || null, String(caption || '').trim().slice(0, 200),
         mime, image, Math.floor(Date.now() / 1000));

  res.json({ ok: true, id: info.lastInsertRowid });
});

app.delete('/marc-rankings/:id', (req, res) => {
  if (String(req.query.code || '') !== ANNOUNCE_CODE) {
    return res.status(401).json({ error: 'Wrong code.' });
  }
  // A ranking that came from a committed file isn't the server's to delete —
  // say so plainly instead of running a DELETE that matches nothing.
  if (/^file:/.test(String(req.params.id))) {
    return res.status(400).json({
      error: 'That one is a file in the power-rankings folder. ' +
             'Delete it from the repo and push to remove it.'
    });
  }

  db.prepare('DELETE FROM marc_rankings WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

/* ----------------------------------------------------------------
   BACKUP

   Hand over a copy of the whole database — Marc's rankings, the
   votes, the dues, the parlay picks. Visit /backup?code=THECODE in a
   browser and it downloads as a file.

   SQLite is in WAL mode, so the live file on its own can be missing
   the most recent writes. db.backup() takes a consistent snapshot.
   ---------------------------------------------------------------- */

/* ----------------------------------------------------------------
   RESTORE

   Put a file from /backup back. Needed whenever the database moves
   house — onto a volume, or to a new host — because the old disk is
   gone by the time the new one starts.

   The upload is staged next to the database and swapped in on the
   next boot, so nothing is replaced while connections are open
   against it. The server exits once the file is staged; the host
   restarts it, and the swap happens on the way up.
   ---------------------------------------------------------------- */

const SQLITE_MAGIC = 'SQLite format 3\0';

app.get('/restore', (_req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Restore</title>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, sans-serif;
         background:#15171c; color:#e9ecf1; margin:0;
         display:flex; min-height:100vh; align-items:center; justify-content:center; }
  .card { width:min(520px, 92vw); background:#1e2128; border:1px solid #2c303a;
          border-radius:14px; padding:28px; }
  h1 { margin:0 0 6px; font-size:1.3rem; }
  p  { color:#9aa3b2; line-height:1.5; font-size:.94rem; }
  label { display:block; margin:18px 0 6px; font-weight:600; font-size:.9rem; }
  input { width:100%; padding:11px 12px; border-radius:9px; border:1px solid #39404e;
          background:#15171c; color:#e9ecf1; font-size:1rem; box-sizing:border-box; }
  button { margin-top:20px; width:100%; padding:13px; border:0; border-radius:9px;
           background:#c8362f; color:#fff; font-size:1rem; font-weight:700; cursor:pointer; }
  button:disabled { opacity:.5; cursor:default; }
  .msg { margin-top:16px; padding:12px; border-radius:9px; display:none; font-size:.92rem; line-height:1.45; }
  .ok  { background:#17351f; color:#a7e3b4; display:block; }
  .bad { background:#3a1c1c; color:#f0b4b0; display:block; }
  .warn{ background:#3a3119; color:#f0d9a8; font-size:.88rem; }
</style></head><body>
<div class="card">
  <h1>Restore the league database</h1>
  <p>Upload a file you got from <code>/backup</code>. It replaces everything
     currently stored — dues, parlay picks, board posts, votes.</p>
  <div class="msg warn" style="display:block">The site restarts itself after
     this. Give it about a minute, then reload the main page.</div>
  <label for="code">Code</label>
  <input id="code" type="password" placeholder="the same code you use to post">
  <label for="file">Backup file</label>
  <input id="file" type="file" accept=".db,application/octet-stream">
  <button id="go">Restore</button>
  <div id="msg" class="msg"></div>
</div>
<script>
  const msg = document.getElementById('msg');
  const go  = document.getElementById('go');
  function say(text, cls) { msg.className = 'msg ' + cls; msg.textContent = text; }

  go.addEventListener('click', async () => {
    const code = document.getElementById('code').value.trim();
    const file = document.getElementById('file').files[0];
    if (!code) return say('Enter the code.', 'bad');
    if (!file) return say('Pick a backup file.', 'bad');

    go.disabled = true;
    say('Uploading ' + Math.round(file.size / 1024) + ' KB...', 'ok');

    try {
      const buf = await file.arrayBuffer();
      let bin = '';
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i += 8192) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
      }
      const res = await fetch('/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code, data: btoa(bin) })
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || ('server ' + res.status));
      say(d.message, 'ok');
    } catch (e) {
      say(e.message || 'Something went wrong.', 'bad');
      go.disabled = false;
    }
  });
</script>
</body></html>`);
});

app.post('/restore', express.json({ limit: '128mb' }), (req, res) => {
  const { code, data } = req.body || {};

  if (String(code || '') !== ANNOUNCE_CODE) {
    return res.status(401).json({ error: 'Wrong code.' });
  }
  if (!data) {
    return res.status(400).json({ error: 'No file came through.' });
  }

  let buf;
  try {
    buf = Buffer.from(String(data), 'base64');
  } catch (e) {
    return res.status(400).json({ error: 'That file could not be read.' });
  }

  // Check it really is a SQLite database before letting it near the real one.
  if (buf.length < 100 || buf.subarray(0, 16).toString('latin1') !== SQLITE_MAGIC) {
    return res.status(400).json({
      error: 'That is not a database file. Use the file you got from /backup.'
    });
  }

  const staged = DB_FILE + '.restore';

  try {
    fs.writeFileSync(staged, buf);

    // Open the staged copy on its own and confirm it has the league's tables,
    // so a valid-but-unrelated SQLite file can't quietly wipe everything.
    const probe = new Database(staged, { readonly: true });
    const names = probe.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'"
    ).all().map(r => r.name);
    probe.close();

    if (!names.includes('dues') && !names.includes('parlay_picks')) {
      fs.unlinkSync(staged);
      return res.status(400).json({
        error: 'That database is not from this site.'
      });
    }

    res.json({
      ok: true,
      tables: names.length,
      message: 'Restored ' + names.length + ' tables. Restarting now — ' +
               'wait about a minute, then reload the main page.'
    });

    // Leave once the reply is on its way. The host restarts the service and
    // the staged file is swapped in during startup.
    setTimeout(() => process.exit(0), 400);
  } catch (e) {
    try { fs.unlinkSync(staged); } catch (e2) { /* nothing staged */ }
    res.status(500).json({ error: 'Could not stage the restore: ' + e.message });
  }
});

app.get('/backup', async (req, res) => {
  if (String(req.query.code || '') !== ANNOUNCE_CODE) {
    return res.status(401).json({ error: 'Wrong code.' });
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const snapshot = path.join(DATA_DIR, 'backup-' + stamp + '.db');

  try {
    await db.backup(snapshot);
    res.download(snapshot, 'league-backup-' + stamp + '.db', () => {
      try { fs.unlinkSync(snapshot); } catch (e) { /* already gone */ }
    });
  } catch (e) {
    res.status(500).json({ error: 'Could not make a backup: ' + e.message });
  }
});

app.get('/rosters', async (_req, res) => {
  if (rosterCache.data && Date.now() - rosterCache.at < 10 * 60 * 1000) {
    return res.json(rosterCache.data);
  }

  // 1. live from Yahoo, if we're authorized
  if (readTokens() && LEAGUE_KEYS.length) {
    try {
      const teams = await currentRosters();
      const data = {
        source: 'yahoo',
        label: 'live Yahoo rosters',
        teams: teams.map(t => ({
          owner: canonOwnerName(t.owner),
          players: t.players.map(p => ({ name: p.name, pos: p.position }))
        }))
      };
      rosterCache = { at: Date.now(), data };
      return res.json(data);
    } catch (e) { /* fall through to the sheet */ }
  }

  // 2. the sheet's end-of-season rosters
  try {
    if (!process.env.SHEET_ID) throw new Error('SHEET_ID not set');
    const league = await loadLeagueData(process.env.SHEET_ID);
    const byOwner = new Map();
    for (const r of league.rosters || []) {
      if (!byOwner.has(r.owner)) byOwner.set(r.owner, []);
      byOwner.get(r.owner).push({
        name: r.player, pos: r.pos, round: r.round, pick: r.pick,
        // real position off the Yahoo paste, where the slot is BN / IR / flex
        position: r.position || null, nflTeam: r.nflTeam || null
      });
    }
    const season = league.rosterSeason || 'the sheet';
    const basisText = {
      'draft board': `${season} rosters, from the draft board`,
      'ending rosters': `${season} ending rosters (this season's draft not entered yet)`
    }[league.rosterBasis] || `${season} rosters from the Google Sheet`;

    const data = {
      source: 'sheet',
      season,
      basis: league.rosterBasis,
      label: basisText,
      teams: [...byOwner.entries()].map(([owner, players]) => ({ owner, players }))
    };
    rosterCache = { at: Date.now(), data };
    return res.json(data);
  } catch (e) {
    return res.status(503).json({ error: 'No roster source available: ' + e.message });
  }
});

app.get('/parlay', async (req, res) => {
  const season = Number(req.query.season) || currentNflSeason();
  const week = Number(req.query.week) || 1;

  const picks = db.prepare(`
    SELECT owner, player, created_at FROM parlay_picks
    WHERE season = ? AND week = ? ORDER BY created_at
  `).all(season, week);

  let scorers = null, games = [], note = null;
  try {
    const wk = await fetchWeekScorers(season, week);
    scorers = wk.scorers;
    games = wk.games;
  } catch (e) {
    note = 'Live scoring unavailable: ' + e.message;
  }

  res.json({
    season,
    week,
    owners: LEAGUE_OWNERS,
    note,
    gamesStarted: games.filter(g => g.state !== 'pre').length,
    gamesTotal: games.length,
    picks: picks.map(p => ({
      owner: p.owner,
      player: p.player,
      scored: scorers ? scorers.has(playerNameKey(p.player)) : null
    }))
  });
});

app.post('/parlay', (req, res) => {
  const { owner, player, week, season } = req.body || {};
  const s = Number(season) || currentNflSeason();
  const w = Number(week);

  if (!LEAGUE_OWNERS.includes(owner)) {
    return res.status(400).json({ error: 'Pick your name from the list.' });
  }
  if (!Number.isFinite(w) || w < 1 || w > 18) {
    return res.status(400).json({ error: 'Week must be 1-18.' });
  }
  const name = String(player || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'Enter a player.' });

  db.prepare(`
    INSERT INTO parlay_picks (season, week, owner, player, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(season, week, owner)
      DO UPDATE SET player = excluded.player, created_at = excluded.created_at
  `).run(s, w, owner, name, Math.floor(Date.now() / 1000));

  res.json({ ok: true });
});

app.delete('/parlay', (req, res) => {
  const s = Number(req.query.season) || currentNflSeason();
  const w = Number(req.query.week);
  const owner = req.query.owner;
  db.prepare('DELETE FROM parlay_picks WHERE season = ? AND week = ? AND owner = ?')
    .run(s, w, owner);
  res.json({ ok: true });
});

app.get('/votes', (_req, res) => {
  const rows = db.prepare('SELECT * FROM proposals ORDER BY created_at DESC LIMIT 100').all();
  res.json({
    owners: LEAGUE_OWNERS,
    threshold: PASS_THRESHOLD,
    proposals: rows.map(tallyProposal)
  });
});

app.post('/votes/proposal', (req, res) => {
  const { title, body, author, code } = req.body || {};
  if (String(code || '') !== ANNOUNCE_CODE) {
    return res.status(401).json({ error: 'Wrong code.' });
  }
  const t = String(title || '').trim().slice(0, 140);
  if (!t) return res.status(400).json({ error: 'Give the proposal a title.' });

  const info = db.prepare(`
    INSERT INTO proposals (title, body, author, created_at) VALUES (?, ?, ?, ?)
  `).run(t, String(body || '').trim().slice(0, 2000),
         String(author || '').trim().slice(0, 40) || null,
         Math.floor(Date.now() / 1000));

  res.json({ ok: true, id: info.lastInsertRowid });
});

app.post('/votes/:id/cast', (req, res) => {
  const { owner, choice } = req.body || {};
  const id = Number(req.params.id);

  if (!LEAGUE_OWNERS.includes(owner)) {
    return res.status(400).json({ error: 'Pick your name from the list.' });
  }
  if (choice !== 'yes' && choice !== 'no') {
    return res.status(400).json({ error: 'Vote yes or no.' });
  }
  const p = db.prepare('SELECT * FROM proposals WHERE id = ?').get(id);
  if (!p) return res.status(404).json({ error: 'No such proposal.' });

  const current = tallyProposal(p);
  if (current.status !== 'open') {
    return res.status(409).json({ error: 'That vote is already decided.' });
  }

  db.prepare(`
    INSERT INTO votes (proposal_id, owner, choice, cast_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(proposal_id, owner) DO UPDATE SET choice = excluded.choice,
                                                  cast_at = excluded.cast_at
  `).run(id, owner, choice, Math.floor(Date.now() / 1000));

  res.json({ ok: true, proposal: tallyProposal(p) });
});

app.delete('/votes/:id', (req, res) => {
  if (String(req.query.code || '') !== ANNOUNCE_CODE) {
    return res.status(401).json({ error: 'Wrong code.' });
  }
  const id = Number(req.params.id);
  db.prepare('DELETE FROM votes WHERE proposal_id = ?').run(id);
  db.prepare('DELETE FROM proposals WHERE id = ?').run(id);
  res.json({ ok: true });
});

app.get('/board', (_req, res) => {
  purgeOldPosts();
  const rows = db.prepare(`
    SELECT id, author, body, reply_to, created_at
    FROM posts
    ORDER BY created_at DESC
    LIMIT 500
  `).all();

  res.json({
    retentionDays: RETENTION_DAYS,
    passwordRequired: !!BOARD_PASSWORD,
    posts: rows.map(r => ({
      id: r.id,
      author: r.author,
      body: r.body,
      replyTo: r.reply_to,
      createdAt: r.created_at
    }))
  });
});

app.post('/board', (req, res) => {
  const { author, body, replyTo, password } = req.body || {};

  if (BOARD_PASSWORD && password !== BOARD_PASSWORD) {
    return res.status(401).json({ error: 'Wrong league password.' });
  }
  const name = String(author || '').trim().slice(0, 40);
  const text = String(body || '').trim().slice(0, 2000);
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  if (!text) return res.status(400).json({ error: 'Message is empty.' });

  const info = db.prepare(`
    INSERT INTO posts (author, body, reply_to, created_at) VALUES (?, ?, ?, ?)
  `).run(name, text, Number.isFinite(Number(replyTo)) ? Number(replyTo) : null,
         Math.floor(Date.now() / 1000));

  res.json({ ok: true, id: info.lastInsertRowid });
});

app.delete('/board/:id', (req, res) => {
  if (BOARD_PASSWORD && req.query.password !== BOARD_PASSWORD) {
    return res.status(401).json({ error: 'Wrong league password.' });
  }
  const id = Number(req.params.id);
  db.prepare('DELETE FROM posts WHERE id = ? OR reply_to = ?').run(id, id);
  res.json({ ok: true });
});

app.get('/league-data', async (req, res) => {
  try {
    if (!process.env.SHEET_ID) {
      return res.status(503).json({ error: 'SHEET_ID is not set.' });
    }
    const data = await loadLeagueData(process.env.SHEET_ID, {
      force: req.query.refresh === '1'
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/standings', async (_req, res) => {
  try {
    const key = LEAGUE_KEYS[LEAGUE_KEYS.length - 1];
    if (!key) throw new Error('No LEAGUE_KEYS configured.');
    res.json(await yahoo(`/league/${key}/standings`));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Anything we don't recognize as an API call gets the website.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/auth') || req.path.startsWith('/activity') ||
      req.path.startsWith('/history') || req.path.startsWith('/power') ||
      req.path.startsWith('/standings') || req.path.startsWith('/health') ||
      req.path.startsWith('/league-data') || req.path.startsWith('/board') || req.path.startsWith('/announcement') || req.path.startsWith('/votes') || req.path.startsWith('/news') || req.path.startsWith('/parlay') || req.path.startsWith('/rosters') || req.path.startsWith('/marc-rankings') || req.path.startsWith('/dues')) {
    return next();
  }
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`League proxy on :${PORT} — polling Yahoo every ${POLL_MINUTES} min`);
});
