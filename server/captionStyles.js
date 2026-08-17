/**
 * Preset caption styles (ASS). Colours are &HAABBGGRR matching FFmpeg force_style strings in the product spec.
 * @type {Record<string, { fontName: string; fontSize: number; primary: string; outlineC: string; outline: number; bold: boolean; shadow: number }>}
 */
export const CAPTION_STYLE_PRESETS = {
  bold_pop: {
    fontName: 'Arial Black',
    fontSize: 24,
    primary: '&H00FFFFFF',
    outlineC: '&H00000000',
    outline: 4,
    bold: true,
    shadow: 1,
  },
  clean_minimal: {
    fontName: 'Arial',
    fontSize: 18,
    primary: '&H00FFFFFF',
    outlineC: '&H00000000',
    outline: 2,
    bold: false,
    shadow: 0,
  },
  neon_glow: {
    fontName: 'Arial Black',
    fontSize: 22,
    primary: '&H0000FFFF',
    outlineC: '&H00FF00FF',
    outline: 3,
    bold: true,
    shadow: 2,
  },
  outlined: {
    fontName: 'Arial Black',
    fontSize: 22,
    primary: '&H00000000',
    outlineC: '&H00FFFFFF',
    outline: 4,
    bold: true,
    shadow: 1,
  },
  typewriter: {
    fontName: 'Courier New',
    fontSize: 18,
    primary: '&H00FFFFFF',
    outlineC: '&H00000000',
    outline: 2,
    bold: false,
    shadow: 0,
  },
};

const DEFAULT_KEY = 'bold_pop';

/**
 * @param {string | null | undefined} key
 */
export function resolveCaptionStylePreset(key) {
  const k = typeof key === 'string' && key in CAPTION_STYLE_PRESETS ? key : DEFAULT_KEY;
  return { key: k, preset: CAPTION_STYLE_PRESETS[k] };
}
