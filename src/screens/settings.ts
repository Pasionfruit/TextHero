import type { AppCtx, Screen } from '../app';
import { adminLogin, adminToken, clearAdminToken } from '../net/api';
import { applyTheme, DEFAULT_SETTINGS } from '../store/settings';
import { codeLabel, el, toast } from '../util';
import { checkbox, numInput, row, selectInput } from './songselect';

export function settingsScreen(root: HTMLElement, ctx: AppCtx, _params: any): Screen {
  root.innerHTML = '';
  const s = ctx.settings;
  const page = el('div', { class: 'page' });
  root.append(page);

  let capturing: { el: HTMLButtonElement; set: (code: string) => void } | null = null;
  const onCapture = (e: KeyboardEvent) => {
    if (!capturing) return;
    e.preventDefault();
    if (e.code !== 'Escape') capturing.set(e.code);
    capturing.el.classList.remove('capturing');
    render();
    capturing = null;
  };
  window.addEventListener('keydown', onCapture, true);

  function bindBtn(codes: string[], i: number): HTMLElement {
    const btn = el('button', { class: 'btn sm key-btn' }, codeLabel(codes[i] ?? '')) as HTMLButtonElement;
    btn.onclick = () => {
      capturing = { el: btn, set: (code) => (codes[i] = code) };
      btn.textContent = '…';
      btn.classList.add('capturing');
    };
    return btn;
  }

  function render(): void {
    page.innerHTML = '';
    page.append(
      el('div', { class: 'row spread' },
        el('h1', { class: 'page-title' }, 'Settings'),
        el('button', { class: 'btn', onclick: () => ctx.nav('menu') }, 'Back'),
      ),
    );

    page.append(el('div', { class: 'panel' },
      el('h3', null, 'Player'),
      row('Name', el('input', { type: 'text', value: s.playerName, onchange: (e: Event) => (s.playerName = (e.target as HTMLInputElement).value || 'Player') })),
    ));

    const keys = el('div', { class: 'panel' }, el('h3', null, 'Five-key bindings'), el('div', { class: 'muted sm' }, 'Click a key to rebind (Esc cancels). P2–P4 are used in local multiplayer.'));
    s.bindings.forEach((codes, p) => {
      const r = el('div', { class: 'form-row' }, el('label', null, `Player ${p + 1}`));
      for (let i = 0; i < 5; i++) r.append(bindBtn(codes, i));
      keys.append(r);
    });
    page.append(keys);

    page.append(el('div', { class: 'panel' },
      el('h3', null, 'Timing'),
      row('Audio offset (ms)', numInput(s.audioOffsetMs, -300, 300, 1, (v) => (s.audioOffsetMs = v))),
      row('Visual offset (ms)', numInput(s.visualOffsetMs, -300, 300, 1, (v) => (s.visualOffsetMs = v))),
      el('div', { class: 'muted sm' }, 'Positive audio offset = you hear late (hits register early). Adjust until PERFECTs feel centered.'),
      el('h3', null, 'Judgment windows (± ms)'),
      row('Perfect', numInput(s.windows.perfect, 5, 100, 1, (v) => (s.windows.perfect = v))),
      row('Great', numInput(s.windows.great, 10, 160, 1, (v) => (s.windows.great = v))),
      row('Good', numInput(s.windows.good, 20, 220, 1, (v) => (s.windows.good = v))),
      row('Bad', numInput(s.windows.bad, 30, 300, 1, (v) => (s.windows.bad = v))),
    ));

    const colors = el('div', { class: 'form-row' }, el('label', null, 'Lane colors'));
    s.laneColors.forEach((c, i) => {
      colors.append(el('input', { type: 'color', value: c, onchange: (e: Event) => (s.laneColors[i] = (e.target as HTMLInputElement).value) }));
    });

    page.append(el('div', { class: 'panel' },
      el('h3', null, 'Visuals'),
      row('Theme', selectInput(['dark', 'light'], s.theme, (v) => {
        s.theme = v as 'dark' | 'light';
        applyTheme(s);
      })),
      row('Note skin', selectInput(['gems', 'bars', 'circles', 'arrows'], s.noteSkin, (v) => (s.noteSkin = v as any))),
      colors,
      row('Scroll speed', numInput(s.scrollSpeed, 0.25, 4, 0.25, (v) => (s.scrollSpeed = v))),
      row('Scroll direction', selectInput(['down', 'up'], s.scrollDirection, (v) => (s.scrollDirection = v as any))),
      row('Judgment line position', numInput(s.judgmentLinePos, 0.05, 0.4, 0.01, (v) => (s.judgmentLinePos = v))),
      row('Note size', numInput(s.noteScale, 0.5, 2, 0.1, (v) => (s.noteScale = v))),
      row('Lane spacing (px)', numInput(s.laneSpacingPx, 0, 20, 1, (v) => (s.laneSpacingPx = v))),
      row('Background dim', numInput(s.bgDim, 0, 1, 0.05, (v) => (s.bgDim = v))),
      row('Font', selectInput(['system-ui', 'monospace', 'serif', 'Segoe UI', 'Comic Sans MS'], s.fontFamily, (v) => (s.fontFamily = v))),
      row('FPS limit (0 = off)', selectInput(['0', '30', '60', '120', '144', '240'], String(s.fpsCap), (v) => (s.fpsCap = Number(v)))),
      row('Fullscreen', el('button', {
        class: 'btn sm',
        onclick: () => {
          if (document.fullscreenElement) void document.exitFullscreen();
          else void document.documentElement.requestFullscreen();
        },
      }, 'Toggle')),
    ));

    page.append(el('div', { class: 'panel' },
      el('h3', null, 'Accessibility'),
      row('Colorblind-friendly colors', checkbox(s.colorblind, (v) => (s.colorblind = v))),
      row('High contrast mode', checkbox(s.highContrast, (v) => (s.highContrast = v))),
      row('Particles', checkbox(s.particles, (v) => (s.particles = v))),
      row('Reduced visual effects', checkbox(s.reducedEffects, (v) => (s.reducedEffects = v))),
      el('div', { class: 'muted sm' }, 'One-handed play: rebind all five keys to one side of the keyboard above.'),
    ));

    page.append(el('div', { class: 'panel' },
      el('h3', null, 'Audio & Online'),
      row('Hit sounds', checkbox(s.hitSounds, (v) => (s.hitSounds = v))),
      row('Multiplayer server', el('input', { type: 'text', value: s.serverUrl, style: { width: '240px' }, onchange: (e: Event) => (s.serverUrl = (e.target as HTMLInputElement).value) })),
    ));

    // admin: manage the global leaderboard (credentials are verified server-side)
    const adminPanel = el('div', { class: 'panel' }, el('h3', null, 'Admin'));
    if (adminToken()) {
      adminPanel.append(
        el('div', { class: 'muted sm' }, 'Logged in as admin — edit/delete buttons appear on global leaderboards in Song Select.'),
        el('div', { class: 'btn-row' },
          el('button', {
            class: 'btn',
            onclick: () => {
              clearAdminToken();
              toast('Logged out');
              render();
            },
          }, 'Log out'),
        ),
      );
    } else {
      const userIn = el('input', { type: 'text', placeholder: 'Username', autocomplete: 'username' });
      const passIn = el('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password' });
      const loginBtn = el('button', { class: 'btn primary' }, 'Log in') as HTMLButtonElement;
      loginBtn.onclick = async () => {
        loginBtn.disabled = true;
        loginBtn.textContent = 'Logging in…';
        try {
          await adminLogin(s, userIn.value.trim(), passIn.value);
          toast('Admin login successful');
          render();
        } catch (err) {
          toast(`Login failed: ${(err as Error).message}`);
          loginBtn.disabled = false;
          loginBtn.textContent = 'Log in';
        }
      };
      passIn.onkeydown = (e: KeyboardEvent) => {
        if (e.key === 'Enter') loginBtn.click();
      };
      adminPanel.append(
        row('Username', userIn),
        row('Password', passIn),
        el('div', { class: 'btn-row' }, loginBtn),
        el('div', { class: 'muted sm' }, 'Admins can edit or remove entries on the global leaderboard.'),
      );
    }
    page.append(adminPanel);

    page.append(el('div', { class: 'panel' },
      el('h3', null, 'Data'),
      el('div', { class: 'btn-row' },
        el('button', {
          class: 'btn',
          onclick: () => {
            Object.assign(s, structuredClone(DEFAULT_SETTINGS));
            ctx.saveSettings();
            applyTheme(s);
            render();
            toast('Settings reset');
          },
        }, 'Reset settings'),
        el('button', {
          class: 'btn danger',
          onclick: async () => {
            if (!confirm('Delete ALL songs, charts, scores and replays?')) return;
            await ctx.db.wipe();
            toast('Library wiped — demo song will be restored on reload');
            location.reload();
          },
        }, 'Wipe library'),
      ),
    ));
  }

  render();

  return {
    destroy() {
      window.removeEventListener('keydown', onCapture, true);
      ctx.saveSettings();
    },
  };
}
