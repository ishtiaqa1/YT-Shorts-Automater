import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { ffmpegPath, ffprobePath } from '../ffmpegBin.js';

/**
 * Wall-clock **3:00** (180s). YouTube Shorts must be **strictly under** this many seconds (179.99s OK, 180s is not).
 * We split when the render is **≥** this length so every uploaded part stays below the cap.
 */
export const YOUTUBE_SHORT_STRICT_MAX_SEC = 3 * 60;

/** @deprecated use {@link YOUTUBE_SHORT_STRICT_MAX_SEC} */
export const YOUTUBE_SHORT_PLATFORM_MAX_SEC = YOUTUBE_SHORT_STRICT_MAX_SEC;

/**
 * Each written part is capped well under 3:00 so re-encode rounding never lands on or past the Shorts limit.
 * Parts use **re-encode** (not stream-copy) so cuts start on a real keyframe.
 */
export const YOUTUBE_SHORT_SEGMENT_TARGET_SEC = 3 * 60 - 6;

/** @deprecated use {@link YOUTUBE_SHORT_STRICT_MAX_SEC} */
export const YOUTUBE_SHORT_MAX_DURATION_SEC = YOUTUBE_SHORT_STRICT_MAX_SEC;

/** Stagger between scheduled uploads when a project is split into multiple Shorts-sized parts (one part per day). */
export const SHORTS_MULTI_PART_GAP_MS = 24 * 60 * 60 * 1000;

/** Match `render.js` so split passes look like the main Short export. */
const ALLOWED_X264_PRESETS = new Set([
  'ultrafast',
  'superfast',
  'veryfast',
  'faster',
  'fast',
  'medium',
  'slow',
]);

function splitSegmentX264Preset() {
  const raw = String(process.env.RENDER_FFMPEG_PRESET || 'veryfast').trim().toLowerCase();
  return ALLOWED_X264_PRESETS.has(raw) ? raw : 'veryfast';
}

function splitSegmentX264Crf() {
  const n = Number(process.env.RENDER_FFMPEG_CRF);
  if (Number.isFinite(n) && n >= 18 && n <= 32) return Math.round(n);
  return 23;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr?.on('data', (d) => {
      err += d.toString();
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} → ${code}: ${err.slice(-2000)}`));
    });
  });
}

/**
 * @param {string} videoPath
 * @returns {Promise<number>}
 */
export async function probeVideoDurationSeconds(videoPath) {
  if (!existsSync(videoPath)) throw new Error('video not found for probe');
  const out = await new Promise((resolve, reject) => {
    const p = spawn(ffprobePath(), [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      videoPath,
    ]);
    let s = '';
    p.stdout?.on('data', (d) => {
      s += d.toString();
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve(s.trim());
      else reject(new Error(`ffprobe exit ${code}`));
    });
  });
  const n = Number(out);
  if (!Number.isFinite(n) || n <= 0) throw new Error('could not read duration');
  return n;
}

/**
 * First video stream pixel size (before display-matrix rotation — good enough for Shorts sanity checks).
 * @param {string} videoPath
 * @returns {Promise<{ width: number; height: number }>}
 */
export async function probePrimaryVideoStreamSize(videoPath) {
  if (!existsSync(videoPath)) throw new Error('video not found for probe');
  const raw = await new Promise((resolve, reject) => {
    const p = spawn(ffprobePath(), [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'json',
      videoPath,
    ]);
    let s = '';
    p.stdout?.on('data', (d) => {
      s += d.toString();
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve(s.trim());
      else reject(new Error(`ffprobe stream exit ${code}`));
    });
  });
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    throw new Error('could not parse ffprobe video stream json');
  }
  const st = Array.isArray(j?.streams) ? j.streams[0] : null;
  const w = Number(st?.width);
  const h = Number(st?.height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    throw new Error('could not read video width/height');
  }
  return { width: w, height: h };
}

/**
 * If total duration is **≥ 3:00** (180s), split into `short_part01.mp4`, … in `workDir` so each part is strictly under 3:00.
 * Otherwise returns a single segment pointing at `inputPath`.
 *
 * @param {string} inputPath absolute path to full render (e.g. short.mp4)
 * @param {string} workDir project render directory
 * @param {number} durationSeconds trusted duration when known
 * @returns {Promise<{ path: string; seconds: number; index: number; total: number }[]>}
 */
export async function buildShortSizedSegments(inputPath, workDir, durationSeconds) {
  if (!existsSync(inputPath)) {
    throw new Error('rendered video missing for split');
  }

  const probed = await probeVideoDurationSeconds(inputPath);
  const db = Number(durationSeconds);
  /** Prefer on-disk length — DB `duration_seconds` is often rounded and can hide a 3:01 file behind 3:00. */
  const total = Math.max(probed, Number.isFinite(db) && db > 0 ? db : 0);

  if (total < YOUTUBE_SHORT_STRICT_MAX_SEC) {
    return [{ path: inputPath, seconds: total, index: 1, total: 1 }];
  }

  const chunk = YOUTUBE_SHORT_SEGMENT_TARGET_SEC;
  const n = Math.ceil(total / chunk);
  const preset = splitSegmentX264Preset();
  const crf = splitSegmentX264Crf();
  /** @type {{ path: string; seconds: number; index: number; total: number }[]} */
  const segments = [];
  for (let i = 0; i < n; i += 1) {
    const start = i * chunk;
    const segDur = Math.min(chunk, total - start);
    const outPath = join(workDir, `short_part${String(i + 1).padStart(2, '0')}.mp4`);
    /**
     * Do **not** use `-c copy` for mid-file cuts: the mux often starts on a non-keyframe, so players show one
     * frozen frame until the next GOP (often ~5–10s) while audio plays — burned captions/BG look “stuck”.
     * Re-encode after `-ss` so frame 0 is a real decoded picture + a fresh IDR.
     */
    await run(ffmpegPath(), [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-threads',
      '0',
      '-i',
      inputPath,
      '-ss',
      String(start),
      '-t',
      String(segDur),
      '-map',
      '0:v:0',
      '-map',
      '0:a:0',
      '-c:v',
      'libx264',
      '-preset',
      preset,
      '-crf',
      String(crf),
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-movflags',
      '+faststart',
      outPath,
    ]);
    segments.push({ path: outPath, seconds: segDur, index: i + 1, total: n });
  }
  return segments;
}
