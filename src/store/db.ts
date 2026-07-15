import type { ChartData, ReplayData, ScoreRecord, SongData } from '../types';

const DB_NAME = 'texthero';
const DB_VERSION = 1;

export type StoreName = 'songs' | 'charts' | 'audio' | 'scores' | 'replays';

export class DB {
  private constructor(private idb: IDBDatabase) {}

  static open(): Promise<DB> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('songs')) db.createObjectStore('songs', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('charts')) {
          const s = db.createObjectStore('charts', { keyPath: 'id' });
          s.createIndex('songId', 'songId');
        }
        if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio');
        if (!db.objectStoreNames.contains('scores')) {
          const s = db.createObjectStore('scores', { keyPath: 'id' });
          s.createIndex('chartId', 'chartId');
        }
        if (!db.objectStoreNames.contains('replays')) db.createObjectStore('replays', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(new DB(req.result));
      req.onerror = () => reject(req.error);
    });
  }

  private tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const t = this.idb.transaction(store, mode);
      const req = fn(t.objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  put(store: StoreName, value: any, key?: IDBValidKey): Promise<IDBValidKey> {
    return this.tx(store, 'readwrite', (s) => (key !== undefined ? s.put(value, key) : s.put(value)));
  }

  get<T = any>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
    return this.tx(store, 'readonly', (s) => s.get(key)) as Promise<T | undefined>;
  }

  del(store: StoreName, key: IDBValidKey): Promise<undefined> {
    return this.tx(store, 'readwrite', (s) => s.delete(key));
  }

  all<T = any>(store: StoreName): Promise<T[]> {
    return this.tx(store, 'readonly', (s) => s.getAll()) as Promise<T[]>;
  }

  allBy<T = any>(store: StoreName, index: string, key: IDBValidKey): Promise<T[]> {
    return new Promise((resolve, reject) => {
      const t = this.idb.transaction(store, 'readonly');
      const req = t.objectStore(store).index(index).getAll(key);
      req.onsuccess = () => resolve(req.result as T[]);
      req.onerror = () => reject(req.error);
    });
  }

  // Typed helpers
  songs(): Promise<SongData[]> {
    return this.all<SongData>('songs');
  }
  chartsForSong(songId: string): Promise<ChartData[]> {
    return this.allBy<ChartData>('charts', 'songId', songId);
  }
  scoresForChart(chartId: string): Promise<ScoreRecord[]> {
    return this.allBy<ScoreRecord>('scores', 'chartId', chartId);
  }
  replay(id: string): Promise<ReplayData | undefined> {
    return this.get<ReplayData>('replays', id);
  }

  async deleteSong(songId: string): Promise<void> {
    const song = await this.get<SongData>('songs', songId);
    const charts = await this.chartsForSong(songId);
    for (const c of charts) {
      const scores = await this.scoresForChart(c.id);
      for (const sc of scores) {
        if (sc.replayId) await this.del('replays', sc.replayId);
        await this.del('scores', sc.id);
      }
      await this.del('charts', c.id);
    }
    if (song?.audioId) await this.del('audio', song.audioId);
    await this.del('songs', songId);
  }

  async wipe(): Promise<void> {
    for (const s of ['songs', 'charts', 'audio', 'scores', 'replays'] as StoreName[]) {
      await new Promise<void>((resolve, reject) => {
        const t = this.idb.transaction(s, 'readwrite');
        const req = t.objectStore(s).clear();
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    }
  }
}
