import type { AppCtx, PlayParams, PlayerSetup, Screen } from '../app';
import type { ChartData, SongData } from '../types';
import { b64ToBlob, blobToB64 } from '../net/NetClient';
import { modeLabel } from '../charts/chart';
import { codeLabel, el, toast } from '../util';
import { checkbox, row, selectInput } from './songselect';

export function lobbyScreen(root: HTMLElement, ctx: AppCtx, _params: any): Screen {
  root.innerHTML = '';
  const s = ctx.settings;
  const offs: Array<() => void> = [];
  let destroyed = false;

  const page = el('div', { class: 'page' });
  root.append(page);

  let tab: 'local' | 'online' = ctx.net.isConnected() ? 'online' : 'local';
  let songs: SongData[] = [];
  let charts: ChartData[] = [];
  let selSong: SongData | null = null;
  let selChart: ChartData | null = null;

  // local settings
  let playerCount = 2;
  let ruleset: 'competitive' | 'band' = 'competitive';
  let sharedHealth = true;
  let sharedCombo = false;
  let noFail = false;
  const names = ['', '', '', ''];

  // online settings
  let joinCode = '';
  let isPublic = true;
  let maxPlayers = 4;

  async function loadSongs(): Promise<void> {
    songs = (await ctx.db.songs()).sort((a, b) => a.title.localeCompare(b.title));
    selSong = songs.find((x) => x.id === selSong?.id) ?? songs[0] ?? null;
    await loadCharts();
  }

  async function loadCharts(): Promise<void> {
    charts = selSong ? await ctx.db.chartsForSong(selSong.id) : [];
    selChart = charts.find((c) => c.id === selChart?.id) ?? charts[0] ?? null;
  }

  function songPicker(onChange: () => void, fiveOnly: boolean): HTMLElement {
    const box = el('div');
    const chartsAvail = fiveOnly ? charts.filter((c) => c.mode === 'five') : charts;
    if (fiveOnly && selChart?.mode !== 'five') selChart = chartsAvail[0] ?? null;
    box.append(
      row('Song', selectInput(songs.map((x) => x.title), selSong?.title ?? '', (v) => {
        selSong = songs.find((x) => x.title === v) ?? null;
        void loadCharts().then(onChange);
      })),
      row('Chart', selectInput(
        chartsAvail.map((c) => `${modeLabel(c.mode)} · ${c.difficulty} (${c.notes.length})`),
        selChart ? `${modeLabel(selChart.mode)} · ${selChart.difficulty} (${selChart.notes.length})` : '',
        (v) => {
          selChart = chartsAvail.find((c) => `${modeLabel(c.mode)} · ${c.difficulty} (${c.notes.length})` === v) ?? null;
          onChange();
        },
      )),
    );
    return box;
  }

  // ---------- render ----------
  function render(): void {
    if (destroyed) return;
    page.innerHTML = '';
    page.append(
      el('div', { class: 'row spread' },
        el('h1', { class: 'page-title' }, 'Multiplayer'),
        el('button', { class: 'btn', onclick: () => ctx.nav('menu') }, 'Back'),
      ),
      el('div', { class: 'chip-row' },
        el('button', { class: 'chip' + (tab === 'local' ? ' active' : ''), onclick: () => { tab = 'local'; render(); } }, 'Local (shared keyboard)'),
        el('button', { class: 'chip' + (tab === 'online' ? ' active' : ''), onclick: () => { tab = 'online'; render(); } }, 'Online'),
      ),
    );
    if (tab === 'local') renderLocal();
    else renderOnline();
  }

  function renderLocal(): void {
    const panel = el('div', { class: 'panel' },
      el('h3', null, 'Players'),
      row('Player count', selectInput(['1', '2', '3', '4'], String(playerCount), (v) => { playerCount = Number(v); render(); })),
    );
    for (let i = 0; i < playerCount; i++) {
      const r = el('div', { class: 'form-row' },
        el('label', null, `P${i + 1}`),
        el('input', { type: 'text', placeholder: i === 0 ? s.playerName : `Player ${i + 1}`, value: names[i], style: { width: '120px' }, onchange: (e: Event) => (names[i] = (e.target as HTMLInputElement).value) }),
        el('span', { class: 'muted sm' }, (s.bindings[i] ?? []).map(codeLabel).join(' · ') + '  (rebind in Settings)'),
      );
      panel.append(r);
    }

    const rules = el('div', { class: 'panel' },
      el('h3', null, 'Rules'),
      row('Mode', selectInput(['competitive', 'band'], ruleset, (v) => { ruleset = v as any; render(); })),
    );
    if (ruleset === 'band') {
      rules.append(
        row('Shared health', checkbox(sharedHealth, (v) => (sharedHealth = v))),
        row('Shared combo & score', checkbox(sharedCombo, (v) => (sharedCombo = v))),
      );
    }
    rules.append(row('No Fail', checkbox(noFail, (v) => (noFail = v))));

    const songPanel = el('div', { class: 'panel' }, el('h3', null, 'Song'));
    songPanel.append(songPicker(render, playerCount > 1));
    if (playerCount > 1) songPanel.append(el('div', { class: 'muted sm' }, 'Local multiplayer uses five-key charts (keyboard/letters modes need a keyboard per player — play those online).'));

    page.append(panel, rules, songPanel,
      el('div', { class: 'btn-row' },
        el('button', {
          class: 'btn primary big',
          disabled: !selSong || !selChart,
          onclick: () => {
            if (!selSong || !selChart) return;
            const players: PlayerSetup[] = [];
            for (let i = 0; i < playerCount; i++) {
              players.push({ name: names[i] || (i === 0 ? s.playerName : `Player ${i + 1}`), codes: s.bindings[i] ?? s.bindings[0] });
            }
            const play: PlayParams = {
              song: selSong,
              chart: selChart,
              players,
              rate: 1,
              noFail,
              practice: false,
              band: ruleset === 'band' ? { sharedHealth, sharedCombo } : null,
            };
            ctx.nav('play', play);
          },
        }, 'Start'),
      ),
    );
  }

  // ---------- online ----------
  function renderOnline(): void {
    if (!ctx.net.isConnected()) {
      let url = s.serverUrl;
      page.append(el('div', { class: 'panel' },
        el('h3', null, 'Connect'),
        row('Server', el('input', { type: 'text', value: url, style: { width: '240px' }, onchange: (e: Event) => { url = (e.target as HTMLInputElement).value; } })),
        el('div', { class: 'muted sm' }, 'Run the bundled server with:  npm run server'),
        el('div', { class: 'btn-row' },
          el('button', {
            class: 'btn primary',
            onclick: async () => {
              try {
                s.serverUrl = url;
                ctx.saveSettings();
                await ctx.net.connect(url);
                toast('Connected');
                render();
              } catch (err) {
                toast((err as Error).message);
              }
            },
          }, 'Connect'),
        ),
      ));
      return;
    }

    if (!ctx.net.lobby) {
      const lobbiesBox = el('div', { class: 'panel' }, el('h3', null, 'Public lobbies'), el('div', { class: 'muted' }, 'Loading…'));
      ctx.net.send('list');
      page.append(
        el('div', { class: 'panel' },
          el('h3', null, 'Create lobby'),
          row('Public', checkbox(isPublic, (v) => (isPublic = v))),
          row('Player limit', selectInput(['1', '2', '3', '4'], String(maxPlayers), (v) => (maxPlayers = Number(v)))),
          el('div', { class: 'btn-row' },
            el('button', { class: 'btn primary', onclick: () => ctx.net.send('create', { name: s.playerName, isPublic, maxPlayers }) }, 'Create'),
          ),
        ),
        el('div', { class: 'panel' },
          el('h3', null, 'Join by code'),
          row('Code', el('input', { type: 'text', value: joinCode, maxlength: '4', style: { width: '90px', textTransform: 'uppercase' }, oninput: (e: Event) => (joinCode = (e.target as HTMLInputElement).value) })),
          el('div', { class: 'btn-row' },
            el('button', { class: 'btn primary', onclick: () => ctx.net.send('join', { code: joinCode, name: s.playerName }) }, 'Join'),
          ),
        ),
        lobbiesBox,
        el('div', { class: 'btn-row' },
          el('button', { class: 'btn', onclick: () => { ctx.net.disconnect(); render(); } }, 'Disconnect'),
        ),
      );
      offs.push(ctx.net.on('lobbies', (m) => {
        lobbiesBox.innerHTML = '';
        lobbiesBox.append(el('h3', null, 'Public lobbies'),
          el('button', { class: 'btn sm', onclick: () => ctx.net.send('list') }, 'Refresh'));
        if (!m.list.length) lobbiesBox.append(el('div', { class: 'muted' }, 'None open right now.'));
        for (const l of m.list) {
          lobbiesBox.append(el('div', { class: 'lb-row' },
            el('span', null, `${l.code} — ${l.host} (${l.players}/${l.maxPlayers})${l.songTitle ? ' · ' + l.songTitle : ''}`),
            el('button', { class: 'btn sm', onclick: () => ctx.net.send('join', { code: l.code, name: s.playerName }) }, 'Join'),
          ));
        }
      }));
      return;
    }

    // inside a lobby
    const lobby = ctx.net.lobby;
    const isHost = ctx.net.isHost();
    const me = lobby.players.find((p) => p.id === lobby.youId);

    const playersBox = el('div', { class: 'panel' }, el('h3', null, `Lobby ${lobby.code} ${lobby.isPublic ? '(public)' : '(private)'}`));
    for (const p of lobby.players) {
      playersBox.append(el('div', { class: 'lb-row' },
        el('span', null, `${p.name}${p.id === lobby.hostId ? ' 👑' : ''}${p.id === lobby.youId ? ' (you)' : ''}`),
        el('span', { class: p.ready ? 'ok' : 'muted' }, p.id === lobby.hostId ? 'host' : p.ready ? 'READY' : 'not ready'),
      ));
    }
    page.append(playersBox);

    const songBox = el('div', { class: 'panel' }, el('h3', null, 'Song'));
    if (isHost) {
      songBox.append(songPicker(() => { void hostSendSong(); render(); }, false));
      songBox.append(el('div', { class: 'muted sm' }, 'The chart (and audio for custom songs) is sent to everyone automatically.'));
      if (selSong && !ctx.net.songPayload) void hostSendSong();
    } else {
      const info = lobby.songInfo;
      songBox.append(el('div', { class: 'muted' }, info ? `${info.title} — ${info.artist} · ${info.mode} · ${info.difficulty}` : 'Waiting for host to pick a song…'));
    }
    page.append(songBox);

    const btns = el('div', { class: 'btn-row' });
    if (isHost) {
      btns.append(el('button', { class: 'btn primary big', onclick: () => ctx.net.send('start') }, 'Start match'));
    } else {
      btns.append(el('button', { class: 'btn primary', onclick: () => ctx.net.send('ready', { ready: !me?.ready }) }, me?.ready ? 'Unready' : 'Ready up'));
    }
    btns.append(el('button', { class: 'btn danger', onclick: () => { ctx.net.send('leave'); ctx.net.lobby = null; ctx.net.songPayload = null; render(); } }, 'Leave lobby'));
    page.append(btns);
  }

  async function hostSendSong(): Promise<void> {
    if (!selSong || !selChart || !ctx.net.isHost()) return;
    let audioB64: string | null = null;
    if (selSong.audioId) {
      const blob = await ctx.db.get<Blob>('audio', selSong.audioId);
      if (!blob) return toast('Audio blob missing');
      if (blob.size > 16 * 1024 * 1024) return toast('Song file too large to share (>16MB)');
      audioB64 = await blobToB64(blob);
    }
    const payload = { song: selSong, chart: selChart, audioB64 };
    ctx.net.songPayload = payload; // the server doesn't echo back to the sender
    ctx.net.send('songdata', { payload });
  }

  // ---------- net events ----------
  offs.push(ctx.net.on('lobby', () => render()));
  offs.push(ctx.net.on('error', (m) => toast(m.message)));
  offs.push(ctx.net.on('closed', () => {
    toast('Disconnected from server');
    render();
  }));
  offs.push(ctx.net.on('start', async (m) => {
    const payload = ctx.net.songPayload;
    if (!payload) return toast('No song payload received');
    // make sure the audio exists locally so the engine can load it
    if (payload.song.audioId && payload.audioB64) {
      const existing = await ctx.db.get<Blob>('audio', payload.song.audioId);
      if (!existing) await ctx.db.put('audio', b64ToBlob(payload.audioB64), payload.song.audioId);
    }
    const play: PlayParams = {
      song: payload.song,
      chart: payload.chart,
      players: [{ name: s.playerName, codes: s.bindings[0] }],
      rate: 1,
      noFail: false,
      practice: false,
      band: null,
      online: true,
    };
    setTimeout(() => ctx.nav('play', play), Math.max(0, (m.inMs ?? 3000) - 2200));
  }));

  void loadSongs().then(render);

  return {
    destroy() {
      destroyed = true;
      offs.forEach((f) => f());
    },
  };
}
