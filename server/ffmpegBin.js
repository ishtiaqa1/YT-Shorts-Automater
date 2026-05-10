import { dirname, join, normalize } from 'path';

function resolveEnvPath(raw) {
  if (!raw) return raw;
  // Windows: forward slashes in .env avoid accidental escapes (\f in \ffmpeg).
  if (process.platform === 'win32') {
    return normalize(raw.replace(/\//g, '\\'));
  }
  return raw;
}

/** Full path to ffmpeg.exe when PATH is not updated (common on Windows after winget). */
export function ffmpegPath() {
  const raw = process.env.FFMPEG_PATH?.trim();
  if (!raw) return 'ffmpeg';
  return resolveEnvPath(raw);
}

/** Defaults next to ffmpeg when FFMPEG_PATH is set. */
export function ffprobePath() {
  const p = process.env.FFPROBE_PATH?.trim();
  if (p) return resolveEnvPath(p);
  const fp = process.env.FFMPEG_PATH?.trim();
  if (fp) {
    const dir = dirname(resolveEnvPath(fp));
    return join(dir, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  }
  return 'ffprobe';
}
