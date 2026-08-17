import { writeFileSync, readFileSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import { GoogleAuth } from 'google-auth-library';
import { ffmpegPath } from '../ffmpegBin.js';

/** Named voices ↔ ElevenLabs voice ids */
const ELEVENLABS_VOICE_IDS = Object.freeze({
  Marcus: 'pNInz6obpgDQGcFmaJgB',
  Aria: 'EXAVITQu4vr4xnSDxMaL',
  Nova: 'oWAxZDx7w5VEj9dCyTzz',
  Echo: 'VR6AewLTigWG4xSOukaG',
  River: 'TX3LPaxmHKxFdv7VOQHJ',
  Sol: 'yoZ06aMxZJJ28mfd3POQ',
});

const ELEVENLABS_CHUNK_CHARS = 4500;

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

/** Google Cloud TTS: `input.text` max 5000 UTF-8 bytes (not code units). Stay under for JSON/safety margin. */
const GOOGLE_TTS_MAX_INPUT_UTF8_BYTES = 4800;

function utf8ByteLength(s) {
  return Buffer.byteLength(s, 'utf8');
}

/**
 * Largest n in [1, s.length] with utf8ByteLength(s.slice(0, n)) <= maxBytes.
 * @param {string} s
 * @param {number} maxBytes
 */
function maxPrefixCharLengthByUtf8(s, maxBytes) {
  let lo = 1;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (utf8ByteLength(s.slice(0, mid)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function splitTextForGoogleTts(text) {
  const t = text.trim();
  if (!t) return [];
  if (utf8ByteLength(t) <= GOOGLE_TTS_MAX_INPUT_UTF8_BYTES) return [t];
  const parts = [];
  let rest = t;
  while (rest.length > 0) {
    if (utf8ByteLength(rest) <= GOOGLE_TTS_MAX_INPUT_UTF8_BYTES) {
      parts.push(rest);
      break;
    }
    const hardLimit = maxPrefixCharLengthByUtf8(rest, GOOGLE_TTS_MAX_INPUT_UTF8_BYTES);
    const fromIdx = Math.max(0, hardLimit - 1);
    let cut = rest.lastIndexOf('\n\n', fromIdx);
    if (cut < hardLimit / 2) cut = rest.lastIndexOf('. ', fromIdx);
    if (cut < hardLimit / 2) cut = rest.lastIndexOf(' ', fromIdx);
    if (cut < hardLimit / 2) cut = hardLimit;
    const piece = rest.slice(0, cut).trim();
    if (!piece) {
      /** Extremely rare: trim emptied chunk — advance by hardLimit to avoid an infinite loop. */
      rest = rest.slice(hardLimit).trim();
      continue;
    }
    parts.push(piece);
    rest = rest.slice(cut).trim();
  }
  return parts.filter(Boolean);
}

const TTS_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize';

/**
 * Prefer ElevenLabs when ELEVENLABS_API_KEY is set; chunked + ffmpeg concat like Google path.
 */
function splitTextElevenLabs(text) {
  const t = text.trim();
  if (t.length <= ELEVENLABS_CHUNK_CHARS) return [t];
  const parts = [];
  let rest = t;
  while (rest.length > 0) {
    if (rest.length <= ELEVENLABS_CHUNK_CHARS) {
      parts.push(rest);
      break;
    }
    let cut = rest.lastIndexOf('\n\n', ELEVENLABS_CHUNK_CHARS);
    if (cut < ELEVENLABS_CHUNK_CHARS / 2) cut = rest.lastIndexOf('. ', ELEVENLABS_CHUNK_CHARS);
    if (cut < ELEVENLABS_CHUNK_CHARS / 2) cut = rest.lastIndexOf(' ', ELEVENLABS_CHUNK_CHARS);
    if (cut < ELEVENLABS_CHUNK_CHARS / 2) cut = ELEVENLABS_CHUNK_CHARS;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  return parts.filter(Boolean);
}

function resolveElevenLabsVoiceId() {
  const explicit = process.env.ELEVENLABS_VOICE_ID?.trim();
  if (explicit) return explicit;
  const name = process.env.ELEVENLABS_VOICE?.trim();
  if (name && /** @type {Record<string,string>} */ (ELEVENLABS_VOICE_IDS)[name]) {
    return /** @type {Record<string,string>} */ (ELEVENLABS_VOICE_IDS)[name];
  }
  return ELEVENLABS_VOICE_IDS.Marcus;
}

async function elevenLabsToMp3(text, workDir, apiKey) {
  const mp3Path = join(workDir, 'voice.mp3');
  const voiceId = resolveElevenLabsVoiceId();
  const modelId = process.env.ELEVENLABS_MODEL_ID?.trim() || 'eleven_multilingual_v2';
  const stability = Math.min(1, Math.max(0, Number(process.env.ELEVENLABS_STABILITY ?? '0.5')));
  const similarityBoost = Math.min(1, Math.max(0, Number(process.env.ELEVENLABS_SIMILARITY_BOOST ?? '0.75')));
  const speedRaw = Number(process.env.ELEVENLABS_SPEAKING_RATE ?? NaN);

  /** Google-style speaking rate analogue (0.25–4) — forwarded when finite */
  const useSpeed = Number.isFinite(speedRaw) ? Math.min(4, Math.max(0.25, speedRaw)) : null;

  const chunks = splitTextElevenLabs(text);
  const partPaths = [];
  const urlBase = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;

  try {
    for (let i = 0; i < chunks.length; i++) {
      const bodyObj = {
        text: chunks[i],
        model_id: modelId,
        voice_settings: {
          stability,
          similarity_boost: similarityBoost,
        },
      };
      if (useSpeed !== null) {
        /** @type {Record<string, unknown>} */ (bodyObj).speed = useSpeed;
      }

      const res = await fetch(urlBase, {
        method: 'POST',
        headers: {
          Accept: 'audio/mpeg',
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(bodyObj),
      });
      const rawBuf = Buffer.from(await res.arrayBuffer());
      if (!res.ok) {
        const msg = rawBuf.toString('utf8').slice(0, 800);
        throw new Error(`ElevenLabs HTTP ${res.status}: ${msg}`);
      }
      const partPath = join(workDir, `voice_eleven_${i}.mp3`);
      writeFileSync(partPath, rawBuf);
      partPaths.push(partPath);
    }

    if (partPaths.length === 1) {
      writeFileSync(mp3Path, readFileSync(partPaths[0]));
      unlinkSync(partPaths[0]);
      return;
    }

    const listPath = join(workDir, 'voice_concat_eleven.txt');
    const listBody = partPaths.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n');
    writeFileSync(listPath, listBody);
    await runCmd(
      ffmpegPath(),
      ['-y', '-f', 'concat', '-safe', '0', '-i', 'voice_concat_eleven.txt', '-c', 'copy', 'voice.mp3'],
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
      const chunk = chunks[i];
      if (utf8ByteLength(chunk) > GOOGLE_TTS_MAX_INPUT_UTF8_BYTES) {
        throw new Error(
          `Google TTS: chunk ${i + 1}/${chunks.length} is ${utf8ByteLength(chunk)} UTF-8 bytes (max ${GOOGLE_TTS_MAX_INPUT_UTF8_BYTES}).`
        );
      }
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
          input: { text: chunk },
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

  const elevenKey = (process.env.ELEVENLABS_API_KEY || '').trim();
  if (elevenKey) {
    await elevenLabsToMp3(text, workDir, elevenKey);
    return { audioPath: mp3Path, format: 'mp3' };
  }

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
