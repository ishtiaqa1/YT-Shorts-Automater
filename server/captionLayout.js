/**
 * Word-based caption layout shared by SRT burn-in. Side margins narrow the usable
 * width so text wraps before hitting edges (libass MarginL/R alone is unreliable for centered ASS).
 */

import { clamp } from './captionDefaults.js';

/** PlayResX for Shorts frame */
const FRAME_W = 1080;

/**
 * Max characters that fit on one line given font size and horizontal inset (same math as preview).
 * @param {number} fontSize
 * @param {number} marginLR
 */
export function computeMaxCharsPerLineFromMargins(fontSize, marginLR) {
  const m = clamp(marginLR, 0, 220);
  const usable = Math.max(120, FRAME_W - 2 * m);
  const denom = Math.max(fontSize, 10) * 0.56;
  const est = Math.floor(usable / denom);
  return clamp(est, 8, 80);
}

/**
 * Wrap a single cue into lines: at most `maxWordsPerLine` words per line, and at most
 * `maxCharsHard` characters per line (from margins + font).
 * @param {string} cueText
 * @param {number} maxWordsPerLine
 * @param {number} maxCharsHard
 */
export function wrapCueToLines(cueText, maxWordsPerLine, maxCharsHard) {
  const words = cueText
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return '';

  const lines = [];
  let cur = [];
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

/**
 * Split full text into timed cue strings of at most `maxWordsPerCue` words each.
 * @param {string} text
 * @param {number} maxWordsPerCue
 * @returns {string[]}
 */
export function splitTextIntoWordCues(text, maxWordsPerCue) {
  const words = text.replace(/\s+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const cues = [];
  const step = Math.max(1, maxWordsPerCue);
  for (let i = 0; i < words.length; i += step) {
    cues.push(words.slice(i, i + step).join(' '));
  }
  return cues;
}
