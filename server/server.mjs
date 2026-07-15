// TextHero lobby server: relays lobby state, chart/audio payloads, the start
// signal, and live progress. Scoring stays on the clients (deterministic engine).
//   npm run server   (default port 8137, override with PORT env var)
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 8137);
const MAX_SONG_PAYLOAD = 24 * 1024 * 1024; // ~18MB audio after base64

const wss = new WebSocketServer({ port: PORT, maxPayload: MAX_SONG_PAYLOAD });
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
      case 'progress':
        if (!room) return;
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
            });
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

console.log(`TextHero lobby server listening on ws://localhost:${PORT}`);
