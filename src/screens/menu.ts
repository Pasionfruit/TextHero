import type { AppCtx, Screen } from '../app';
import { el } from '../util';

export function menuScreen(root: HTMLElement, ctx: AppCtx, _params: any): Screen {
  root.innerHTML = '';
  const item = (label: string, go: () => void) =>
    el('button', { class: 'menu-item', onclick: go }, label);

  const page = el('div', { class: 'menu-page' },
    el('div', { class: 'logo' }, el('span', { class: 'logo-text' }, 'TEXT'), el('span', { class: 'logo-hero' }, 'HERO')),
    el('div', { class: 'muted tagline' }, 'A keyboard rhythm game'),
    el('div', { class: 'menu-list' },
      item('Play', () => ctx.nav('songselect')),
      item('Multiplayer', () => ctx.nav('lobby')),
      item('Chart Editor', () => ctx.nav('editor')),
      item('Settings', () => ctx.nav('settings')),
    ),
    el('div', { class: 'muted sm menu-foot' },
      'Five-Key: hit D · F · SPACE · J · K as the gems reach the line.  ',
      'Letters: any letter can fall — press that letter on the beat.  Esc pauses.'),
  );
  root.append(page);
  return { destroy() {} };
}
