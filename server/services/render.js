import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import { synthesizeSpeech } from './tts.js';
import { buildAssFromScript } from './captioning.js';
import { ffmpegPath, ffprobePath } from '../ffmpegBin.js';
import { writeRedditIntroCardPng } from './thumbnailGen.js';
import { effectiveRedditIntroSeconds } from './thumbnail.js';

const MAX_FFmpeg_STDERR_CHARS = 12_000;
/** FFmpeg refreshes stats with `\r`; keep tail so we don't grow forever */
const PROGRESS_LINE_BUF_CAP = 16_384;
const FFMPEG_ENCODE_TIMEOUT_MS = Math.max(
  120_000,
  Number(process.env.RENDER_FFMPEG_TIMEOUT_MS) || 45 * 60 * 1000
);

const ALLOWED_X264_PRESETS = new Set([
  'ultrafast',
  'superfast',
  'veryfast',
  'faster',
  'fast',
  'medium',
  'slow',
]);

function renderX264Preset() {
  const raw = String(process.env.RENDER_FFMPEG_PRESET || 'veryfast').trim().toLowerCase();
  return ALLOWED_X264_PRESETS.has(raw) ? raw : 'veryfast';
}

function renderX264Crf() {
  const n = Number(process.env.RENDER_FFMPEG_CRF);
  if (Number.isFinite(n) && n >= 18 && n <= 32) return Math.round(n);
  return 23;
}

/** Second full-audio FFmpeg pass for caption alignment; set RENDER_SILENCE_DETECT=0 to skip (faster, slightly less tight cues). */
function silenceDetectEnabled() {
  return String(process.env.RENDER_SILENCE_DETECT ?? '1').trim() !== '0';
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { ...opts });
    let err = '';
    p.stderr?.on('data', (d) => {
      err = (err + d.toString()).slice(-MAX_FFmpeg_STDERR_CHARS);
    });
    p.on('error', (e) => reject(e));
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} → ${code}: ${err}`));
    });
  });
}

/** FFmpeg progress lines use `time=HH:MM:SS.xx` */
function ffmpegTimeSecondsFromLine(line) {
  const m = line.match(/time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  const m2 = line.match(/time=\s*(\d+(?:\.\d+)?)\b/);
  if (m2) return Number(m2[1]);
  return null;
}

/**
 * FFmpeg encode with optional progress + hard timeout (avoids “stuck at 70%”).
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {number} [opts.durationSec] audio/output duration for progress %
 * @param {(pct: number, phase: string) => Promise<void>} [opts.onEncodeProgress]
 */
function runFfmpegEncode(cmd, args, opts = {}) {
  const { cwd, durationSec = 0, onEncodeProgress } = opts;
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let err = '';
    let lineBuf = '';
    let killed = false;
    let lastEmittedPct = 70;
    let settled = false;

    const timer =
      FFMPEG_ENCODE_TIMEOUT_MS > 0 &&
      setTimeout(() => {
        if (settled) return;
        settled = true;
        killed = true;
        try {
          p.kill('SIGTERM');
          setTimeout(() => p.kill('SIGKILL'), 3500).unref?.();
        } catch {
          /* ignore */
        }
        reject(
          new Error(
            `FFmpeg encode timed out after ${Math.round(FFMPEG_ENCODE_TIMEOUT_MS / 1000)}s (set RENDER_FFMPEG_TIMEOUT_MS to raise). Output tail: ${err.slice(-900)}`
          )
        );
      }, FFMPEG_ENCODE_TIMEOUT_MS);
    timer?.unref?.();

    const pushStderrChunk = (chunk) => {
      if (killed) return;
      lineBuf += chunk;
      const parts = lineBuf.split(/\r|\n/g);
      lineBuf = parts.pop() ?? '';
      if (lineBuf.length > PROGRESS_LINE_BUF_CAP) {
        lineBuf = lineBuf.slice(-PROGRESS_LINE_BUF_CAP);
      }
      if (
        typeof onEncodeProgress !== 'function' ||
        !durationSec ||
        durationSec <= 0.1
      ) {
        return;
      }
      for (const line of parts) {
        const t = ffmpegTimeSecondsFromLine(line);
        if (t == null || !Number.isFinite(t)) continue;
        const ratio = Math.min(1, Math.max(0, t / durationSec));
        const pct = Math.min(99, Math.floor(70 + ratio * 29));
        if (pct <= lastEmittedPct) continue;
        lastEmittedPct = pct;
        void onEncodeProgress(pct, 'Encoding video…');
      }
    };

    p.stdout?.on('data', () => {});
    p.stderr?.on('data', (d) => {
      const s = d.toString();
      err = (err + s).slice(-MAX_FFmpeg_STDERR_CHARS);
      pushStderrChunk(s);
    });
    p.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (killed) return;
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} → ${code}: ${err}`));
    });
  });
}

async function ffprobeMediaDuration(mediaPath) {
  const args = [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    mediaPath,
  ];
  return new Promise((resolve, reject) => {
    const p = spawn(ffprobePath(), args);
    let out = '';
    let err = '';
    p.stdout?.on('data', (d) => {
      out += d.toString();
    });
    p.stderr?.on('data', (d) => {
      err += d.toString();
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) reject(new Error(`ffprobe ${err}`));
      else resolve(parseFloat(out.trim()) || 0);
    });
  });
}

/**
 * Detect leading/trailing silence so captions can align with spoken words.
 * @param {string} mediaPath
 * @param {number} totalDurationSec
 * @returns {Promise<{ leadSec: number; tailSec: number }>}
 */
async function detectSpeechPadding(mediaPath, totalDurationSec) {
  const args = [
    '-hide_banner',
    '-nostats',
    '-i',
    mediaPath,
    '-af',
    'silencedetect=noise=-38dB:d=0.08',
    '-f',
    'null',
    '-',
  ];
  return new Promise((resolve) => {
    const p = spawn(ffmpegPath(), args);
    let err = '';
    p.stderr?.on('data', (d) => {
      err += d.toString();
    });
    p.on('error', () => resolve({ leadSec: 0, tailSec: 0 }));
    p.on('close', () => {
      const starts = [];
      const ends = [];
      const startRe = /silence_start:\s*([0-9.]+)/g;
      const endRe = /silence_end:\s*([0-9.]+)/g;
      for (const m of err.matchAll(startRe)) starts.push(Number(m[1]));
      for (const m of err.matchAll(endRe)) ends.push(Number(m[1]));

      let leadSec = 0;
      // Leading silence is usually first segment starting near 0 with a matching silence_end.
      if (starts.length > 0 && ends.length > 0 && starts[0] <= 0.06) {
        leadSec = Math.max(0, ends[0]);
      }

      let tailSec = 0;
      // Trailing silence typically ends at EOF with last silence_start near end.
      if (starts.length > 0) {
        const lastStart = starts[starts.length - 1];
        const tail = Math.max(0, totalDurationSec - lastStart);
        if (tail > 0.06) tailSec = tail;
      }

      // Keep alignment conservative so we never skip spoken words.
      resolve({
        leadSec: Math.min(0.9, leadSec),
        tailSec: Math.min(0.9, tailSec),
      });
    });
  });
}

function isSyntheticDefaultBg(bgPath) {
  return bgPath.endsWith('_default_vertical.mp4');
}

/** Generate a neutral vertical loop if user provided no background file. */
async function ensureDefaultBackground(bgDir) {
  mkdirSync(bgDir, { recursive: true });
  const p = join(bgDir, '_default_vertical.mp4');
  if (existsSync(p)) return p;
  await run(ffmpegPath(), [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=#0f0f23:s=1080x1920:r=30',
    '-t',
    '120',
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    p,
  ]);
  return p;
}

/**
 * Composite vertical Short (9:16): gameplay-style background + TTS + burned captions.
 * Long backgrounds: picks a random start time each render so repeats don’t always share the same footage.
 * Short backgrounds: loops from a random entry point when possible.
 */
export async function renderShort({
  scriptText,
  /** Text used only for burned-in SRT; defaults to scriptText when omitted (same as spoken). */
  captionScriptText,
  workDir,
  backgroundPath,
  outputFilename = 'short.mp4',
  onProgress,
  captionSettings,
  /** ASS preset layer (fonts / colours aligned with FFmpeg force_style presets). */
  captionStyle,
  /** Optional royalty-free mp3/aac relative to assets/music/, or absolute path under cwd. */
  musicPath,
  musicVolume = 0.15,
  /** Optional user-recorded voiceover path; when provided, skips TTS synthesis. */
  voiceoverPath,
  /** When set (trimmed non-empty), a Reddit-style full-frame card shows for the first few seconds over gameplay. */
  redditPermalink = null,
  /** Shown on the intro card when the API has no title (optional). */
  redditIntroTitle = null,
  /** When false, skip burned-in ASS (voice + visuals only). Default true. */
  burnCaptions = true,
}) {
  mkdirSync(workDir, { recursive: true });

  const tick = async (pct, phase) => {
    if (typeof onProgress === 'function') await onProgress(pct, phase);
  };

  await tick(10, voiceoverPath ? 'Preparing uploaded voiceover…' : 'Synthesizing speech…');
  const { audioPath } =
    typeof voiceoverPath === 'string' && voiceoverPath && existsSync(voiceoverPath)
      ? { audioPath: voiceoverPath }
      : await synthesizeSpeech(scriptText, workDir);
  const duration = await ffprobeMediaDuration(audioPath);

  let leadSec = 0;
  let tailSec = 0;
  let captionDurationSec = Math.max(0.35, duration);
  let captionStartMs = 0;
  const burnIn = burnCaptions !== false;

  if (burnIn) {
    await tick(40, 'Timing captions…');
    const pad = silenceDetectEnabled() ? await detectSpeechPadding(audioPath, duration) : { leadSec: 0, tailSec: 0 };
    leadSec = pad.leadSec;
    tailSec = pad.tailSec;
    captionDurationSec = Math.max(0.35, duration - leadSec - tailSec);
    captionStartMs = Math.round(leadSec * 1000);
    const burnText = captionScriptText != null ? captionScriptText : scriptText;
    /** ASS (not SRT): libass centers with Style Alignment=5; SRT+force_style often stays bottom-aligned. */
    const assContent = buildAssFromScript(
      burnText,
      captionDurationSec,
      captionSettings,
      captionStyle,
      captionStartMs
    );
    const assPath = join(workDir, 'captions.ass');
    writeFileSync(assPath, `\ufeff${assContent}`, 'utf8');
  } else {
    await tick(40, 'Skipping burned captions…');
  }

  let introPngPath = null;
  let introSec = 0;
  const rp = typeof redditPermalink === 'string' ? redditPermalink.trim() : '';
  if (rp) {
    introSec = effectiveRedditIntroSeconds(duration, rp);
    if (introSec > 0.15) {
      introPngPath = join(workDir, 'reddit_intro.png');
      await tick(48, 'Reddit intro card…');
      await writeRedditIntroCardPng({
        redditPermalink: rp,
        titleFallback: typeof redditIntroTitle === 'string' ? redditIntroTitle : '',
        destPath: introPngPath,
      });
    }
  }

  await tick(52, 'Preparing background…');
  let bg =
    backgroundPath && existsSync(backgroundPath)
      ? backgroundPath
      : await ensureDefaultBackground(join(workDir, 'generated'));

  const outPath = join(workDir, outputFilename);

  const useMusic =
    typeof musicPath === 'string' && musicPath && existsSync(musicPath);

  const useRedditIntro = Boolean(introPngPath && existsSync(introPngPath) && introSec > 0.05);
  const introExpr = `lte(t\\,${String(Number(introSec.toFixed(3)))})`;

  /** Video subgraph + optional subtitles (PlayRes 1080×1920; `original_size` keeps libass scale aligned with cropped frame). */
  const bgSub = burnIn
    ? '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[bg];[bg]subtitles=captions.ass:original_size=1080x1920[vout]'
    : '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[vout]';

  const padSec = 0.35;
  let argsPrefix = ['-y'];
  let bgInputArgs;

  const userBg =
    Boolean(backgroundPath && existsSync(backgroundPath)) && !isSyntheticDefaultBg(bg);

  if (userBg) {
    const bgDur = await ffprobeMediaDuration(bg);
    const longEnough = bgDur >= duration + padSec;
    const maxStart = Math.max(0, bgDur - duration - padSec);
    const randomStart = maxStart > 0.08 ? Math.random() * maxStart : 0;

    if (longEnough) {
      if (randomStart > 0.02) {
        argsPrefix.push('-ss', String(randomStart));
      }
      bgInputArgs = ['-i', bg];
    } else {
      if (randomStart > 0.08 && randomStart < bgDur - 0.12) {
        argsPrefix.push('-ss', String(randomStart));
      }
      bgInputArgs = ['-stream_loop', '-1', '-i', bg];
    }
  } else {
    bgInputArgs = ['-stream_loop', '-1', '-i', bg];
  }

  await tick(70, 'Encoding video…');

  /** Voice is always input index `1`; optional Reddit intro PNG next; optional looped music last. */
  let ffArgs = [...argsPrefix, ...bgInputArgs, '-i', audioPath];

  /** @type {string} */
  let filterComplex;
  /** @type {string[]} */
  let maps;

  const volNum = Number.isFinite(musicVolume) ? Math.min(1.5, Math.max(0, musicVolume)) : 0.15;

  if (useRedditIntro) {
    ffArgs = [...ffArgs, '-loop', '1', '-framerate', '30', '-i', introPngPath];
  }

  if (useMusic && musicPath) {
    ffArgs = [...ffArgs, '-stream_loop', '-1', '-i', musicPath];
    if (useRedditIntro) {
      filterComplex = `${bgSub};[2:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,format=yuv420p[introfb];[vout][introfb]overlay=0:0:enable=${introExpr}[vfinal];[3:a]volume=${volNum}[mm];[1:a][mm]amix=inputs=2:duration=first[aout]`;
      maps = ['-filter_complex', filterComplex, '-map', '[vfinal]', '-map', '[aout]'];
    } else {
      filterComplex = `${bgSub};[2:a]volume=${volNum}[mm];[1:a][mm]amix=inputs=2:duration=first[aout]`;
      maps = ['-filter_complex', filterComplex, '-map', '[vout]', '-map', '[aout]'];
    }
  } else if (useRedditIntro) {
    filterComplex = `${bgSub};[2:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,format=yuv420p[introfb];[vout][introfb]overlay=0:0:enable=${introExpr}[vfinal]`;
    maps = ['-filter_complex', filterComplex, '-map', '[vfinal]', '-map', '1:a:0'];
  } else {
    filterComplex = bgSub;
    maps = ['-filter_complex', filterComplex, '-map', '[vout]', '-map', '1:a:0'];
  }

  const x264Preset = renderX264Preset();
  const x264Crf = renderX264Crf();
  await runFfmpegEncode(
    ffmpegPath(),
    [
      ...ffArgs,
      ...maps,
      '-shortest',
      '-threads',
      '0',
      '-c:v',
      'libx264',
      '-preset',
      x264Preset,
      '-crf',
      String(x264Crf),
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-movflags',
      '+faststart',
      outPath,
    ],
    {
      cwd: workDir,
      durationSec: Math.max(0.35, duration),
      onEncodeProgress: tick,
    }
  );

  await tick(100, 'Complete…');
  return { outPath, durationSeconds: duration };
}
