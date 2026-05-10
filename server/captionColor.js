/**
 * ASS / VSFilter colours are &HAABBGGRR (alpha + BGR).
 * @param {string} hex6 — RRGGBB without '#'
 * @returns {string}
 */
export function hexToAssBgr(hex6) {
  const hNorm = typeof hex6 === 'string' ? normalizeCaptionHex(hex6, 'ffffff') : '';
  const h = hNorm;
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return '&H00FFFFFF';
  const b = h.slice(4, 6);
  const g = h.slice(2, 4);
  const r = h.slice(0, 2);
  return `&H00${b}${g}${r}`;
}

/**
 * Sanitize stored caption colour to 6 hex chars (no '#'), lowercase.
 * @param {unknown} raw
 * @param {string} fallbackHex6
 * @returns {string}
 */
export function normalizeCaptionHex(raw, fallbackHex6) {
  if (typeof raw !== 'string') return fallbackHex6;
  let s = raw.trim().replace(/^#/, '');
  if (s.length === 3) {
    s = s
      .split('')
      .map((c) => c + c)
      .join('');
  }
  /** #RRGGBBAA from some clients — ASS/libass use opaque RGB */
  if (s.length === 8 && /^[0-9a-fA-F]{8}$/.test(s)) {
    s = s.slice(0, 6);
  }
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return fallbackHex6;
  return s.toLowerCase();
}
