import { writeFileSync, readFileSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import { GoogleAuth } from 'google-auth-library';
import { ffmpegPath } from '../ffmpegBin.js';

function runCmd(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: true, ...options });
    let stderr = '';
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited ${code}: ${stderr}`));
    });
  });
}

/** Google Cloud TTS allows up to 5000 chars per request; stay under to avoid edge failures. */
const GOOGLE_TTS_CHUNK_CHARS = 4800;

function splitTextForGoogleTts(text) {
  const t = text.trim();
  if (t.length <= GOOGLE_TTS_CHUNK_CHARS) return [t];
  const parts = [];
  let rest = t;
  while (rest.length > 0) {
    if (rest.length <= GOOGLE_TTS_CHUNK_CHARS) {
      parts.push(rest);
      break;
    }
    let cut = rest.lastIndexOf('\n\n', GOOGLE_TTS_CHUNK_CHARS);
    if (cut < GOOGLE_TTS_CHUNK_CHARS / 2) cut = rest.lastIndexOf('. ', GOOGLE_TTS_CHUNK_CHARS);
    if (cut < GOOGLE_TTS_CHUNK_CHARS / 2) cut = rest.lastIndexOf(' ', GOOGLE_TTS_CHUNK_CHARS);
    if (cut < GOOGLE_TTS_CHUNK_CHARS / 2) cut = GOOGLE_TTS_CHUNK_CHARS;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  return parts.filter(Boolean);
}

const TTS_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize';

/** Required for user ADC so quota/billing attach to your GCP project (see adc-troubleshooting). */
function quotaProjectId() {
  return (
    process.env.GOOGLE_CLOUD_QUOTA_PROJECT?.trim() ||
    process.env.GOOGLE_TTS_QUOTA_PROJECT?.trim() ||
    ''
  );
}

/**
 * @param {string} text
 * @param {string} workDir
 * @param {{ mode: 'apikey', key: string } | { mode: 'bearer', getToken: () => Promise<string> }} auth
 */
async function googleCloudTtsToMp3(text, workDir, auth) {
  const mp3Path = join(workDir, 'voice.mp3');
  const languageCode = process.env.GOOGLE_TTS_LANGUAGE_CODE || 'en-US';
  const voiceName = process.env.GOOGLE_TTS_VOICE_NAME || 'en-US-Neural2-D';
  const speakingRate = Number(process.env.GOOGLE_TTS_SPEAKING_RATE || '1') || 1;

  const chunks = splitTextForGoogleTts(text);
  const partPaths = [];

  try {
    for (let i = 0; i < chunks.length; i++) {
      const headers = { 'Content-Type': 'application/json' };
      let url = TTS_URL;
      if (auth.mode === 'apikey') {
        url = `${TTS_URL}?key=${encodeURIComponent(auth.key)}`;
      } else {
        headers.Authorization = `Bearer ${await auth.getToken()}`;
        const qp = quotaProjectId();
        if (qp) {
          headers['x-goog-user-project'] = qp;
        }
      }

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          input: { text: chunks[i] },
          voice: { languageCode, name: voiceName },
          audioConfig: {
            audioEncoding: 'MP3',
            speakingRate,
          },
        }),
      });
      const raw = await res.text();
      if (!res.ok) {
        let msg = `Google TTS HTTP ${res.status}: ${raw.slice(0, 800)}`;
        if (
          auth.mode === 'apikey' &&
          (raw.includes('API_KEY_INVALID') || raw.includes('API key expired'))
        ) {
          msg +=
            ' Tip: Fix API key restrictions (must include Cloud Text-to-Speech API), or use GOOGLE_TTS_USE_ADC=1 after running `gcloud auth application-default login` if org policy blocks service account keys.';
        }
        if (
          res.status === 403 &&
          raw.includes('quota project') &&
          auth.mode === 'bearer'
        ) {
          msg +=
            ' Fix: set GOOGLE_CLOUD_QUOTA_PROJECT to your GCP project id (same project where TTS is enabled), or run: gcloud auth application-default set-quota-project YOUR_PROJECT_ID';
        }
        throw new Error(msg);
      }
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error('Google TTS: invalid JSON response');
      }
      if (!data.audioContent) {
        throw new Error('Google TTS: missing audioContent in response');
      }
      const partPath = join(workDir, `voice_part_${i}.mp3`);
      writeFileSync(partPath, Buffer.from(data.audioContent, 'base64'));
      partPaths.push(partPath);
    }

    if (partPaths.length === 1) {
      writeFileSync(mp3Path, readFileSync(partPaths[0]));
      unlinkSync(partPaths[0]);
      return;
    }

    const listPath = join(workDir, 'voice_concat.txt');
    const listBody = partPaths.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n');
    writeFileSync(listPath, listBody);
    await runCmd(
      ffmpegPath(),
      ['-y', '-f', 'concat', '-safe', '0', '-i', 'voice_concat.txt', '-c', 'copy', 'voice.mp3'],
      { cwd: workDir }
    );
    unlinkSync(listPath);
    for (const p of partPaths) {
      try {
        unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  } catch (e) {
    for (const p of partPaths) {
      try {
        unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
    throw e;
  }
}

/** Windows SAPI → WAV via PowerShell (no API keys). */
async function windowsSapiWav(text, outPath) {
  const escaped = text.replace(/'/g, "''");
  const ps = `
    Add-Type -AssemblyName System.Speech
    $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $s.SetOutputToWaveFile('${outPath.replace(/\\/g, '\\\\')}')
    $s.Speak('${escaped}')
    $s.Dispose()
  `.trim();
  await runCmd('powershell', ['-NoProfile', '-Command', ps]);
}

export async function synthesizeSpeech(text, workDir) {
  if (!String(text || '').trim()) {
    throw new Error('Cannot synthesize empty script');
  }
  mkdirSync(workDir, { recursive: true });
  const wavPath = join(workDir, 'voice.wav');
  const mp3Path = join(workDir, 'voice.mp3');

  const saPath = (
    process.env.GOOGLE_TTS_SERVICE_ACCOUNT_PATH ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    ''
  ).trim();
  const apiKey = (process.env.GOOGLE_TTS_API_KEY || '').trim();
  const useAdc =
    process.env.GOOGLE_TTS_USE_ADC === '1' ||
    process.env.GOOGLE_TTS_USE_APPLICATION_DEFAULT_CREDENTIALS === '1';

  async function bearerFromGoogleAuth(googleAuth, label) {
    await googleCloudTtsToMp3(text, workDir, {
      mode: 'bearer',
      getToken: async () => {
        const client = await googleAuth.getClient();
        const at = await client.getAccessToken();
        if (!at.token) {
          throw new Error(
            `Google TTS: no access token (${label}). For ADC run: gcloud auth application-default login — ensure Cloud Text-to-Speech API is enabled and your user has permission on the project.`
          );
        }
        return at.token;
      },
    });
  }

  if (saPath) {
    if (!existsSync(saPath)) {
      throw new Error(`Google TTS: service account JSON not found at path: ${saPath}`);
    }
    const googleAuth = new GoogleAuth({
      keyFile: saPath,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    await bearerFromGoogleAuth(googleAuth, 'service account file');
    return { audioPath: mp3Path, format: 'mp3' };
  }

  if (useAdc) {
    const googleAuth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    await bearerFromGoogleAuth(googleAuth, 'application default credentials');
    return { audioPath: mp3Path, format: 'mp3' };
  }

  if (apiKey) {
    await googleCloudTtsToMp3(text, workDir, { mode: 'apikey', key: apiKey });
    return { audioPath: mp3Path, format: 'mp3' };
  }

  if (process.platform === 'win32') {
    await windowsSapiWav(text, wavPath);
    await runCmd(ffmpegPath(), [
      '-y',
      '-i',
      wavPath,
      '-codec:a',
      'libmp3lame',
      '-q:a',
      '4',
      mp3Path,
    ]);
    return { audioPath: mp3Path, format: 'mp3' };
  }

  // macOS say → caf/aiff, convert
  if (process.platform === 'darwin') {
    const aiff = join(workDir, 'voice.aiff');
    await runCmd('say', ['-o', aiff, text]);
    await runCmd(ffmpegPath(), ['-y', '-i', aiff, '-codec:a', 'libmp3lame', '-q:a', '4', mp3Path]);
    return { audioPath: mp3Path, format: 'mp3' };
  }

  // Linux: espeak-ng if present
  try {
    await runCmd('espeak-ng', ['-w', wavPath, text]);
    await runCmd(ffmpegPath(), ['-y', '-i', wavPath, '-codec:a', 'libmp3lame', '-q:a', '4', mp3Path]);
    return { audioPath: mp3Path, format: 'mp3' };
  } catch {
    throw new Error(
      'No TTS available. Set GOOGLE_TTS_USE_ADC=1 and run gcloud auth application-default login, or GOOGLE_TTS_API_KEY, or GOOGLE_APPLICATION_CREDENTIALS (JSON path if your org allows keys), or install espeak-ng (Linux), or run on Windows/macOS.'
    );
  }
}
