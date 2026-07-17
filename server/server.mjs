// TextHero server: serves the built game (dist/) over HTTP, runs the
// multiplayer lobby over WebSocket, and hosts the global leaderboard in a
// SQLite database — one process, one URL, which is exactly what hosts like
// Render expect. Scoring stays on the clients (deterministic engine); this
// relays lobby state and persists submitted score records.
//   npm run server   (default port 8137, override with PORT env var)
// Leaderboard data lives in DATA_DIR/leaderboard.db (default ../data). On
// hosts with ephemeral disks (Render free tier) point DATA_DIR at a mounted
// persistent disk or scores reset on every deploy.
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 8137);
const MAX_SONG_PAYLOAD = 24 * 1024 * 1024; // ~18MB audio after base64
const ROOT = resolve(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const DIST = join(ROOT, 'dist');
const DATA_DIR = process.env.DATA_DIR || join(ROOT, 'data');

// ---- leaderboard store ----
// Two backends behind one async interface:
//  * Postgres — used when DATABASE_URL is set. This is what makes the global
//    leaderboard DURABLE on hosts with ephemeral filesystems (Render free
//    tier wipes local files on every deploy and idle spin-down). Any Postgres
//    works — e.g. a free Neon (neon.tech) database.
//  * SQLite  — zero-config fallback for local dev / hosts with real disks.

function makeSqliteStore() {
  mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(join(DATA_DIR, 'leaderboard.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS scores (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      chart_id   TEXT NOT NULL,
      song_id    TEXT NOT NULL DEFAULT '',
      title      TEXT NOT NULL DEFAULT '',
      artist     TEXT NOT NULL DEFAULT '',
      mode       TEXT NOT NULL DEFAULT '',
      difficulty TEXT NOT NULL DEFAULT '',
      player     TEXT NOT NULL,
      score      INTEGER NOT NULL,
      accuracy   REAL NOT NULL,
      grade      TEXT NOT NULL,
      max_combo  INTEGER NOT NULL,
      no_fail    INTEGER NOT NULL DEFAULT 0,
      failed     INTEGER NOT NULL DEFAULT 0,
      date_iso   TEXT NOT NULL,
      UNIQUE (chart_id, player)
    );
    CREATE INDEX IF NOT EXISTS idx_scores_chart ON scores (chart_id, score DESC);
  `);
  const stmtTop = db.prepare(
    `SELECT id, player, score, accuracy, grade, max_combo AS maxCombo, no_fail AS noFail, failed, date_iso AS dateIso
     FROM scores WHERE chart_id = ?
     ORDER BY score DESC, accuracy DESC, max_combo DESC, date_iso ASC LIMIT ?`,
  );
  const stmtGet = db.prepare('SELECT score, accuracy, max_combo FROM scores WHERE chart_id = ? AND player = ?');
  const stmtUpsert = db.prepare(
    `INSERT INTO scores (chart_id, song_id, title, artist, mode, difficulty, player, score, accuracy, grade, max_combo, no_fail, failed, date_iso)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (chart_id, player) DO UPDATE SET
       song_id = excluded.song_id, title = excluded.title, artist = excluded.artist,
       mode = excluded.mode, difficulty = excluded.difficulty, score = excluded.score,
       accuracy = excluded.accuracy, grade = excluded.grade, max_combo = excluded.max_combo,
       no_fail = excluded.no_fail, failed = excluded.failed, date_iso = excluded.date_iso`,
  );
  const stmtRank = db.prepare(
    `SELECT COUNT(*) AS above FROM scores WHERE chart_id = ?
     AND (score > ? OR (score = ? AND accuracy > ?) OR (score = ? AND accuracy = ? AND max_combo > ?))`,
  );
  const stmtTotal = db.prepare('SELECT COUNT(*) AS total FROM scores WHERE chart_id = ?');
  const stmtDelete = db.prepare('DELETE FROM scores WHERE id = ?');
  const stmtAdminUpdate = db.prepare(
    `UPDATE scores SET
       player = COALESCE(?, player), score = COALESCE(?, score), accuracy = COALESCE(?, accuracy),
       grade = COALESCE(?, grade), max_combo = COALESCE(?, max_combo)
     WHERE id = ?`,
  );

  // published charts: the admin's canonical version of each chart, served to all players
  db.exec(`
    CREATE TABLE IF NOT EXISTS charts (
      chart_id   TEXT PRIMARY KEY,
      song_id    TEXT NOT NULL,
      title      TEXT NOT NULL DEFAULT '',
      artist     TEXT NOT NULL DEFAULT '',
      bpm        REAL NOT NULL DEFAULT 120,
      offset_ms  INTEGER NOT NULL DEFAULT 0,
      mode       TEXT NOT NULL DEFAULT 'five',
      difficulty TEXT NOT NULL DEFAULT 'medium',
      keys_json  TEXT NOT NULL DEFAULT '[]',
      notes_json TEXT NOT NULL,
      updated_iso TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_charts_song ON charts (song_id);
  `);
  const stmtChartsBySong = db.prepare('SELECT * FROM charts WHERE song_id = ?');
  const stmtChartUpsert = db.prepare(
    `INSERT INTO charts (chart_id, song_id, title, artist, bpm, offset_ms, mode, difficulty, keys_json, notes_json, updated_iso)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (chart_id) DO UPDATE SET
       song_id = excluded.song_id, title = excluded.title, artist = excluded.artist,
       bpm = excluded.bpm, offset_ms = excluded.offset_ms, mode = excluded.mode,
       difficulty = excluded.difficulty, keys_json = excluded.keys_json,
       notes_json = excluded.notes_json, updated_iso = excluded.updated_iso`,
  );
  const stmtChartDelete = db.prepare('DELETE FROM charts WHERE chart_id = ?');

  // song recommendations from players
  db.exec(`
    CREATE TABLE IF NOT EXISTS recommendations (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      title    TEXT NOT NULL,
      artist   TEXT NOT NULL,
      player   TEXT NOT NULL DEFAULT '',
      date_iso TEXT NOT NULL
    );
  `);
  const stmtRecList = db.prepare('SELECT id, title, artist, player, date_iso AS dateIso FROM recommendations ORDER BY id DESC LIMIT ?');
  const stmtRecAdd = db.prepare('INSERT INTO recommendations (title, artist, player, date_iso) VALUES (?, ?, ?, ?)');
  const stmtRecDel = db.prepare('DELETE FROM recommendations WHERE id = ?');

  return {
    kind: 'sqlite',
    async recommendations(limit) {
      return stmtRecList.all(limit);
    },
    async addRecommendation(r) {
      stmtRecAdd.run(r.title, r.artist, r.player, r.dateIso);
    },
    async deleteRecommendation(id) {
      return Number(stmtRecDel.run(id).changes);
    },
    async chartsForSong(songId) {
      return stmtChartsBySong.all(songId);
    },
    async putChart(c) {
      stmtChartUpsert.run(c.chart_id, c.song_id, c.title, c.artist, c.bpm, c.offset_ms, c.mode,
        c.difficulty, c.keys_json, c.notes_json, c.updated_iso);
    },
    async deleteChart(chartId) {
      return Number(stmtChartDelete.run(chartId).changes);
    },
    async top(chartId, limit) {
      return stmtTop.all(chartId, limit);
    },
    async getBest(chartId, player) {
      return stmtGet.get(chartId, player);
    },
    async upsert(r) {
      stmtUpsert.run(r.chartId, r.songId, r.title, r.artist, r.mode, r.difficulty, r.player,
        r.score, r.accuracy, r.grade, r.maxCombo, r.noFail, r.failed, r.dateIso);
    },
    async rank(chartId, score, accuracy, maxCombo) {
      const above = stmtRank.get(chartId, score, score, accuracy, score, accuracy, maxCombo).above;
      const total = stmtTotal.get(chartId).total;
      return { rank: Number(above) + 1, total: Number(total) };
    },
    async remove(id) {
      return Number(stmtDelete.run(id).changes);
    },
    async adminUpdate(id, p) {
      return Number(stmtAdminUpdate.run(p.player, p.score, p.accuracy, p.grade, p.maxCombo, id).changes);
    },
  };
}

async function makePgStore(url) {
  const { default: pg } = await import('pg');
  // hosted Postgres (Neon, Render, Supabase…) requires TLS; local doesn't
  const ssl = /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false };
  const pool = new pg.Pool({ connectionString: url, ssl, max: 5 });
  // INTEGER/DOUBLE columns (not BIGINT) so node-postgres returns numbers, not strings
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scores (
      id         SERIAL PRIMARY KEY,
      chart_id   TEXT NOT NULL,
      song_id    TEXT NOT NULL DEFAULT '',
      title      TEXT NOT NULL DEFAULT '',
      artist     TEXT NOT NULL DEFAULT '',
      mode       TEXT NOT NULL DEFAULT '',
      difficulty TEXT NOT NULL DEFAULT '',
      player     TEXT NOT NULL,
      score      INTEGER NOT NULL,
      accuracy   DOUBLE PRECISION NOT NULL,
      grade      TEXT NOT NULL,
      max_combo  INTEGER NOT NULL,
      no_fail    INTEGER NOT NULL DEFAULT 0,
      failed     INTEGER NOT NULL DEFAULT 0,
      date_iso   TEXT NOT NULL,
      UNIQUE (chart_id, player)
    )`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_scores_chart ON scores (chart_id, score DESC)');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS charts (
      chart_id   TEXT PRIMARY KEY,
      song_id    TEXT NOT NULL,
      title      TEXT NOT NULL DEFAULT '',
      artist     TEXT NOT NULL DEFAULT '',
      bpm        DOUBLE PRECISION NOT NULL DEFAULT 120,
      offset_ms  INTEGER NOT NULL DEFAULT 0,
      mode       TEXT NOT NULL DEFAULT 'five',
      difficulty TEXT NOT NULL DEFAULT 'medium',
      keys_json  TEXT NOT NULL DEFAULT '[]',
      notes_json TEXT NOT NULL,
      updated_iso TEXT NOT NULL
    )`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_charts_song ON charts (song_id)');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recommendations (
      id       SERIAL PRIMARY KEY,
      title    TEXT NOT NULL,
      artist   TEXT NOT NULL,
      player   TEXT NOT NULL DEFAULT '',
      date_iso TEXT NOT NULL
    )`);
  return {
    kind: 'postgres',
    async recommendations(limit) {
      const r = await pool.query('SELECT id, title, artist, player, date_iso AS "dateIso" FROM recommendations ORDER BY id DESC LIMIT $1', [limit]);
      return r.rows;
    },
    async addRecommendation(rec) {
      await pool.query('INSERT INTO recommendations (title, artist, player, date_iso) VALUES ($1,$2,$3,$4)', [rec.title, rec.artist, rec.player, rec.dateIso]);
    },
    async deleteRecommendation(id) {
      return (await pool.query('DELETE FROM recommendations WHERE id = $1', [id])).rowCount;
    },
    async chartsForSong(songId) {
      const r = await pool.query('SELECT * FROM charts WHERE song_id = $1', [songId]);
      return r.rows;
    },
    async putChart(c) {
      await pool.query(
        `INSERT INTO charts (chart_id, song_id, title, artist, bpm, offset_ms, mode, difficulty, keys_json, notes_json, updated_iso)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (chart_id) DO UPDATE SET
           song_id = EXCLUDED.song_id, title = EXCLUDED.title, artist = EXCLUDED.artist,
           bpm = EXCLUDED.bpm, offset_ms = EXCLUDED.offset_ms, mode = EXCLUDED.mode,
           difficulty = EXCLUDED.difficulty, keys_json = EXCLUDED.keys_json,
           notes_json = EXCLUDED.notes_json, updated_iso = EXCLUDED.updated_iso`,
        [c.chart_id, c.song_id, c.title, c.artist, c.bpm, c.offset_ms, c.mode, c.difficulty, c.keys_json, c.notes_json, c.updated_iso],
      );
    },
    async deleteChart(chartId) {
      return (await pool.query('DELETE FROM charts WHERE chart_id = $1', [chartId])).rowCount;
    },
    async top(chartId, limit) {
      const r = await pool.query(
        `SELECT id, player, score, accuracy, grade, max_combo AS "maxCombo", no_fail AS "noFail", failed, date_iso AS "dateIso"
         FROM scores WHERE chart_id = $1
         ORDER BY score DESC, accuracy DESC, max_combo DESC, date_iso ASC LIMIT $2`,
        [chartId, limit],
      );
      return r.rows;
    },
    async getBest(chartId, player) {
      const r = await pool.query('SELECT score, accuracy, max_combo FROM scores WHERE chart_id = $1 AND player = $2', [chartId, player]);
      return r.rows[0];
    },
    async upsert(rec) {
      await pool.query(
        `INSERT INTO scores (chart_id, song_id, title, artist, mode, difficulty, player, score, accuracy, grade, max_combo, no_fail, failed, date_iso)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (chart_id, player) DO UPDATE SET
           song_id = EXCLUDED.song_id, title = EXCLUDED.title, artist = EXCLUDED.artist,
           mode = EXCLUDED.mode, difficulty = EXCLUDED.difficulty, score = EXCLUDED.score,
           accuracy = EXCLUDED.accuracy, grade = EXCLUDED.grade, max_combo = EXCLUDED.max_combo,
           no_fail = EXCLUDED.no_fail, failed = EXCLUDED.failed, date_iso = EXCLUDED.date_iso`,
        [rec.chartId, rec.songId, rec.title, rec.artist, rec.mode, rec.difficulty, rec.player,
          rec.score, rec.accuracy, rec.grade, rec.maxCombo, rec.noFail, rec.failed, rec.dateIso],
      );
    },
    async rank(chartId, score, accuracy, maxCombo) {
      const above = await pool.query(
        `SELECT COUNT(*)::int AS above FROM scores WHERE chart_id = $1
         AND (score > $2 OR (score = $2 AND accuracy > $3) OR (score = $2 AND accuracy = $3 AND max_combo > $4))`,
        [chartId, score, accuracy, maxCombo],
      );
      const total = await pool.query('SELECT COUNT(*)::int AS total FROM scores WHERE chart_id = $1', [chartId]);
      return { rank: above.rows[0].above + 1, total: total.rows[0].total };
    },
    async remove(id) {
      return (await pool.query('DELETE FROM scores WHERE id = $1', [id])).rowCount;
    },
    async adminUpdate(id, p) {
      const r = await pool.query(
        `UPDATE scores SET
           player = COALESCE($1, player), score = COALESCE($2, score), accuracy = COALESCE($3, accuracy),
           grade = COALESCE($4, grade), max_combo = COALESCE($5, max_combo)
         WHERE id = $6`,
        [p.player, p.score, p.accuracy, p.grade, p.maxCombo, id],
      );
      return r.rowCount;
    },
  };
}

let store;
if (process.env.DATABASE_URL) {
  try {
    store = await makePgStore(process.env.DATABASE_URL);
    console.log('Leaderboard store: Postgres (durable)');
  } catch (err) {
    console.error('Postgres init failed — falling back to SQLite (scores will NOT survive restarts):', err?.message || err);
    store = makeSqliteStore();
  }
} else {
  store = makeSqliteStore();
  console.log(`Leaderboard store: SQLite in ${DATA_DIR} — ephemeral on Render's free tier; set DATABASE_URL for a durable board`);
}

// ---- admin auth ----
// Credentials live server-side only; override the defaults with env vars.
const ADMIN_USER = process.env.ADMIN_USER || 'Midnight';
const ADMIN_PASS = process.env.ADMIN_PASS || 'abewashere1';
const ADMIN_TOKEN_TTL = 12 * 60 * 60 * 1000;
const adminTokens = new Map(); // token -> expiry epoch ms

const safeEq = (a, b) => {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
};

function isAdmin(req) {
  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const exp = adminTokens.get(token);
  if (!exp) return false;
  if (Date.now() > exp) {
    adminTokens.delete(token);
    return false;
  }
  return true;
}

const GRADES = new Set(['SS', 'S', 'A', 'B', 'C', 'D', 'F']);
const MODES = new Set(['five', 'keyboard', 'letters']);
const DIFFICULTIES = new Set(['easy', 'medium', 'hard', 'expert']);

const clampNum = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));
const cleanStr = (v, max) => String(v ?? '').slice(0, max);
const safeParse = (s, fallback) => {
  try {
    const v = JSON.parse(s);
    return v ?? fallback;
  } catch {
    return fallback;
  }
};

const MAX_NOTES = 20000;

/** Validate a chart the admin is publishing; returns a DB row or null. */
function normalizeChart(c) {
  const chartId = cleanStr(c?.id ?? c?.chartId, 128).trim();
  const songId = cleanStr(c?.songId, 128).trim();
  if (!chartId || !songId) return null;
  if (!MODES.has(c.mode)) return null;
  if (!DIFFICULTIES.has(c.difficulty)) return null;
  if (!Array.isArray(c.notes)) return null;
  const notes = c.notes.slice(0, MAX_NOTES).map((n) => ({
    beat: clampNum(n.beat, 0, 1e6),
    lane: Math.round(clampNum(n.lane, 0, 200)),
    durBeats: clampNum(n.durBeats, 0, 1e4),
  }));
  const keys = Array.isArray(c.keys) ? c.keys.slice(0, 64).map((k) => cleanStr(k, 8)) : [];
  return {
    chart_id: chartId,
    song_id: songId,
    title: cleanStr(c.title, 200),
    artist: cleanStr(c.artist, 200),
    bpm: clampNum(c.bpm, 20, 400) || 120,
    offset_ms: Math.round(clampNum(c.offsetMs, -100000, 100000)),
    mode: c.mode,
    difficulty: c.difficulty,
    keys_json: JSON.stringify(keys),
    notes_json: JSON.stringify(notes),
    updated_iso: new Date().toISOString(),
  };
}

/** Validate a submitted run; returns a normalized record or null. */
function normalizeScore(body) {
  const chartId = cleanStr(body.chartId, 128).trim();
  const player = cleanStr(body.player, 24).trim();
  if (!chartId || !player) return null;
  if (Number(body.rate) !== 1) return null; // only 1x runs are ranked
  if (body.failed) return null; // failed runs are never ranked
  return {
    chartId,
    songId: cleanStr(body.songId, 128),
    title: cleanStr(body.title, 200),
    artist: cleanStr(body.artist, 200),
    mode: MODES.has(body.mode) ? body.mode : '',
    difficulty: DIFFICULTIES.has(body.difficulty) ? body.difficulty : '',
    player,
    score: Math.round(clampNum(body.score, 0, 1e9)),
    accuracy: clampNum(body.accuracy, 0, 1),
    grade: GRADES.has(body.grade) ? body.grade : 'F',
    maxCombo: Math.round(clampNum(body.maxCombo, 0, 1e6)),
    noFail: body.noFail ? 1 : 0,
    failed: body.failed ? 1 : 0,
    dateIso: new Date().toISOString(),
  };
}

const API_HEADERS = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
};

const sendJson = (res, status, obj) => res.writeHead(status, API_HEADERS).end(JSON.stringify(obj));

function readBody(req, limit = 16 * 1024) {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        rejectBody(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rejectBody);
  });
}

async function handleApi(req, res, url) {
  if (req.method === 'OPTIONS') return res.writeHead(204, API_HEADERS).end();

  if (url.pathname === '/api/leaderboard' && req.method === 'GET') {
    const chartId = String(url.searchParams.get('chartId') || '').slice(0, 128);
    if (!chartId) return sendJson(res, 400, { error: 'chartId required' });
    const limit = Math.round(clampNum(url.searchParams.get('limit') ?? 10, 1, 100));
    const scores = (await store.top(chartId, limit)).map((r) => ({ ...r, noFail: !!r.noFail, failed: !!r.failed }));
    return sendJson(res, 200, { scores, total: (await store.rank(chartId, -1, -1, -1)).total });
  }

  if (url.pathname === '/api/scores' && req.method === 'POST') {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: 'invalid JSON' });
    }
    const rec = normalizeScore(body);
    if (!rec) return sendJson(res, 400, { error: 'invalid score payload (failed and non-1x-rate runs are not ranked)' });
    if (rec.player.toLowerCase() === 'mrpasionfruit' && !isAdmin(req)) {
      return sendJson(res, 400, { error: 'that player name is reserved for the admin' });
    }

    // keep each player's best run per chart
    const existing = await store.getBest(rec.chartId, rec.player);
    const improved =
      !existing ||
      rec.score > existing.score ||
      (rec.score === existing.score &&
        (rec.accuracy > existing.accuracy ||
          (rec.accuracy === existing.accuracy && rec.maxCombo > existing.max_combo)));
    if (improved) await store.upsert(rec);
    const best = improved ? rec : { score: Number(existing.score), accuracy: Number(existing.accuracy), maxCombo: Number(existing.max_combo) };
    return sendJson(res, 200, { ok: true, improved, ...(await store.rank(rec.chartId, best.score, best.accuracy, best.maxCombo)) });
  }

  // ---- published charts (admin publishes the canonical version for everyone) ----
  if (url.pathname === '/api/charts' && req.method === 'GET') {
    const songId = String(url.searchParams.get('songId') || '').slice(0, 128);
    if (!songId) return sendJson(res, 400, { error: 'songId required' });
    const rows = await store.chartsForSong(songId);
    const charts = rows.map((r) => ({
      chartId: r.chart_id,
      songId: r.song_id,
      title: r.title,
      artist: r.artist,
      bpm: Number(r.bpm),
      offsetMs: Number(r.offset_ms),
      mode: r.mode,
      difficulty: r.difficulty,
      keys: safeParse(r.keys_json, []),
      notes: safeParse(r.notes_json, []),
      updatedIso: r.updated_iso,
    }));
    return sendJson(res, 200, { charts });
  }

  if (url.pathname === '/api/charts' && req.method === 'POST') {
    if (!isAdmin(req)) return sendJson(res, 401, { error: 'admin login required to publish charts' });
    let body;
    try {
      body = JSON.parse(await readBody(req, 8 * 1024 * 1024));
    } catch {
      return sendJson(res, 400, { error: 'invalid JSON' });
    }
    const charts = Array.isArray(body?.charts) ? body.charts : [];
    if (!charts.length) return sendJson(res, 400, { error: 'no charts to publish' });
    let published = 0;
    for (const c of charts) {
      const rec = normalizeChart(c);
      if (!rec) continue;
      await store.putChart(rec);
      published++;
    }
    if (!published) return sendJson(res, 400, { error: 'no valid charts in payload' });
    return sendJson(res, 200, { ok: true, published });
  }

  if (url.pathname === '/api/charts' && req.method === 'DELETE') {
    if (!isAdmin(req)) return sendJson(res, 401, { error: 'admin login required' });
    const chartId = String(url.searchParams.get('chartId') || '').slice(0, 128);
    if (!chartId) return sendJson(res, 400, { error: 'chartId required' });
    return sendJson(res, 200, { ok: true, deleted: await store.deleteChart(chartId) });
  }

  // ---- song recommendations (anyone can suggest; admins can prune) ----
  if (url.pathname === '/api/recommendations' && req.method === 'GET') {
    return sendJson(res, 200, { recommendations: await store.recommendations(200) });
  }

  if (url.pathname === '/api/recommendations' && req.method === 'POST') {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: 'invalid JSON' });
    }
    const title = cleanStr(body.title, 120).trim();
    const artist = cleanStr(body.artist, 120).trim();
    if (!title || !artist) return sendJson(res, 400, { error: 'title and artist required' });
    let recPlayer = cleanStr(body.player, 24).trim();
    if (recPlayer.toLowerCase() === 'mrpasionfruit' && !isAdmin(req)) recPlayer = '';
    await store.addRecommendation({ title, artist, player: recPlayer, dateIso: new Date().toISOString() });
    return sendJson(res, 200, { ok: true });
  }

  if (url.pathname === '/api/recommendations' && req.method === 'DELETE') {
    if (!isAdmin(req)) return sendJson(res, 401, { error: 'admin login required' });
    const id = Math.round(Number(url.searchParams.get('id')));
    if (!Number.isFinite(id) || id <= 0) return sendJson(res, 400, { error: 'id required' });
    return sendJson(res, 200, { ok: true, deleted: await store.deleteRecommendation(id) });
  }

  if (url.pathname === '/api/admin/login' && req.method === 'POST') {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: 'invalid JSON' });
    }
    const userOk = safeEq(body?.username ?? '', ADMIN_USER);
    const passOk = safeEq(body?.password ?? '', ADMIN_PASS);
    if (!userOk || !passOk) {
      await new Promise((r) => setTimeout(r, 400)); // slow down guessing
      return sendJson(res, 401, { error: 'invalid credentials' });
    }
    const token = randomUUID();
    const now = Date.now();
    for (const [t, exp] of adminTokens) if (exp < now) adminTokens.delete(t);
    adminTokens.set(token, now + ADMIN_TOKEN_TTL);
    return sendJson(res, 200, { ok: true, token });
  }

  if (url.pathname === '/api/admin/scores' && (req.method === 'DELETE' || req.method === 'PATCH')) {
    if (!isAdmin(req)) return sendJson(res, 401, { error: 'admin login required' });
    const id = Math.round(Number(url.searchParams.get('id')));
    if (!Number.isFinite(id) || id <= 0) return sendJson(res, 400, { error: 'id required' });

    if (req.method === 'DELETE') {
      return sendJson(res, 200, { ok: true, deleted: await store.remove(id) });
    }

    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: 'invalid JSON' });
    }
    const player = body.player !== undefined ? cleanStr(body.player, 24).trim() || null : null;
    const score = body.score !== undefined ? Math.round(clampNum(body.score, 0, 1e9)) : null;
    const accuracy = body.accuracy !== undefined ? clampNum(body.accuracy, 0, 1) : null;
    const grade = body.grade !== undefined && GRADES.has(body.grade) ? body.grade : null;
    const maxCombo = body.maxCombo !== undefined ? Math.round(clampNum(body.maxCombo, 0, 1e6)) : null;
    return sendJson(res, 200, { ok: true, updated: await store.adminUpdate(id, { player, score, accuracy, grade, maxCombo }) });
  }

  return sendJson(res, 404, { error: 'not found' });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.mp3': 'audio/mpeg',
  '.otf': 'font/otf',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res, url);
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { error: String(err?.message || err) });
    }
    return;
  }
  try {
    let path = decodeURIComponent(url.pathname);
    if (path === '/') path = '/index.html';
    let file = resolve(join(DIST, path));
    if (file !== DIST && !file.startsWith(DIST + sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    let data;
    try {
      data = await readFile(file);
    } catch {
      file = join(DIST, 'index.html'); // SPA fallback
      data = await readFile(file);
    }
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('TextHero lobby server is running. Build the client (npm run build) to serve the game from here too.');
  }
});

const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_SONG_PAYLOAD });
const rooms = new Map(); // code -> room

let nextId = 1;
const genId = () => `p${nextId++}`;
const genCode = () => {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += String.fromCharCode(65 + Math.floor(Math.random() * 26));
    if (!rooms.has(c)) return c;
  }
};

const send = (ws, msg) => {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
};

function lobbyMsgFor(room, playerId) {
  return {
    t: 'lobby',
    lobby: {
      code: room.code,
      hostId: room.hostId,
      youId: playerId,
      players: [...room.players.values()].map((p) => ({ id: p.id, name: p.name, ready: p.ready })),
      config: room.config,
      isPublic: room.isPublic,
      maxPlayers: room.maxPlayers,
      songInfo: room.songInfo,
    },
  };
}

function broadcastLobby(room) {
  for (const p of room.players.values()) send(p.ws, lobbyMsgFor(room, p.id));
}

function closeRoom(room) {
  rooms.delete(room.code);
}

function leaveRoom(player) {
  const room = player.room;
  if (!room) return;
  room.players.delete(player.id);
  player.room = null;
  if (room.players.size === 0) return closeRoom(room);
  if (room.hostId === player.id) {
    room.hostId = room.players.keys().next().value;
  }
  broadcastLobby(room);
  maybeFinish(room);
}

function maybeFinish(room) {
  if (!room.inGame) return;
  const players = [...room.players.values()];
  if (players.length && players.every((p) => p.result)) {
    const results = players
      .map((p) => ({ playerId: p.id, name: p.name, ...p.result }))
      .sort((a, b) => b.score - a.score || b.accuracy - a.accuracy || b.maxCombo - a.maxCombo);
    for (const p of players) {
      send(p.ws, { t: 'results', results });
      p.result = null;
      p.ready = false;
    }
    room.inGame = false;
    broadcastLobby(room);
  }
}

wss.on('connection', (ws) => {
  const player = { id: genId(), ws, name: 'Player', ready: false, room: null, result: null };

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    const room = player.room;

    switch (msg.t) {
      case 'create': {
        if (room) leaveRoom(player);
        player.name = String(msg.name || 'Player').slice(0, 24);
        const code = genCode();
        const r = {
          code,
          hostId: player.id,
          players: new Map([[player.id, player]]),
          config: msg.config ?? {},
          isPublic: !!msg.isPublic,
          maxPlayers: Math.min(4, Math.max(1, Number(msg.maxPlayers) || 4)),
          songInfo: null,
          songPayload: null,
          inGame: false,
        };
        player.room = r;
        player.ready = false;
        rooms.set(code, r);
        broadcastLobby(r);
        break;
      }
      case 'join': {
        if (room) leaveRoom(player);
        const r = rooms.get(String(msg.code || '').toUpperCase());
        if (!r) return send(ws, { t: 'error', message: 'Lobby not found' });
        if (r.players.size >= r.maxPlayers) return send(ws, { t: 'error', message: 'Lobby is full' });
        if (r.inGame) return send(ws, { t: 'error', message: 'Match in progress' });
        player.name = String(msg.name || 'Player').slice(0, 24);
        player.ready = false;
        player.room = r;
        r.players.set(player.id, player);
        if (r.songPayload) send(ws, { t: 'songdata', payload: r.songPayload });
        broadcastLobby(r);
        break;
      }
      case 'leave':
        leaveRoom(player);
        break;
      case 'list': {
        const list = [...rooms.values()]
          .filter((r) => r.isPublic && !r.inGame && r.players.size < r.maxPlayers)
          .slice(0, 50)
          .map((r) => ({
            code: r.code,
            host: r.players.get(r.hostId)?.name ?? '?',
            players: r.players.size,
            maxPlayers: r.maxPlayers,
            songTitle: r.songInfo?.title ?? null,
          }));
        send(ws, { t: 'lobbies', list });
        break;
      }
      case 'ready':
        if (!room) return;
        player.ready = !!msg.ready;
        broadcastLobby(room);
        break;
      case 'config':
        if (!room || room.hostId !== player.id) return;
        room.config = msg.config ?? {};
        broadcastLobby(room);
        break;
      case 'songdata': {
        if (!room || room.hostId !== player.id) return;
        room.songPayload = msg.payload;
        room.songInfo = msg.payload?.song
          ? {
              title: msg.payload.song.title,
              artist: msg.payload.song.artist,
              mode: msg.payload.chart?.mode,
              difficulty: msg.payload.chart?.difficulty,
            }
          : null;
        for (const p of room.players.values()) {
          if (p.id !== player.id) send(p.ws, { t: 'songdata', payload: room.songPayload });
        }
        broadcastLobby(room);
        break;
      }
      case 'start': {
        if (!room || room.hostId !== player.id || room.inGame) return;
        if (!room.songPayload) return send(ws, { t: 'error', message: 'No song selected' });
        const everyoneReady = [...room.players.values()].every((p) => p.ready || p.id === room.hostId);
        if (!everyoneReady) return send(ws, { t: 'error', message: 'Not everyone is ready' });
        room.inGame = true;
        for (const p of room.players.values()) {
          p.result = null;
          send(p.ws, { t: 'start', inMs: 3000 });
        }
        break;
      }
      case 'progress': {
        if (!room) return;
        // input events ride along so peers can render this player's gameplay live
        const events = Array.isArray(msg.events) ? msg.events.slice(0, 400) : undefined;
        for (const p of room.players.values()) {
          if (p.id !== player.id)
            send(p.ws, {
              t: 'progress',
              playerId: player.id,
              name: player.name,
              score: msg.score,
              accuracy: msg.accuracy,
              combo: msg.combo,
              multiplier: msg.multiplier,
              health: msg.health,
              done: !!msg.done,
              events,
            });
        }
        break;
      }
      case 'pause':
        // any player pausing freezes the whole match; any player may resume
        if (!room || !room.inGame) return;
        for (const p of room.players.values()) {
          if (p.id !== player.id) send(p.ws, { t: 'pause', paused: !!msg.paused, playerId: player.id, name: player.name });
        }
        break;
      case 'finish':
        if (!room) return;
        player.result = {
          score: Number(msg.result?.score) || 0,
          accuracy: Number(msg.result?.accuracy) || 0,
          grade: String(msg.result?.grade || 'F'),
          maxCombo: Number(msg.result?.maxCombo) || 0,
          failed: !!msg.result?.failed,
        };
        maybeFinish(room);
        break;
    }
  });

  ws.on('close', () => leaveRoom(player));
});

httpServer.listen(PORT, () => {
  console.log(`TextHero server listening on http://localhost:${PORT} (game + ws lobby)`);
});
