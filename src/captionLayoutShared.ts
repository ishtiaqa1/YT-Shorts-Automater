/** Mirrors server/captionLayout.js so live preview matches burn-in wrapping. */

const FRAME_W = 1080;

function clamp(n: number, lo: number, hi: number) {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

export function computeMaxCharsPerLineFromMargins(fontSize: number, marginLR: number) {
  const m = clamp(marginLR, 0, 220);
  const usable = Math.max(120, FRAME_W - 2 * m);
  const denom = Math.max(fontSize, 10) * 0.56;
  const est = Math.floor(usable / denom);
  return clamp(est, 8, 80);
}

export function wrapCueToLines(cueText: string, maxWordsPerLine: number, maxCharsHard: number) {
  const words = cueText
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return '';

  const lines: string[] = [];
  let cur: string[] = [];
  let len = 0;

  for (const w of words) {
    const addLen = cur.length ? 1 + w.length : w.length;

    if (w.length > maxCharsHard) {
      if (cur.length) {
        lines.push(cur.join(' '));
        cur = [];
        len = 0;
      }
      lines.push(`${w.slice(0, Math.max(1, maxCharsHard - 1))}…`);
      continue;
    }

    const hitWordCap = cur.length >= maxWordsPerLine;
    const hitCharCap = cur.length > 0 && len + addLen > maxCharsHard;

    if (hitWordCap || hitCharCap) {
      lines.push(cur.join(' '));
      cur = [w];
      len = w.length;
    } else {
      cur.push(w);
      len += addLen;
    }
  }
  if (cur.length) lines.push(cur.join(' '));
  return lines.join('\n');
}

export function splitTextIntoWordCues(text: string, maxWordsPerCue: number) {
  const words = text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return [];
  const cues: string[] = [];
  const step = Math.max(1, maxWordsPerCue);
  for (let i = 0; i < words.length; i += step) {
    cues.push(words.slice(i, i + step).join(' '));
  }
  return cues;
}

export type PreviewCaptionMode = 'singleBeat' | 'fullScript';

/**
 * singleBeat — one timed chunk only (matches what you see at a single moment in the MP4).
 * fullScript — all chunks stacked (misleading vs export; optional for checking wrap).
 */
export function formatPreviewSubtitleText(
  text: string,
  s: { maxWordsPerLine: number; maxWordsPerCue: number; fontSize: number; marginLR: number },
  mode: PreviewCaptionMode = 'singleBeat',
  maxLen = 2000
) {
  const maxChars = computeMaxCharsPerLineFromMargins(s.fontSize, s.marginLR);
  const words = text.replace(/\s+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 'Caption preview';

  if (mode === 'singleBeat') {
    const chunk = words.slice(0, Math.max(1, s.maxWordsPerCue)).join(' ');
    const body = wrapCueToLines(chunk, s.maxWordsPerLine, maxChars);
    return body.length > maxLen ? `${body.slice(0, maxLen)}…` : body;
  }

  const cues = splitTextIntoWordCues(text, s.maxWordsPerCue);
  const body = cues.map((c) => wrapCueToLines(c, s.maxWordsPerLine, maxChars)).join('\n\n');
  return body.length > maxLen ? `${body.slice(0, maxLen)}…` : body;
}
