import type { ChartData, SongData } from '../types';

export interface NetLobbyPlayer {
  id: string;
  name: string;
  ready: boolean;
}

export interface NetLobbyState {
  code: string;
  hostId: string;
  youId: string;
  players: NetLobbyPlayer[];
  config: any;
  isPublic: boolean;
  maxPlayers: number;
  songInfo: { title: string; artist: string; mode: string; difficulty: string } | null;
}

export interface NetSongPayload {
  song: SongData;
  chart: ChartData;
  audioB64: string | null;
}

type Handler = (msg: any) => void;

/**
 * Thin WebSocket client for the lobby server. Gameplay itself stays fully
 * client-side and deterministic; the server only synchronizes lobby state,
 * the start signal, and live progress/results.
 */
export class NetClient {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<Handler>>();
  lobby: NetLobbyState | null = null;
  songPayload: NetSongPayload | null = null;
  lastResults: any[] | null = null;

  isConnected(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  connect(url: string): Promise<void> {
    this.disconnect();
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => {
        settled = true;
        resolve();
      };
      ws.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error('Could not connect to server'));
        }
      };
      ws.onclose = () => {
        this.lobby = null;
        this.dispatch({ t: 'closed' });
      };
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(String(e.data));
          if (msg.t === 'lobby') this.lobby = msg.lobby;
          if (msg.t === 'songdata') this.songPayload = msg.payload;
          if (msg.t === 'results') this.lastResults = msg.results;
          if (msg.t === 'start') this.lastResults = null;
          this.dispatch(msg);
        } catch {
          /* ignore malformed frames */
        }
      };
    });
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.lobby = null;
    this.songPayload = null;
  }

  send(t: string, payload: Record<string, any> = {}): void {
    if (this.isConnected()) this.ws!.send(JSON.stringify({ t, ...payload }));
  }

  on(type: string, fn: Handler): () => void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(fn);
    return () => this.handlers.get(type)?.delete(fn);
  }

  private dispatch(msg: any): void {
    this.handlers.get(msg.t)?.forEach((fn) => fn(msg));
    this.handlers.get('*')?.forEach((fn) => fn(msg));
  }

  isHost(): boolean {
    return !!this.lobby && this.lobby.hostId === this.lobby.youId;
  }
}

export async function blobToB64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    s += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

export function b64ToBlob(b64: string): Blob {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Blob([buf]);
}
