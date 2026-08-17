import { existsSync } from 'fs';
import { spawn } from 'child_process';
import { ffmpegPath } from '../ffmpegBin.js';

/** Wall-clock Reddit intro at start of renders (seconds). Clamped; see `.env.example`. */
export function clampRedditIntroSeconds() {
  const raw = Number(process.env.REDDIT_INTRO_SECONDS);
  let s = Number.isFinite(raw) && raw > 0 ? raw : 3.5;
  return Math.min(6, Math.max(1.2, s));
}

/**
 * @param {number} totalDurationSec audio / output length
 * @param {string} permalinkTrimmed non-empty when Reddit intro applies
 * @returns {number} 0 when no intro
 */
export function effectiveRedditIntroSeconds(totalDurationSec, permalinkTrimmed) {
  if (!permalinkTrimmed) return 0;
  let s = clampRedditIntroSeconds();
  const total = Number(totalDurationSec);
  if (Number.isFinite(total) && total > 0.5 && s >= total - 0.25) {
    s = Math.max(0.8, Math.min(2.4, total * 0.15));
  }
  return s;
}

/**
 * Poster frame seek for YouTube: skip Reddit intro so the thumb is gameplay + captions, not the card.
 * @param {{ reddit_permalink?: string | null }} [project]
 * @param {number} [durationSec] output duration (caps seek)
 */
export function thumbnailSeekSecondsForProject(project, durationSec = 600) {
  const rp = String(project?.reddit_permalink ?? '').trim();
  if (!rp) return 1;
  const t = Math.min(20, clampRedditIntroSeconds() + 0.85);
  const d = Number(durationSec);
  if (Number.isFinite(d) && d > 0.2) return Math.max(0.25, Math.min(d - 0.05, t));
  return t;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { ...opts });
    let err = '';
    p.stderr?.on('data', (d) => {
      err += d.toString();
    });
    p.on('error', (e) => reject(e));
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} → ${code}: ${err}`));
    });
  });
}

/**
 * Extract a poster frame from an MP4.
 * @param {string} videoPath
 * @param {string} outJpgAbs
 * @param {{ seekSeconds?: number }} [opts] defaults to 1s
 */
export async function extractVideoThumbnailJpg(videoPath, outJpgAbs, opts = {}) {
  if (!existsSync(videoPath)) {
    throw new Error('video not found');
  }
  const seek = Number(opts.seekSeconds);
  const sec = Number.isFinite(seek) && seek > 0.04 ? seek : 1;
  /** Same 9:16 frame size as uploads so composites & YouTube thumbnails stay sharp. */
  await run(
    ffmpegPath(),
    [
      '-y',
      '-ss',
      String(sec),
      '-i',
      videoPath,
      '-vf',
      'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920',
      '-vframes',
      '1',
      '-q:v',
      '2',
      outJpgAbs,
    ],
    {}
  );
  return outJpgAbs;
}
