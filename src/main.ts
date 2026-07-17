import type { AppCtx, Screen, ScreenFactory, ScreenName } from './app';
import { AudioEngine } from './audio/AudioEngine';
import { MENU_MUSIC } from './audio/uiSounds';
import { buildDemoCharts, demoSongData } from './charts/chart';
import { NetClient } from './net/NetClient';
import { DB } from './store/db';
import { importBundledSongs, libraryChanged } from './store/bundled';
import { applyTheme, loadSettings, saveSettings } from './store/settings';
import { icon } from './ui/icons';
import { el, toast } from './util';
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

/** Decorative fixed backdrop: five wavy lane-colored lines with note-dots
 *  scattered at random — echoes the gameplay highway. Regenerated per load. */
function buildBackdrop(): void {
  const LANE_COLORS = ['#43d675', '#e5484d', '#f5d90a', '#3b82f6', '#f97316'];
  const W = 1600;
  const H = 900;
  let inner = '';
  LANE_COLORS.forEach((color, i) => {
    const y = 90 + (i * (H - 180)) / 4 + (Math.random() * 60 - 30);
    const amp = (30 + Math.random() * 30) * (Math.random() < 0.5 ? 1 : -1);
    let d = `M -100 ${y.toFixed(0)} q 100 ${-amp.toFixed(0)} 200 0`;
    for (let x = 100; x < W + 200; x += 200) d += ' t 200 0';
    inner += `<path d="${d}" fill="none" stroke="${color}" stroke-width="2.5" opacity="0.12"/>`;
  });
  for (let i = 0; i < 28; i++) {
    inner += `<circle cx="${(Math.random() * W).toFixed(0)}" cy="${(Math.random() * H).toFixed(0)}" r="${(2.5 + Math.random() * 3.5).toFixed(1)}" fill="${LANE_COLORS[i % LANE_COLORS.length]}" opacity="${(0.18 + Math.random() * 0.25).toFixed(2)}"/>`;
  }
  const decor = document.createElement('div');
  decor.id = 'bg-decor';
  decor.setAttribute('aria-hidden', 'true');
  decor.innerHTML = `<svg width="100%" height="100%" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice">${inner}</svg>`;
  document.body.prepend(decor);
}

async function boot(): Promise<void> {
  buildBackdrop();
  const root = document.getElementById('app')!;
  const db = await DB.open();
  const settings = loadSettings();
  applyTheme(settings);
  const audio = new AudioEngine();
  audio.setVolume(settings.volume);
  audio.setMenuMusicVolume(settings.menuMusicVolume);
  const net = new NetClient();

  // chill background loop on every screen except gameplay and the editor
  // (both play their own audio); kicks in on the first user gesture
  const MUSIC_SCREENS = new Set<ScreenName>(['menu', 'songselect', 'settings', 'lobby', 'results']);
  let currentScreen: ScreenName = 'menu';
  const syncMusic = (): void => {
    if (MUSIC_SCREENS.has(currentScreen)) void audio.startMenuMusic(MENU_MUSIC);
    else audio.stopMenuMusic();
  };

  // icon-only theme toggle, top-right on every page except during play
  // (the pause menu carries its own toggle there)
  const themeBtn = el('button', { class: 'btn theme-toggle' });
  const updateThemeBtn = (): void => {
    themeBtn.title = settings.theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode';
    themeBtn.replaceChildren(icon(settings.theme === 'light' ? 'moon' : 'sun', 17));
  };
  themeBtn.onclick = () => {
    settings.theme = settings.theme === 'light' ? 'dark' : 'light';
    applyTheme(settings);
    saveSettings(settings);
    updateThemeBtn();
  };
  updateThemeBtn();
  document.body.append(themeBtn);

  // seed the built-in demo song + any missing demo charts (first run, wipe, or new
  // built-in modes added in an update) without clobbering user edits
  const demo = demoSongData();
  const existingDemo = await db.get('songs', demo.id);
  if (!existingDemo) await db.put('songs', demo);
  else {
    const patch: Partial<typeof demo> = {};
    if (!existingDemo.genre) patch.genre = demo.genre;
    if (existingDemo.artist === 'TextHero (built-in)') patch.artist = demo.artist; // rebrand migration
    if (Object.keys(patch).length) await db.put('songs', { ...existingDemo, ...patch });
  }
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
      themeBtn.style.display = screen === 'play' ? 'none' : '';
      updateThemeBtn();
      currentScreen = screen;
      syncMusic();
      current = SCREENS[screen](root, ctx, params);
    },
  };

  // browsers require a user gesture before audio can start; once unlocked,
  // (re)start the background music for the current screen
  const unlock = () => void audio.ensureRunning().then(syncMusic);
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);

  ctx.nav('menu');
}

void boot();

// PWA: register the service worker in production builds only (it would fight
// Vite's dev-server HMR otherwise)
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
