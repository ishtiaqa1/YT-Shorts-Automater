/**
 * Timed captions for Shorts: word-based cues; margin-aware line width via captionLayout.
 * Export as ASS so FFmpeg/libass honors middle-center alignment (SRT + force_style often renders bottom).
 */
import { hexToAssBgr } from '../captionColor.js';
import { normalizeCaptionSettings } from '../captionDefaults.js';
import {
  computeMaxCharsPerLineFromMargins,
  splitTextIntoWordCues,
  wrapCueToLines,
} from '../captionLayout.js';

/**
 * @param {string} script
 * @param {number} durationSec
 * @param {Record<string, unknown> | null | undefined} [captionSettingsRaw]
 * @returns {{ text: string, startMs: number, endMs: number }[]}
 */
export function buildTimedCaptionBlocks(script, durationSec, captionSettingsRaw) {
  const s = normalizeCaptionSettings(captionSettingsRaw);
  const maxCharsHard = computeMaxCharsPerLineFromMargins(s.fontSize, s.marginLR);

  const clean = script.replace(/\s+/g, ' ').trim();
  if (!clean || durationSec <= 0) {
    return [{ text: '.', startMs: 0, endMs: 1000 }];
  }

  const sentences = clean.split(/(?<=[.!?])\s+/).filter(Boolean);
  const chunks = sentences.length > 0 ? sentences : [clean];

  const totalChars = chunks.reduce((n, c) => n + c.length, 0) || 1;
  let msCursor = 0;
  /** @type {{ text: string, startMs: number, endMs: number }[]} */
  const rawBlocks = [];

  chunks.forEach((sentence, i) => {
    const share = sentence.length / totalChars;
    let chunkMs = Math.round(durationSec * 1000 * share);
    if (i === chunks.length - 1) {
      chunkMs = Math.max(0, Math.round(durationSec * 1000) - msCursor);
    }
    const segStart = msCursor;
    const segEnd = Math.min(msCursor + chunkMs, Math.round(durationSec * 1000));
    msCursor = segEnd;

    const cueTexts = splitTextIntoWordCues(sentence, s.maxWordsPerCue);
    const span = Math.max(1, segEnd - segStart);
    const n = cueTexts.length;

    cueTexts.forEach((cuePlain, j) => {
      const text = wrapCueToLines(cuePlain, s.maxWordsPerLine, maxCharsHard);
      const startMs = Math.round(segStart + (span * j) / n);
      const endMs = Math.round(segStart + (span * (j + 1)) / n);
      rawBlocks.push({ text, startMs, endMs: Math.max(startMs + 1, endMs) });
    });
  });

  return rawBlocks;
}

/**
 * @param {string} script
 * @param {number} durationSec
 * @param {Record<string, unknown> | null | undefined} [captionSettingsRaw]
 */
export function buildSrtFromScript(script, durationSec, captionSettingsRaw) {
  const rawBlocks = buildTimedCaptionBlocks(script, durationSec, captionSettingsRaw);
  return rawBlocks
    .map((b, idx) => {
      const a = formatSrtTs(b.startMs);
      const z = formatSrtTs(Math.max(b.startMs + 1, b.endMs));
      return `${idx + 1}\n${a} --> ${z}\n${b.text}\n`;
    })
    .join('\n');
}

/**
 * ASS subtitles with Style Alignment=5 (middle center). Required for centered burn-in; SRT often stays bottom.
 * @param {string} script
 * @param {number} durationSec
 * @param {Record<string, unknown> | null | undefined} [captionSettingsRaw]
 */
export function buildAssFromScript(script, durationSec, captionSettingsRaw) {
  const s = normalizeCaptionSettings(captionSettingsRaw);
  const blocks = buildTimedCaptionBlocks(script, durationSec, captionSettingsRaw);

  /** ASS colours: &HAABBGGRR */
  const primary = hexToAssBgr(s.primaryColor);
  const outlineC = hexToAssBgr(s.outlineColor);
  /** Unused for BorderStyle=1 outline, but required in Style row */
  const back = '&H00000000';

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'PlayResX: 1080',
    'PlayResY: 1920',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,Arial Black,${s.fontSize},${primary},&H000000FF,${outlineC},${back},-1,0,0,0,100,100,0,0,1,${s.outline},${s.shadow},5,${s.marginLR},${s.marginLR},${s.marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n');

  const lines = blocks.map((b) => {
    const start = formatAssTs(b.startMs);
    const end = formatAssTs(Math.max(b.startMs + 50, b.endMs));
    /** {\an5} = middle-center; belts-and-suspenders with Style Alignment=5 for libass/ffmpeg. */
    const body = `{\\an5}${escapeAssText(b.text)}`;
    return `Dialogue: 0,${start},${end},Default,,0,0,0,,${body}`;
  });

  return `${header}\n${lines.join('\n')}\n`;
}

/**
 * ASS time: H:MM:SS.cc (centiseconds)
 * @param {number} ms
 */
function formatAssTs(ms) {
  const t = Math.max(0, ms) / 1000;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const intS = Math.floor(s);
  const cs = Math.min(99, Math.round((s - intS) * 100));
  return `${h}:${String(m).padStart(2, '0')}:${String(intS).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function formatSrtTs(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const msr = ms % 1000;
  return `${pad(h)}:${pad(m)}:${pad(s)},${String(msr).padStart(3, '0')}`;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/**
 * Escape user text for ASS Dialogue; newlines -> \\N
 * @param {string} text
 */
function escapeAssText(text) {
  return text
    .replace(/\r/g, '')
    .replace(/\n/g, '\\N')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}');
}
