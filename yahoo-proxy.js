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
app.use(express.json());

// Serve the website itself. Because the site and the data live on the same
// server, the browser treats them as one thing — no cross-origin setup needed.
app.use(express.static(__dirname));

const BASE = 'https://fantasysports.yahooapis.com/fantasy/v2';
const TOKEN_FILE = path.join(__dirname, '.tokens.json');
const LEAGUE_KEYS = (process.env.LEAGUE_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
const POLL_MINUTES = Number(process.env.POLL_MINUTES || 15);

/* ================================================================
   DATABASE
   ================================================================ */

const db = new Database(path.join(__dirname, 'league.db'));
db.pragma('journal_mode = WAL');

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

app.get('/power', async (_req, res) => {
  try {
    const season = new Date().getFullYear();

    // gather whichever sources are configured and responding
    // keyless sources first — these work with no setup at all.
    // the two key-based ones simply return null when no key is present.
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

    const rosters = await currentRosters();

    const teams = rosters.map(t => {
      let total = 0;
      let matched = 0;
      const missing = [];

      for (const p of t.players) {
        const k = nameKey(p.name);
        const vals = maps.map(m => m.get(k)).filter(Number.isFinite);
        if (vals.length) {
          total += vals.reduce((a, b) => a + b, 0) / vals.length;  // average the sources
          matched++;
        } else {
          missing.push(p.name);
        }
      }

      return {
        owner: t.owner,
        projected: Math.round(total * 10) / 10,
        playersMatched: matched,
        playersTotal: t.players.length,
        unmatched: missing
      };
    }).sort((a, b) => b.projected - a.projected);

    res.json({ season, scoring: SCORING, sources: used, failed, teams });
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
      req.path.startsWith('/league-data')) {
    return next();
  }
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`League proxy on :${PORT} — polling Yahoo every ${POLL_MINUTES} min`);
});
