export const uid = (): string =>
  (crypto as any).randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36);

export const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function fmtTime(ms: number): string {
  const neg = ms < 0 ? '-' : '';
  ms = Math.abs(ms);
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${neg}${m}:${String(s).padStart(2, '0')}.${String(Math.floor(ms % 1000)).padStart(3, '0')}`;
}

export function fmtPct(v: number): string {
  return (v * 100).toFixed(2) + '%';
}

/** Compact duration, e.g. 3:07. */
export function fmtDur(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

type Attrs = Record<string, any> | null;
type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') {
        (node as any)[k.toLowerCase()] = v;
      } else if (k === 'class') {
        node.className = String(v);
      } else if (k === 'style' && typeof v === 'object') {
        Object.assign(node.style, v);
      } else if (k === 'value') {
        (node as any).value = v;
      } else if (k === 'checked' || k === 'disabled' || k === 'selected') {
        (node as any)[k] = !!v;
      } else {
        node.setAttribute(k, String(v));
      }
    }
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function toast(msg: string, ms = 2600): void {
  const host = document.getElementById('toasts');
  if (!host) return;
  const t = el('div', { class: 'toast' }, msg);
  host.append(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 400);
  }, ms);
}

const CODE_LABELS: Record<string, string> = {
  Space: 'SPACE',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ShiftLeft: 'LSHIFT',
  ShiftRight: 'RSHIFT',
  ControlLeft: 'LCTRL',
  ControlRight: 'RCTRL',
  Semicolon: ';',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Enter: '⏎',
};

export function codeLabel(code: string): string {
  if (CODE_LABELS[code]) return CODE_LABELS[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'N' + code.slice(6);
  return code;
}

export function gradeFor(acc: number, failed: boolean, misses: number): string {
  if (failed) return 'F';
  if (acc >= 0.999 && misses === 0) return 'SS';
  if (acc >= 0.95) return 'S';
  if (acc >= 0.9) return 'A';
  if (acc >= 0.8) return 'B';
  if (acc >= 0.7) return 'C';
  if (acc >= 0.6) return 'D';
  return 'F';
}

export function fitCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

export function download(name: string, text: string): void {
  const a = el('a', {
    href: URL.createObjectURL(new Blob([text], { type: 'application/json' })),
    download: name,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
