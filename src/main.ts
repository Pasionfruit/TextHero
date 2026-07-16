import type { AppCtx, Screen, ScreenFactory, ScreenName } from './app';
import { AudioEngine } from './audio/AudioEngine';
import { buildDemoCharts, demoSongData } from './charts/chart';
import { NetClient } from './net/NetClient';
import { DB } from './store/db';
import { importBundledSongs, libraryChanged } from './store/bundled';
import { applyTheme, loadSettings, saveSettings } from './store/settings';
import { toast } from './util';
import { menuScreen } from './screens/menu';
import { songSelectScreen } from './screens/songselect';
import { playScreen } from './screens/play';
import { resultsScreen } from './screens/results';
import { editorScreen } from './screens/editor';
import { settingsScreen } from './screens/settings';
import { lobbyScreen } from './screens/lobby';

const SCREENS: Record<ScreenName, ScreenFactory> = {
  menu: menuScreen,
  songselect: songSelectScreen,
  play: playScreen,
  results: resultsScreen,
  editor: editorScreen,
  settings: settingsScreen,
  lobby: lobbyScreen,
};

async function boot(): Promise<void> {
  const root = document.getElementById('app')!;
  const db = await DB.open();
  const settings = loadSettings();
  applyTheme(settings);
  const audio = new AudioEngine();
  audio.setVolume(settings.volume);
  const net = new NetClient();

  // seed the built-in demo song + any missing demo charts (first run, wipe, or new
  // built-in modes added in an update) without clobbering user edits
  const demo = demoSongData();
  const existingDemo = await db.get('songs', demo.id);
  if (!existingDemo) await db.put('songs', demo);
  else if (!existingDemo.genre) await db.put('songs', { ...existingDemo, genre: demo.genre });
  for (const chart of buildDemoCharts()) {
    if (!(await db.get('charts', chart.id))) await db.put('charts', chart);
  }

  // import bundled mp3s (src/audio) in the background; songs appear in the
  // library one by one as each finishes decoding + auto-charting
  void importBundledSongs(db, audio, () => libraryChanged()).then((n) => {
    if (n > 0) toast(`${n} bundled song${n === 1 ? '' : 's'} added to the library`);
  });

  let current: Screen | null = null;
  const ctx: AppCtx = {
    db,
    settings,
    audio,
    net,
    saveSettings: () => saveSettings(settings),
    nav(screen: ScreenName, params: any = {}) {
      current?.destroy();
      document.body.style.fontFamily = settings.fontFamily;
      applyTheme(settings);
      current = SCREENS[screen](root, ctx, params);
    },
  };

  // browsers require a user gesture before audio can start
  const unlock = () => void audio.ensureRunning();
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);

  ctx.nav('menu');
}

void boot();
