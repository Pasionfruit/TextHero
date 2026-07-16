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

/** Validate a submitted run; returns a normalized record or null. */
function normalizeScore(body) {
  const chartId = cleanStr(body.chartId, 128).trim();
  const player = cleanStr(body.player, 24).trim();
  if (!chartId || !player) return null;
  if (Number(body.rate) !== 1) return null; // only 1x runs are ranked
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

function rankOf(chartId, score, accuracy, maxCombo) {
  const above = stmtRank.get(chartId, score, score, accuracy, score, accuracy, maxCombo).above;
  const total = stmtTotal.get(chartId).total;
  return { rank: Number(above) + 1, total: Number(total) };
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
    const scores = stmtTop.all(chartId, limit).map((r) => ({ ...r, noFail: !!r.noFail, failed: !!r.failed }));
    return sendJson(res, 200, { scores, total: rankOf(chartId, -1, -1, -1).total });
  }

  if (url.pathname === '/api/scores' && req.method === 'POST') {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: 'invalid JSON' });
    }
    const rec = normalizeScore(body);
    if (!rec) return sendJson(res, 400, { error: 'invalid score payload (only 1x-rate runs are ranked)' });

    // keep each player's best run per chart
    const existing = stmtGet.get(rec.chartId, rec.player);
    const improved =
      !existing ||
      rec.score > existing.score ||
      (rec.score === existing.score &&
        (rec.accuracy > existing.accuracy ||
          (rec.accuracy === existing.accuracy && rec.maxCombo > existing.max_combo)));
    if (improved) {
      stmtUpsert.run(rec.chartId, rec.songId, rec.title, rec.artist, rec.mode, rec.difficulty, rec.player,
        rec.score, rec.accuracy, rec.grade, rec.maxCombo, rec.noFail, rec.failed, rec.dateIso);
    }
    const best = improved ? rec : { score: Number(existing.score), accuracy: Number(existing.accuracy), maxCombo: Number(existing.max_combo) };
    return sendJson(res, 200, { ok: true, improved, ...rankOf(rec.chartId, best.score, best.accuracy, best.maxCombo) });
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
      const r = stmtDelete.run(id);
      return sendJson(res, 200, { ok: true, deleted: Number(r.changes) });
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
    const r = stmtAdminUpdate.run(player, score, accuracy, grade, maxCombo, id);
    return sendJson(res, 200, { ok: true, updated: Number(r.changes) });
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
