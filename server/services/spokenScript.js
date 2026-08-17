/**
 * Short opening line for TTS: project title, then the story body.
 * Skips a redundant prefix if the body already opens with the same title.
 *
 * @param {string | null | undefined} title
 * @param {string | null | undefined} storyText
 * @returns {string}
 */
export function combineTitleBeforeStory(title, storyText) {
  const t = String(title ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const s = String(storyText ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return t || '.';
  if (!t) return s;
  const tl = t.toLowerCase();
  const sl = s.toLowerCase();
  if (sl === tl) return s;
  if (sl.startsWith(`${tl} `) || sl.startsWith(`${tl}.`) || sl.startsWith(`${tl},`)) return s;
  return `${t}. ${s}`;
}
