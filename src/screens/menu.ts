import type { AppCtx, Screen } from '../app';
import { applyTheme } from '../store/settings';
import { icon } from '../ui/icons';
import { el } from '../util';

export function menuScreen(root: HTMLElement, ctx: AppCtx, _params: any): Screen {
  root.innerHTML = '';
  const item = (label: string, go: () => void) =>
    el('button', { class: 'menu-item', onclick: go }, label);

  const s = ctx.settings;
  const themeBtn = el('button', {
    class: 'btn sm theme-toggle',
    title: 'Toggle dark / light mode',
    onclick: () => {
      s.theme = s.theme === 'light' ? 'dark' : 'light';
      applyTheme(s);
      ctx.saveSettings();
      setThemeBtn();
    },
  });
  const setThemeBtn = () =>
    themeBtn.replaceChildren(icon(s.theme === 'light' ? 'moon' : 'sun'), s.theme === 'light' ? 'Dark' : 'Light');
  setThemeBtn();

  const page = el('div', { class: 'menu-page' },
    themeBtn,
    el('div', { class: 'logo' }, el('span', { class: 'logo-text' }, 'Type-to-'), el('span', { class: 'logo-hero' }, 'Beat')),
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
