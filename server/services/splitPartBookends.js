import { spawn } from 'child_process';
import { mkdirSync, unlinkSync, renameSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { ffmpegPath } from '../ffmpegBin.js';
import { synthesizeSpeech } from './tts.js';
import { combineTitleBeforeStory } from './spokenScript.js';
import { probeVideoDurationSeconds } from './splitVideoForShorts.js';

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr?.on('data', (d) => {
      err += d.toString();
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg ${args.join(' ')} → ${code}: ${err.slice(-2000)}`));
    });
  });
}

/**
 * Mux segment video with optional prefix/suffix narration (same TTS stack as main render).
 * Pads video with cloned first/last frames to match longer audio.
 *
 * @param {{ inputVideo: string; prefixAudio: string | null; suffixAudio: string | null; outputPath: string }} o
 */
async function muxSegmentWithBookendAudio(o) {
  const { inputVideo, prefixAudio, suffixAudio, outputPath } = o;
  let P = 0;
  let S = 0;
  if (prefixAudio && existsSync(prefixAudio)) {
    P = await probeVideoDurationSeconds(prefixAudio);
  }
  if (suffixAudio && existsSync(suffixAudio)) {
    S = await probeVideoDurationSeconds(suffixAudio);
  }

  const pStr = String(Math.max(0, P).toFixed(3));
  const sStr = String(Math.max(0, S).toFixed(3));

  const aFmt = 'aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS';

  /** @type {string[]} */
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-threads', '0', '-i', inputVideo];
  if (P > 0 && prefixAudio) {
    args.push('-i', prefixAudio);
  }
  if (S > 0 && suffixAudio) {
    args.push('-i', suffixAudio);
  }

  let filter = '';
  if (P > 0 && S > 0) {
    filter = `[1:a]${aFmt}[apre];[0:a]${aFmt}[abod];[2:a]${aFmt}[asuf];[apre][abod]concat=n=2:v=0:a=1[am1];[am1][asuf]concat=n=2:v=0:a=1[aout];[0:v]tpad=start_duration=${pStr}:stop_duration=${sStr}:start_mode=clone:stop_mode=clone,format=yuv420p[vout]`;
  } else if (P > 0) {
    filter = `[1:a]${aFmt}[apre];[0:a]${aFmt}[abod];[apre][abod]concat=n=2:v=0:a=1[aout];[0:v]tpad=start_duration=${pStr}:stop_duration=0:start_mode=clone,format=yuv420p[vout]`;
  } else if (S > 0) {
    filter = `[1:a]${aFmt}[asuf];[0:a]${aFmt}[abod];[abod][asuf]concat=n=2:v=0:a=1[aout];[0:v]tpad=stop_duration=${sStr}:stop_mode=clone,format=yuv420p[vout]`;
  } else {
    throw new Error('muxSegmentWithBookendAudio: no prefix or suffix');
  }

  args.push(
    '-filter_complex',
    filter,
    '-map',
    '[vout]',
    '-map',
    '[aout]',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-movflags',
    '+faststart',
    outputPath
  );

  await runFfmpeg(args);
}

/**
 * For multi-part Shorts exports (AI voice): part 1 keeps opening title from main render; parts 2+ get a spoken
 * title + part index at the start; every part except the last appends “Subscribe for the next part.”
 *
 * @param {{ path: string; seconds: number; index: number; total: number }[]} segMeta
 * @param {string} workDir
 * @param {{ title: string; voiceSource: string | null | undefined }} ctx0
 * @returns {Promise<typeof segMeta>}
 */
export async function applySplitPartBookendTts(segMeta, workDir, ctx0) {
  const list = Array.isArray(segMeta) ? segMeta : [];
  if (list.length <= 1) return list;
  if (String(ctx0.voiceSource || '').toLowerCase() === 'uploaded') return list;

  const titleStr = String(ctx0.title || '').trim() || 'Short';
  const subscribeText = 'Subscribe for the next part.';

  for (const seg of list) {
    const needPrefix = seg.index > 1;
    const needSuffix = seg.index < seg.total;

    if (!needPrefix && !needSuffix) continue;

    const tmpOut = join(workDir, `short_part${String(seg.index).padStart(2, '0')}_booktmp.mp4`);

    /** @type {string | null} */
    let prefixMp3 = null;
    if (needPrefix) {
      const prefDir = join(workDir, `_bookend_pref_${String(seg.index).padStart(2, '0')}`);
      rmSync(prefDir, { recursive: true, force: true });
      mkdirSync(prefDir, { recursive: true });
      const prefixText = combineTitleBeforeStory(titleStr, `Part ${seg.index} of ${seg.total}.`);
      const { audioPath } = await synthesizeSpeech(prefixText, prefDir);
      prefixMp3 = audioPath;
    }

    /** @type {string | null} */
    let suffixMp3 = null;
    if (needSuffix) {
      const sufDir = join(workDir, `_bookend_suf_${String(seg.index).padStart(2, '0')}`);
      rmSync(sufDir, { recursive: true, force: true });
      mkdirSync(sufDir, { recursive: true });
      const { audioPath } = await synthesizeSpeech(subscribeText, sufDir);
      suffixMp3 = audioPath;
    }

    await muxSegmentWithBookendAudio({
      inputVideo: seg.path,
      prefixAudio: prefixMp3,
      suffixAudio: suffixMp3,
      outputPath: tmpOut,
    });

    try {
      unlinkSync(seg.path);
    } catch {
      /* ignore */
    }
    renameSync(tmpOut, seg.path);

    try {
      if (prefixMp3 && existsSync(prefixMp3)) unlinkSync(prefixMp3);
    } catch {
      /* ignore */
    }
    try {
      if (suffixMp3 && existsSync(suffixMp3)) unlinkSync(suffixMp3);
    } catch {
      /* ignore */
    }
    try {
      rmSync(join(workDir, `_bookend_pref_${String(seg.index).padStart(2, '0')}`), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    try {
      rmSync(join(workDir, `_bookend_suf_${String(seg.index).padStart(2, '0')}`), { recursive: true, force: true });
    } catch {
      /* ignore */
    }

    try {
      seg.seconds = await probeVideoDurationSeconds(seg.path);
    } catch {
      /* keep prior */
    }
  }

  return list;
}
