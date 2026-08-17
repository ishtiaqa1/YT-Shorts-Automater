/**
 * Vertical MP4/WebM presets under assets (no remote stock APIs).
 */

import { existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { basename, join, resolve, sep } from 'path';
import { randomInt } from 'node:crypto';

const GAMEPLAY_DIR = join(process.cwd(), 'assets', 'gameplay');
const THEMES_ROOT = join(process.cwd(), 'assets', 'background_themes');

/** Display order — `gameplay` uses legacy bundled folder. */
export const BACKGROUND_THEME_ORDER = [
  { id: 'gameplay', label: 'Gameplay' },
  { id: 'calm', label: 'Calm' },
  { id: 'hype', label: 'Hype' },
];

export const DEFAULT_BACKGROUND_THEME_ID = 'gameplay';

export function sanitizeThemeId(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (/^[a-z0-9_-]{1,32}$/.test(s) && BACKGROUND_THEME_ORDER.some((t) => t.id === s)) return s;
  return DEFAULT_BACKGROUND_THEME_ID;
}

function themeDir(themeId) {
  if (themeId === 'gameplay') return GAMEPLAY_DIR;
  return join(THEMES_ROOT, themeId);
}

export function ensureBackgroundThemeDirectories() {
  mkdirSync(GAMEPLAY_DIR, { recursive: true });
  mkdirSync(THEMES_ROOT, { recursive: true });
  for (const { id } of BACKGROUND_THEME_ORDER) {
    if (id !== 'gameplay') mkdirSync(join(THEMES_ROOT, id), { recursive: true });
  }
}

function isSafeVideoFilename(name) {
  if (!name || name !== basename(name) || name.includes('..')) return false;
  return /^[a-zA-Z0-9._-]+$/.test(name);
}

/** @returns {string[]} basenames sorted */
export function listVideoBasenames(themeId) {
  const id = sanitizeThemeId(themeId);
  const dir = themeDir(id);
  mkdirSync(dir, { recursive: true });
  try {
    return readdirSync(dir)
      .filter((n) => isSafeVideoFilename(n) && /\.(mp4|webm)$/i.test(n))
      .filter((n) => statSync(join(dir, n)).isFile())
      .sort();
  } catch {
    return [];
  }
}

/** @returns {string | null} absolute path */
export function resolveBundledPresetAbsolute(themeId, filename) {
  const id = sanitizeThemeId(themeId);
  const raw = String(filename || '').trim();
  const base = basename(raw);
  if (!base || base !== raw || !isSafeVideoFilename(base) || !/\.(mp4|webm)$/i.test(base)) return null;
  const dir = resolve(themeDir(id));
  const abs = resolve(join(dir, base));
  if (abs !== dir && !abs.startsWith(dir + sep)) return null;
  return existsSync(abs) ? abs : null;
}

/**
 * Prefer `theme`, then gameplay, then any other bundled theme folder that has clips.
 * @returns {string | null} absolute path to a bundled video file
 */
export function pickRandomBundledAbsolutePath(themeRaw) {
  const primary = sanitizeThemeId(themeRaw);
  const fallbackOrder = [primary, DEFAULT_BACKGROUND_THEME_ID];
  const seen = new Set();
  for (const tid of BACKGROUND_THEME_ORDER.map((x) => x.id)) {
    if (!fallbackOrder.includes(tid)) fallbackOrder.push(tid);
  }
  for (const tid of fallbackOrder) {
    if (seen.has(tid)) continue;
    seen.add(tid);
    const files = listVideoBasenames(tid);
    if (files.length === 0) continue;
    const pick = files[randomInt(files.length)];
    const abs = join(themeDir(tid), pick);
    return existsSync(abs) ? resolve(abs) : null;
  }
  return null;
}

export function isBundledAssetPath(absPath) {
  if (!absPath || typeof absPath !== 'string') return false;
  try {
    const p = resolve(absPath);
    const g = resolve(GAMEPLAY_DIR);
    if (p.startsWith(g + sep)) return true;
    const tr = resolve(THEMES_ROOT);
    return p.startsWith(tr + sep);
  } catch {
    return false;
  }
}

/** True when `absPath` is a bundled clip under the folder for `themeRaw` (`assets/gameplay` or `assets/background_themes/<id>`). */
export function bundledVideoBelongsToTheme(themeRaw, absPath) {
  if (!absPath || typeof absPath !== 'string') return false;
  try {
    if (!isBundledAssetPath(absPath)) return false;
    const id = sanitizeThemeId(themeRaw);
    const dir = resolve(themeDir(id));
    const p = resolve(absPath);
    if (!existsSync(p)) return false;
    return p === dir || p.startsWith(dir + sep);
  } catch {
    return false;
  }
}

/** True for files under uploads/{userSub}/user_bg/ (temporary render-only uploads). */
export function isEphemeralUserBackgroundPath(absPath, userSub) {
  if (!absPath || !userSub || typeof absPath !== 'string') return false;
  try {
    const p = resolve(absPath);
    const marker = resolve(join(process.cwd(), 'uploads', String(userSub), 'user_bg'));
    return p === marker || p.startsWith(marker + sep);
  } catch {
    return false;
  }
}
