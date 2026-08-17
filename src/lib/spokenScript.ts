/** Keep behavior aligned with `server/services/spokenScript.js` (render / TTS). */
export function combineTitleBeforeStory(
  title: string | null | undefined,
  storyText: string | null | undefined
): string {
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
