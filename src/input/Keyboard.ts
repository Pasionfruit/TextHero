/**
 * Routes raw keyboard events to (player, lane) pairs. Uses KeyboardEvent.code for
 * five-key bindings (physical, layout-independent) and e.key for full-keyboard
 * charts (the chart names characters). NKRO is inherited from the browser/OS:
 * every independent keydown/keyup the hardware reports is delivered here, and
 * chords arrive as separate events with their own timestamps.
 */
export interface RouteTarget {
  player: number;
  lane: number;
}

export type InputHandler = (player: number, lane: number, down: boolean, timeStamp: number) => void;

export class InputRouter {
  private codeMap = new Map<string, RouteTarget>();
  private keyMap = new Map<string, RouteTarget>();
  private handler: InputHandler | null = null;
  private downKeys = new Set<string>();
  private onKeyDown = (e: KeyboardEvent) => this.route(e, true);
  private onKeyUp = (e: KeyboardEvent) => this.route(e, false);

  bindFive(player: number, codes: string[]): void {
    codes.forEach((code, lane) => this.codeMap.set(code, { player, lane }));
  }

  bindKeys(player: number, chars: string[]): void {
    chars.forEach((ch, lane) => this.keyMap.set(ch.toUpperCase(), { player, lane }));
  }

  clear(): void {
    this.codeMap.clear();
    this.keyMap.clear();
  }

  attach(handler: InputHandler): void {
    this.handler = handler;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
  }

  detach(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.handler = null;
    this.downKeys.clear();
  }

  private route(e: KeyboardEvent, down: boolean): void {
    if (!this.handler) return;
    if (down && e.repeat) return;
    const target = this.codeMap.get(e.code) ?? this.keyMap.get(e.key.toUpperCase());
    if (!target) return;
    const id = this.codeMap.has(e.code) ? `c:${e.code}` : `k:${e.key.toUpperCase()}`;
    if (down) {
      if (this.downKeys.has(id)) return;
      this.downKeys.add(id);
    } else {
      this.downKeys.delete(id);
    }
    e.preventDefault();
    this.handler(target.player, target.lane, down, e.timeStamp);
  }
}
