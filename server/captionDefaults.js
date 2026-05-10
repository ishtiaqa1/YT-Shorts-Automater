/** Clamp + sanitize caption appearance from DB JSON for FFmpeg / SRT. */

import { hexToAssBgr, normalizeCaptionHex } from './captionColor.js';

export function clamp(n, lo, hi) {
  const x = Number(n);
  if (!Number.isFinite(x)) return lo;
  return Math.min(hi, Math.max(lo, Math.round(x)));
}

/**
 * @param {Record<string, unknown> | null | undefined} raw
 * @returns {{
 *   fontSize: number;
 *   marginV: number;
 *   marginLR: number;
 *   outline: number;
 *   primaryColor: string;
 *   outlineColor: string;
 *   shadow: number;
 *   maxWordsPerLine: number;
 *   maxWordsPerCue: number;
 * }}
 */
export function normalizeCaptionSettings(raw) {
  const o = raw != null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const legacyLine =
    typeof o.maxCharsPerLine === 'number' ? Math.max(2, Math.round(o.maxCharsPerLine / 5)) : undefined;
  const legacyCue =
    typeof o.maxCharsPerCue === 'number' ? Math.max(4, Math.round(o.maxCharsPerCue / 7)) : undefined;
  return {
    /** Scaled in PlayRes 1080×1920 — larger reads better on phones. */
    fontSize: clamp(o.fontSize ?? 28, 14, 52),
    /**
     * With Alignment=5 (middle center), marginV is a small vertical nudge in libass (0 ≈ optic center).
     * Legacy projects stored huge values for bottom anchoring — remap so center layout isn’t pushed off-screen.
     */
    marginV: normalizeMarginV(o.marginV),
    /** Inset from left/right (px) in ASS; 0 = use full frame width for text. Also used for line-wrap math. */
    marginLR: clamp(o.marginLR ?? 4, 0, 220),
    outline: clamp(o.outline ?? 4, 0, 12),
    /** Fill / stroke colours as RRGGBB (no '#'); preview + ASS PrimaryColour / OutlineColour. */
    primaryColor: normalizeCaptionHex(o.primaryColor, 'ffffff'),
    outlineColor: normalizeCaptionHex(o.outlineColor, '000000'),
    /** ASS Style shadow depth (drop shadow behind text). */
    shadow: clamp(o.shadow ?? 2, 0, 8),
    maxWordsPerLine: clamp(
      typeof o.maxWordsPerLine === 'number' ? o.maxWordsPerLine : legacyLine ?? 5,
      2,
      16
    ),
    maxWordsPerCue: clamp(
      typeof o.maxWordsPerCue === 'number' ? o.maxWordsPerCue : legacyCue ?? 16,
      4,
      80
    ),
  };
}

/**
 * @param {unknown} raw
 */
function normalizeMarginV(raw) {
  if (raw === undefined || raw === null) return 0;
  const x = Number(raw);
  if (!Number.isFinite(x)) return 0;
  /** Old bottom-anchored saves used 80–620; treat as legacy and snap to centered nudge 0. */
  if (x >= 80) return 0;
  return clamp(x, 0, 120);
}

/** FFmpeg subtitles force_style (PlayRes matches 9:16 frame so margins scale correctly). */
export function buildCaptionForceStyle(settings) {
  const s = normalizeCaptionSettings(settings);
  const primary = hexToAssBgr(s.primaryColor);
  const outlineC = hexToAssBgr(s.outlineColor);
  const tail = `PrimaryColour=${primary},OutlineColour=${outlineC},Outline=${s.outline},Shadow=${s.shadow}`;
  /** Alignment=5: horizontal + vertical center; MarginL/R inset from sides; MarginV small nudge for libass middle layout. */
  return `PlayResX=1080,PlayResY=1920,FontName=Arial Black,FontSize=${s.fontSize},${tail},Alignment=5,MarginV=${s.marginV},MarginL=${s.marginLR},MarginR=${s.marginLR},WrapStyle=0`;
}
