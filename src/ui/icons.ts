/** Minimal solid SVG icons (drawn in currentColor) used instead of emoji. */

const ICONS = {
  play: '<path d="M8 5v14l11-7z"/>',
  pause: '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>',
  stop: '<path d="M6 6h12v12H6z"/>',
  record: '<circle cx="12" cy="12" r="7"/>',
  rewind: '<path d="M6 5h2v14H6zM20 5v14l-10-7z"/>',
  save: '<path d="M17 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7zM12 19a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm3-10H6V5h9z"/>',
  upload: '<path d="M12 3l5 5h-3v6h-4V8H7zM5 18h14v2H5z"/>',
  gear: '<path d="M19.14 12.94a7.07 7.07 0 0 0 .05-.94 7.07 7.07 0 0 0-.05-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7.3 7.3 0 0 0-1.62-.94l-.36-2.54A.5.5 0 0 0 13.9 2h-3.8a.5.5 0 0 0-.5.42l-.36 2.54c-.58.24-1.13.55-1.62.94l-2.39-.96a.5.5 0 0 0-.61.22L2.7 8.48a.5.5 0 0 0 .12.64l2.03 1.58a7.07 7.07 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.23.4.32.61.22l2.39-.96c.49.39 1.04.7 1.62.94l.36 2.54c.04.24.25.42.5.42h3.8c.25 0 .46-.18.5-.42l.36-2.54a7.3 7.3 0 0 0 1.62-.94l2.39.96c.21.1.48.01.61-.22l1.92-3.32a.5.5 0 0 0-.12-.64zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3M4.6 4.6l2.1 2.1M17.3 17.3l2.1 2.1M19.4 4.6l-2.1 2.1M6.7 17.3l-2.1 2.1" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>',
  moon: '<path d="M20.4 14.5a8.5 8.5 0 0 1-10.9-10.9A8.5 8.5 0 1 0 20.4 14.5z"/>',
  note: '<path d="M9 3v10.55A4 4 0 1 0 11 17V7h6V3z"/>',
  sparkle: '<path d="M11 2l1.7 5.3L18 9l-5.3 1.7L11 16l-1.7-5.3L4 9l5.3-1.7zM19 14l.9 2.6 2.6.9-2.6.9L19 21l-.9-2.6-2.6-.9 2.6-.9z"/>',
  zoomin: '<path d="M10 2a8 8 0 1 0 4.9 14.3l5.4 5.4 1.4-1.4-5.4-5.4A8 8 0 0 0 10 2zm0 2a6 6 0 1 1 0 12 6 6 0 0 1 0-12zM9 7h2v2h2v2h-2v2H9v-2H7V9h2z"/>',
  zoomout: '<path d="M10 2a8 8 0 1 0 4.9 14.3l5.4 5.4 1.4-1.4-5.4-5.4A8 8 0 0 0 10 2zm0 2a6 6 0 1 1 0 12 6 6 0 0 1 0-12zM7 9h6v2H7z"/>',
  pencil: '<path d="M3 17.25V21h3.75L17.8 9.94l-3.75-3.75zM20.7 7a1 1 0 0 0 0-1.4L18.4 3.3a1 1 0 0 0-1.4 0l-1.8 1.8 3.75 3.75z"/>',
  x: '<path d="M19 6.4L17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/>',
  crown: '<path d="M3 7l4.5 4L12 4l4.5 7L21 7l-1.5 11h-15zM4.5 20h15v1.5h-15z"/>',
  chevronleft: '<path d="M15.4 5.4L14 4l-8 8 8 8 1.4-1.4L8.8 12z"/>',
  retry: '<path d="M12 5V1L6.5 6.5 12 12V8a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z"/>',
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, size = 14): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = 'icon';
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor">${ICONS[name]}</svg>`;
  return s;
}
