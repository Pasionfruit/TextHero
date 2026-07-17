import type { AudioEngine } from '../audio/AudioEngine';
import type { ChartData, SongData } from '../types';
import type { DB } from './db';
import { analyzeSong, estimateGrid, generateSampleCharts } from '../charts/autochart';
import { makeEmptyChart } from '../charts/chart';

/**
 * Songs shipped with the game: every mp3 dropped into src/audio, named
 * "Title - Artist.mp3", is bundled by Vite and imported into the local library
 * in the background on boot. IDs are derived from the filename so every player
 * ends up with the same song/chart IDs — that's what lets the global
 * leaderboard rank everyone on the same board.
 */
const BUNDLED_MP3S = import.meta.glob('../audio/*.mp3', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const BUNDLED_PREFIX = 'bundled-';

/** Bump when the auto-chart generator improves: bundled charts regenerate on
 *  next boot (charts the player edited in the editor are left alone). */
const BUNDLED_CHART_GEN = 2;

export const isBundledSong = (songId: string): boolean => songId.startsWith(BUNDLED_PREFIX);

export const LIBRARY_CHANGED_EVENT = 'texthero:library-changed';
export const libraryChanged = (): void => {
  window.dispatchEvent(new Event(LIBRARY_CHANGED_EVENT));
};

interface BundledFile {
  id: string;
  title: string;
  artist: string;
  url: string;
  genre?: string;
}

/** Curated genres for the shipped library, keyed by filename slug. */
const BUNDLED_GENRES: Record<string, string> = {
  '6-foot-7-foot-lil-wayne-ft-cory-gunz': 'Hip-Hop',
  'all-the-small-things-blink-182': 'Pop Punk',
  'american-idiot-green-day': 'Punk Rock',
  'blue-bird-ikimono': 'J-Pop',
  'blue-hundreds-holy-mattress-money': 'Indie Rock',
  'dancing-in-the-moonlight-jubel-neimy': 'Dance Pop',
  'dear-maria-count-me-in-all-time-low': 'Pop Punk',
  'death-of-a-bachelor-panic-at-the-disco': 'Pop Rock',
  'dynamite-bts': 'K-Pop',
  'end-of-august-noah-kahan': 'Folk Pop',
  'feeling-juice-wrld': 'Hip-Hop',
  'fight-together-namie-amuro': 'J-Pop',
  'float-on-modest-mouse': 'Indie Rock',
  'fly-day-china-town-yasuha': 'City Pop',
  'free-bird-lynyrd-skynyrd': 'Southern Rock',
  'let-me-go-hailee-steinfeld-alesso-ft-florida-georgia-line-watt': 'Dance Pop',
  'gives-you-hell-the-all-american-rejects': 'Pop Rock',
  'go-flow': 'J-Rock',
  'good-riddance-green-day': 'Acoustic Rock',
  'hungry-like-the-wolf-duran-duran': 'New Wave',
  'i-just-might-bruno-mars': 'R&B',
  'i-took-a-pill-in-ibiza-mike-posner': 'Electropop',
  'it-never-rains-in-southern-california-albert-hammond': 'Soft Rock',
  'knock-you-down-keri-hilson-ft-kanye-west-ne-yo': 'R&B',
  'last-time-jxdn': 'Pop Punk',
  'love-me-not-ravyn-lenae': 'R&B',
  'mr-brightside-the-killers': 'Indie Rock',
  'nobodys-son-sabrina-carpenter': 'Pop',
  'please-don-t-go-mike-posner': 'Pop',
  'runaway-u-i-galantis': 'EDM',
  'silhoutte-kana-boon': 'J-Rock',
  'smells-like-summer-early-hours': 'Indie Pop',
  'so-what-jxdn': 'Pop Punk',
  'stacy-s-mom-fountains-of-wayne': 'Pop Rock',
  'still-into-you-paramore': 'Pop Rock',
  'supermassive-black-hole-muse': 'Alt Rock',
  'take-me-out-franz-ferdinand': 'Indie Rock',
  'teenagers-my-chemical-romance': 'Emo Rock',
  'the-middle-jimmy-eat-world': 'Pop Rock',
  'the-way-life-goes-lil-uzi-vert-ft-nicki-minaj': 'Hip-Hop',
  'took-her-to-the-o-king-von': 'Hip-Hop',
  'touches-the-walls-nico': 'J-Rock',
  'unity-thefatrat': 'EDM',
  'wake-me-up-when-september-ends-green-day': 'Rock',
  'welcome-to-new-york-taylor-swift': 'Pop',
  'welcome-to-the-black-parade-my-chemical-romance': 'Emo Rock',
  'wildest-dreams-taylor-swift': 'Pop',
};

function parseBundled(path: string, url: string): BundledFile {
  const file = decodeURIComponent(path.split('/').pop()!).replace(/\.mp3$/i, '');
  const sep = file.indexOf(' - ');
  const title = sep >= 0 ? file.slice(0, sep).trim() : file.trim();
  const artist = sep >= 0 ? file.slice(sep + 3).trim() : 'Unknown';
  const slug = file
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return { id: BUNDLED_PREFIX + slug, title, artist, url, genre: BUNDLED_GENRES[slug] };
}

/**
 * Import any bundled songs missing from the library (decode → analyze →
 * auto-chart, same pipeline as an upload). Runs sequentially so a fresh boot
 * stays responsive while dozens of songs trickle in; already-imported songs
 * only get their asset URL refreshed (it differs between dev and build).
 */
export async function importBundledSongs(db: DB, audio: AudioEngine, onImported?: (song: SongData) => void): Promise<number> {
  let imported = 0;
  for (const [path, url] of Object.entries(BUNDLED_MP3S)) {
    const meta = parseBundled(path, url);
    // files without a " - " separator are UI/system sounds (hover, click,
    // menu music), not library songs — skip them and remove stale imports
    if (!decodeURIComponent(path.split('/').pop()!).includes(' - ')) {
      try {
        if (await db.get<SongData>('songs', meta.id)) await db.deleteSong(meta.id);
      } catch {
        /* nothing stale */
      }
      continue;
    }
    try {
      const existing = await db.get<SongData>('songs', meta.id);
      if (existing) {
        let changed = false;
        if (existing.audioUrl !== url) {
          existing.audioUrl = url;
          changed = true;
        }
        if (!existing.genre && meta.genre) {
          existing.genre = meta.genre;
          changed = true;
        }
        if (changed) await db.put('songs', existing);
        if ((existing.chartGen ?? 1) < BUNDLED_CHART_GEN) {
          await regenerateCharts(db, audio, existing);
          onImported?.(existing);
        } else if (changed) {
          onImported?.(existing);
        }
        continue;
      }

      const res = await fetch(url);
      if (!res.ok) throw new Error(`fetch ${res.status}`);
      const buf = await audio.ctx.decodeAudioData(await res.arrayBuffer());
      const song: SongData = {
        id: meta.id,
        title: meta.title,
        artist: meta.artist,
        bpm: 120,
        offsetMs: 0,
        audioId: null,
        audioUrl: url,
        chartGen: BUNDLED_CHART_GEN,
        genre: meta.genre,
        durationMs: Math.round(buf.duration * 1000),
      };

      let charts: ChartData[] = [];
      try {
        const analysis = await analyzeSong(buf);
        const grid = estimateGrid(analysis);
        song.bpm = grid.bpm;
        song.offsetMs = grid.offsetMs;
        charts = generateSampleCharts(song, analysis);
      } catch {
        /* fall through to an empty chart */
      }
      if (!charts.length) charts = [makeEmptyChart(song.id, 'five', 'medium')];
      // deterministic chart IDs — shared leaderboard keys across all players
      for (const c of charts) c.id = `${song.id}-${c.mode}-${c.difficulty}`;

      await db.put('songs', song);
      for (const c of charts) await db.put('charts', c);
      imported++;
      onImported?.(song);
    } catch (err) {
      console.warn(`Bundled song import failed for ${path}:`, err);
    }
  }
  return imported;
}

/** Re-run the auto-charter for an already-imported bundled song (generator
 *  upgrade). Keeps the stored BPM/offset so existing scores and any manual
 *  edits stay meaningful, and never overwrites a chart saved from the editor. */
async function regenerateCharts(db: DB, audio: AudioEngine, song: SongData): Promise<void> {
  const res = await fetch(song.audioUrl!);
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const buf = await audio.ctx.decodeAudioData(await res.arrayBuffer());
  const analysis = await analyzeSong(buf);
  const charts = generateSampleCharts(song, analysis);
  for (const c of charts) {
    c.id = `${song.id}-${c.mode}-${c.difficulty}`;
    const old = await db.get<ChartData>('charts', c.id);
    if (old?.updatedIso) continue; // hand-edited in the chart editor — keep it
    await db.put('charts', c);
  }
  song.chartGen = BUNDLED_CHART_GEN;
  await db.put('songs', song);
}
