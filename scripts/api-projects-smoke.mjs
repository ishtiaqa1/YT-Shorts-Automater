/**
 * Smoke tests: login, create projects (script / reddit / ai / spoken), delete, verify 404.
 *
 * Usage (from repo root):
 *   SHORTS_TEST_EMAIL=user@example.com SHORTS_TEST_PASSWORD=secret npm run test:api
 *
 * Env:
 *   SHORTS_API_URL        — API base (default http://localhost:8787)
 *   SHORTS_TEST_EMAIL     — Registered user email
 *   SHORTS_TEST_PASSWORD  — Password
 *   SHORTS_SKIP_REDDIT=1  — Skip Reddit project (offline / rate limits)
 *   SHORTS_SKIP_AI=1      — Skip AI topic project (needs GEMINI_API_KEY on server)
 *   SHORTS_SKIP_SPOKEN=1  — Skip spoken upload (needs transcription on server)
 *   SHORTS_SPOKEN_FILE    — Path to audio file for spoken test (recommended for reliability)
 *   SHORTS_REQUIRE_ALL=1  — Exit 1 if any non-skipped scenario fails or optional section is skipped
 */

import 'dotenv/config';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const base = (
  process.env.SHORTS_API_URL ||
  process.env.API_URL ||
  'http://localhost:8787'
).replace(/\/$/, '');
const email = process.env.SHORTS_TEST_EMAIL?.trim();
const password = process.env.SHORTS_TEST_PASSWORD;
const requireAll = process.env.SHORTS_REQUIRE_ALL === '1';

if (!email || !password) {
  console.error('Missing SHORTS_TEST_EMAIL or SHORTS_TEST_PASSWORD.');
  process.exit(1);
}

/** ~1.2s 16 kHz mono PCM — enough signal that STT usually returns non-empty text. */
function makeSpeechLikeWav() {
  const sampleRate = 16000;
  const durationSec = 1.2;
  const numChannels = 1;
  const bitsPerSample = 16;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const numSamples = Math.floor(sampleRate * durationSec);
  const dataSize = numSamples * blockAlign;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  const f0 = 180;
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const env = Math.min(1, t * 8) * Math.min(1, (durationSec - t) * 8);
    const wobble = Math.sin(2 * Math.PI * 2.5 * t);
    const s =
      env *
      (0.55 * Math.sin(2 * Math.PI * f0 * t) +
        0.25 * Math.sin(2 * Math.PI * f0 * 1.5 * t + wobble) +
        0.12 * Math.sin(2 * Math.PI * f0 * 2.03 * t)) *
      20000;
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s))), 44 + i * 2);
  }
  return buf;
}

async function login() {
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`login failed ${r.status}: ${data.error || r.statusText}`);
  if (!data.token) throw new Error('login response missing token');
  return data.token;
}

async function apiJson(token, path, opts = {}) {
  const headers = new Headers(opts.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (opts.body && !(opts.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  const r = await fetch(`${base}${path}`, { ...opts, headers });
  const text = await r.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  return { ok: r.ok, status: r.status, data };
}

async function deleteProject(token, id, label) {
  let r = await apiJson(token, `/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!r.ok || !r.data.ok) {
    r = await apiJson(token, `/api/projects/${encodeURIComponent(id)}/delete`, { method: 'POST' });
  }
  if (!r.ok || !r.data.ok) {
    r = await apiJson(token, '/api/projects/delete', {
      method: 'POST',
      body: JSON.stringify({ project_id: id }),
    });
  }
  if (!r.ok || !r.data.ok) {
    throw new Error(`delete ${label} failed ${r.status}: ${r.data.error || JSON.stringify(r.data)}`);
  }
}

async function assertProjectGone(token, id) {
  const r = await apiJson(token, `/api/projects/${id}`);
  if (r.status !== 404) {
    throw new Error(`after delete ${id}: expected GET 404, got ${r.status}`);
  }
}

let optionalSkipped = false;

async function optionalSection(name, run) {
  if (process.env[`SHORTS_SKIP_${name}`] === '1') {
    console.warn(`SKIP ${name} (SHORTS_SKIP_${name}=1)`);
    optionalSkipped = true;
    return;
  }
  try {
    await run();
    console.log(`OK   ${name}`);
  } catch (e) {
    console.warn(`SKIP ${name}: ${e?.message || e}`);
    optionalSkipped = true;
  }
}

async function main() {
  console.log(`API smoke → ${base}\n`);

  const token = await login();
  console.log('OK   login');

  const suffix = Date.now();

  /** Script (manual): required */
  let r = await apiJson(token, '/api/projects', {
    method: 'POST',
    body: JSON.stringify({
      title: `Smoke script ${suffix}`,
      script_text: 'Line one.\nLine two for captions.',
    }),
  });
  if (!r.ok || !r.data.project?.id) {
    console.error(`FAIL script create: ${r.status} ${r.data.error || JSON.stringify(r.data)}`);
    process.exit(1);
  }
  const scriptId = r.data.project.id;
  await deleteProject(token, scriptId, 'script');
  await assertProjectGone(token, scriptId);
  console.log('OK   script (create → delete → 404)');

  await optionalSection('REDDIT', async () => {
    r = await apiJson(token, '/api/generate/reddit/subreddits', { method: 'GET' });
    if (!r.ok || !Array.isArray(r.data.subreddits) || r.data.subreddits.length < 2) {
      throw new Error(`subreddits list: ${r.status} ${JSON.stringify(r.data)}`);
    }
    r = await apiJson(token, '/api/generate/project/reddit', {
      method: 'POST',
      body: JSON.stringify({ reddit_permalink: null }),
    });
    if (!r.ok || !r.data.project?.id) {
      throw new Error(`${r.status} ${r.data.error || JSON.stringify(r.data)}`);
    }
    const id = r.data.project.id;
    if (r.data.project.source_type !== 'reddit') throw new Error('expected source_type reddit');
    await deleteProject(token, id, 'reddit');
    await assertProjectGone(token, id);
  });

  await optionalSection('AI', async () => {
    r = await apiJson(token, '/api/generate/project/ai', {
      method: 'POST',
      body: JSON.stringify({ topic: `Smoke topic ${suffix}`, title: `AI smoke ${suffix}` }),
    });
    if (!r.ok || !r.data.project?.id) {
      throw new Error(`${r.status} ${r.data.error || JSON.stringify(r.data)}`);
    }
    const id = r.data.project.id;
    await deleteProject(token, id, 'ai');
    await assertProjectGone(token, id);
  });

  await optionalSection('SPOKEN', async () => {
    const fixture = process.env.SHORTS_SPOKEN_FILE?.trim();
    const bodyBuf = fixture ? readFileSync(resolve(fixture)) : makeSpeechLikeWav();
    const filename = fixture ? fixture.split(/[/\\]/).pop() : 'smoke-synthetic.wav';

    const fd = new FormData();
    fd.append('file', new Blob([bodyBuf]), filename);
    fd.append('title', `Spoken smoke ${suffix}`);

    const res = await fetch(`${base}/api/generate/project/spoken`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: fd,
    });
    const raw = await res.text();
    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      /* */
    }
    if (!res.ok || !data.project?.id) {
      throw new Error(
        `${res.status} ${data.error || raw.slice(0, 200)} (set SHORTS_SPOKEN_FILE to a short .wav/.webm with speech)`
      );
    }
    const id = data.project.id;
    await deleteProject(token, id, 'spoken');
    await assertProjectGone(token, id);
  });

  if (requireAll && optionalSkipped) {
    console.error('\nSHORTS_REQUIRE_ALL=1 but a section was skipped — failing.');
    process.exit(1);
  }

  console.log('\nDone.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
