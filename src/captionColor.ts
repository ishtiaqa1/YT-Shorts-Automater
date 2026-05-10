/** Mirror server/captionColor.js for preview styling. */

export function normalizeCaptionHex(raw: unknown, fallbackHex6: string): string {
  if (typeof raw !== 'string') return fallbackHex6;
  let s = raw.trim().replace(/^#/, '');
  if (s.length === 3) {
    s = s
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (s.length === 8 && /^[0-9a-fA-F]{8}$/.test(s)) {
    s = s.slice(0, 6);
  }
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return fallbackHex6;
  return s.toLowerCase();
}

/** `#rrggbb` for CSS / `<input type="color">` */
export function cssHex(hex6: string): string {
  const h = normalizeCaptionHex(hex6, 'ffffff');
  return `#${h}`;
}
