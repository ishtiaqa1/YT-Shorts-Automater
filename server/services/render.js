import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import { synthesizeSpeech } from './tts.js';
import { buildSrtFromScript } from './captioning.js';

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
    const p = spawn('ffprobe', args);
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

function isSyntheticDefaultBg(bgPath) {
  return bgPath.endsWith('_default_vertical.mp4');
}

/** Generate a neutral vertical loop if user provided no background file. */
async function ensureDefaultBackground(bgDir) {
  mkdirSync(bgDir, { recursive: true });
  const p = join(bgDir, '_default_vertical.mp4');
  if (existsSync(p)) return p;
  await run('ffmpeg', [
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
  workDir,
  backgroundPath,
  outputFilename = 'short.mp4',
}) {
  mkdirSync(workDir, { recursive: true });

  const { audioPath } = await synthesizeSpeech(scriptText, workDir);
  const duration = await ffprobeMediaDuration(audioPath);
  const srtContent = buildSrtFromScript(scriptText, duration);
  const srtPath = join(workDir, 'captions.srt');
  writeFileSync(srtPath, srtContent, 'utf8');

  let bg =
    backgroundPath && existsSync(backgroundPath)
      ? backgroundPath
      : await ensureDefaultBackground(join(workDir, 'generated'));

  const outPath = join(workDir, outputFilename);

  /** Bottom-centered captions with extra bottom margin (Shorts player chrome safe-ish zone). */
  const vf = [
    `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[bg]`,
    `[bg]subtitles=captions.srt:force_style='FontName=Arial Black,FontSize=22,PrimaryColour=&HFFFFFF,OutlineColour=&H000000,Outline=3,Shadow=1,Alignment=2,MarginV=168'[vout]`,
  ].join(';');

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

  await run(
    'ffmpeg',
    [
      ...argsPrefix,
      ...bgInputArgs,
      '-i',
      audioPath,
      '-filter_complex',
      vf,
      '-map',
      '[vout]',
      '-map',
      '1:a:0',
      '-shortest',
      '-c:v',
      'libx264',
      '-preset',
      'fast',
      '-crf',
      '23',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-movflags',
      '+faststart',
      outPath,
    ],
    { cwd: workDir }
  );

  return { outPath, durationSeconds: duration };
}
