import type { ChartData, SongData } from '../types';
import type { Settings } from './settings';
import type { DB } from './db';
import { fetchPublishedCharts } from '../net/api';

/**
 * Pull the admin-published (canonical) charts for a song from the server and
 * adopt them into the local library, so every player plays — and is ranked on —
 * exactly the same version.
 *
 * Published charts win over local ones: the matching local chart (by id, or by
 * same mode+difficulty) is replaced, and the song's BPM/offset are set to the
 * published values so the notes compile to identical times on every machine
 * (bundled songs auto-detect BPM per client, which would otherwise drift).
 *
 * Best-effort and offline-safe: any network/DB error just leaves local charts
 * in place and resolves false.
 */
export async function syncPublishedCharts(db: DB, settings: Settings, songId: string): Promise<boolean> {
  let published;
  try {
    published = await fetchPublishedCharts(settings, songId);
  } catch {
    return false; // server unreachable / offline — keep local charts
  }
  if (!published.length) return false;

  try {
    const song = await db.get<SongData>('songs', songId);
    const localCharts = await db.chartsForSong(songId);
    let changed = false;

    // adopt the published song timing (identical note times across clients)
    if (song) {
      const p0 = published[0];
      if (song.bpm !== p0.bpm || song.offsetMs !== p0.offsetMs) {
        song.bpm = p0.bpm;
        song.offsetMs = p0.offsetMs;
        await db.put('songs', song);
        changed = true;
      }
    }

    for (const pc of published) {
      const incoming: ChartData = {
        id: pc.chartId,
        songId: pc.songId,
        mode: pc.mode,
        difficulty: pc.difficulty,
        keys: pc.keys ?? [],
        notes: pc.notes ?? [],
        updatedIso: pc.updatedIso,
        published: true,
        publishedIso: pc.updatedIso,
      };

      const existing = localCharts.find((c) => c.id === pc.chartId);
      // only rewrite when the published version actually differs, to avoid churn
      if (!existing || existing.publishedIso !== pc.updatedIso || !existing.published) {
        await db.put('charts', incoming);
        changed = true;
      }

      // drop a stale duplicate of the same slot that has a different id, so the
      // published chart is the single version shown for this mode+difficulty
      for (const c of localCharts) {
        if (c.id !== pc.chartId && c.mode === pc.mode && c.difficulty === pc.difficulty) {
          await db.del('charts', c.id);
          changed = true;
        }
      }
    }
    return changed;
  } catch {
    return false;
  }
}
