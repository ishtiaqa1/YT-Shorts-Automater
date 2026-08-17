/**
 * Timed captions: word-level beats; margin-aware line width; ASS for libass center alignment.
 */
import { hexToAssBgr } from '../captionColor.js';
import { normalizeCaptionSettings } from '../captionDefaults.js';
import { resolveCaptionStylePreset } from '../captionStyles.js';
import {
  computeMaxCharsPerLineFromMargins,
  wrapCueToLines,
} from '../captionLayout.js';

/**
 * Timed caption cues grouped by words-per-cue (not single-word flashes).
 * Allocates timeline proportionally by character mass; each cue gets a readable minimum duration.
 *
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

  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return [{ text: '.', startMs: 0, endMs: 1000 }];
  }

  const maxWordsPerCue = Math.max(1, Math.round(s.maxWordsPerCue || 16));
  /** @type {{ plain: string; mass: number }[]} */
  const cues = [];
  for (let i = 0; i < words.length; i += maxWordsPerCue) {
    const part = words.slice(i, i + maxWordsPerCue);
    const plain = part.join(' ');
    const cueMass = part.reduce((n, w) => n + Math.max(1, w.length), 0);
    cues.push({ plain, mass: cueMass });
  }

  const durMs = Math.round(durationSec * 1000);
  const totalMass = cues.reduce((a, c) => a + c.mass, 0) || 1;
  const minCueMs = 220;

  /** @type {number[]} */
  let shares = cues.map((c) => Math.max(minCueMs, (c.mass / totalMass) * durMs));
  let sumShares = shares.reduce((a, b) => a + b, 0);
  if (sumShares <= 0) sumShares = 1;
  if (Math.abs(sumShares - durMs) > 2) {
    const scale = durMs / sumShares;
    shares = shares.map((x) => Math.max(minCueMs, Math.round(x * scale)));
    sumShares = shares.reduce((a, b) => a + b, 0);
  }
  const drift = durMs - sumShares;
  if (cues.length === 1) {
    shares = [durMs];
  } else if (drift !== 0) {
    shares[cues.length - 1] = Math.max(minCueMs, shares[cues.length - 1] + drift);
  }

  /** @type {{ text: string, startMs: number, endMs: number }[]} */
  const rawBlocks = [];
  let t = 0;
  for (let i = 0; i < cues.length; i++) {
    const startMs = Math.round(t);
    t += shares[i];
    const endMs = i === cues.length - 1 ? durMs : Math.min(durMs, Math.round(t));
    const plain = cues[i].plain;
    const text = wrapCueToLines(plain, s.maxWordsPerLine, maxCharsHard);
    rawBlocks.push({ text, startMs, endMs: Math.max(startMs + 1, endMs) });
  }

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
 * ASS subtitles with Style Alignment=5 (middle center).
 * @param {string} script
 * @param {number} durationSec
 * @param {Record<string, unknown> | null | undefined} [captionSettingsRaw]
 * @param {string | null | undefined} [captionStyleKey] — preset id (bold_pop, …)
 * @param {number} [startOffsetMs] - delay first cue to align with spoken onset
 */
export function buildAssFromScript(script, durationSec, captionSettingsRaw, captionStyleKey, startOffsetMs = 0) {
  const s = normalizeCaptionSettings(captionSettingsRaw);
  const { preset } = resolveCaptionStylePreset(captionStyleKey);
  const blocks = buildTimedCaptionBlocks(script, durationSec, captionSettingsRaw);

  /** User colours + font size from editor; font family / bold from preset. */
  const primary = hexToAssBgr(s.primaryColor);
  const outlineC = hexToAssBgr(s.outlineColor);
  const back = '&H00000000';
  const bold = preset.bold ? -1 : 0;
  /**
   * Map editor slider (14–72) to ASS FontSize in PlayRes 1080×1920.
   * Keep in sync with `editorFontSizeToBurnInPreviewPx` in `src/components/CaptionLivePreview.tsx`.
   */
  const assFontSize = Math.min(180, Math.max(24, Math.round(s.fontSize * 2.35)));
  /** Thicker outline at large sizes so glyphs stay readable on vertical video. */
  const outlineW = Math.min(16, Math.max(s.outline, Math.round(assFontSize * 0.07)));

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
    `Style: Default,${preset.fontName},${assFontSize},${primary},&H000000FF,${outlineC},${back},${bold},0,0,0,118,118,0,0,1,${outlineW},${s.shadow},5,${s.marginLR},${s.marginLR},${s.marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n');

  const lines = blocks.map((b) => {
    const startAt = Math.max(0, Math.round(b.startMs + startOffsetMs));
    const endAt = Math.max(startAt + 50, Math.round(b.endMs + startOffsetMs));
    const start = formatAssTs(startAt);
    const end = formatAssTs(endAt);
    const body = `{\\an5\\fs${assFontSize}}${escapeAssText(b.text)}`;
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
