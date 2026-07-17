import type { AppCtx, Screen } from '../app';
import { HOVER_SFX, PLAY_SFX } from '../audio/uiSounds';
import { el, isMobile } from '../util';

export function menuScreen(root: HTMLElement, ctx: AppCtx, _params: any): Screen {
  root.innerHTML = '';
  const s = ctx.settings;
  const item = (label: string, go: () => void, clickSfx?: string) =>
    el('button', {
      class: 'menu-item',
      onmouseenter: () => {
        if (s.uiSounds) void ctx.audio.playUiSound(HOVER_SFX, 0.5);
      },
      onclick: () => {
        if (clickSfx && s.uiSounds) void ctx.audio.playUiSound(clickSfx);
        go();
      },
    }, label);

  const page = el('div', { class: 'menu-page' },
    el('div', { class: 'logo' }, el('span', { class: 'logo-text' }, 'Type-to-'), el('span', { class: 'logo-hero' }, 'Beat')),
    el('div', { class: 'muted tagline' }, 'A keyboard rhythm game'),
    el('div', { class: 'menu-list' },
      item('Play', () => ctx.nav('songselect'), PLAY_SFX),
      item('Multiplayer', () => ctx.nav('lobby')),
      !isMobile() && item('Chart Editor', () => ctx.nav('editor')),
      item('Settings', () => ctx.nav('settings')),
    ),
    el('div', { class: 'muted sm menu-foot' },
      'Five-Key: hit D · F · SPACE · J · K as the gems reach the line.  ',
      'Letters: any letter can fall — press that letter on the beat.  Esc pauses.'),
  );
  root.append(page);
  return { destroy() {} };
}
