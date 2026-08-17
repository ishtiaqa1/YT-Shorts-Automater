import { Router } from 'express';
import multer from 'multer';
import { readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { pool } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { aiGenerateLimiter } from '../middleware/apiGuards.js';
import { pickRandomBundledAbsolutePath, sanitizeThemeId } from '../services/bundledBackgrounds.js';

const r = Router();

function parseGeminiError(status, raw) {
  const text = String(raw || '');
  let message = text;
  try {
    const parsed = JSON.parse(text);
    message = String(parsed?.error?.message || message);
  } catch {
    // Keep raw text fallback.
  }
  const normalized = message.toLowerCase();
  const depleted =
    status === 429 &&
    (normalized.includes('prepayment credits are depleted') ||
      normalized.includes('resource_exhausted') ||
      normalized.includes('quota'));
  if (depleted) {
    return {
      isQuota: true,
      message:
        'Gemini credits are depleted for this API key/project. Top up billing in AI Studio or use a different key.',
    };
  }
  return { isQuota: false, message };
}

const spokenUpload = multer({
  storage: multer.diskStorage({
    destination: (req, _, cb) => {
      const dir = join(process.cwd(), 'uploads', req.user.sub, 'voice');
      mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const orig = String(file.originalname || '').toLowerCase();
      const ext =
        orig.endsWith('.webm')
          ? '.webm'
          : orig.endsWith('.mp3')
            ? '.mp3'
            : orig.endsWith('.wav')
              ? '.wav'
              : orig.endsWith('.m4a')
                ? '.m4a'
                : orig.endsWith('.ogg')
                  ? '.ogg'
                  : orig.endsWith('.mp4')
                    ? '.mp4'
                    : '.webm';
      cb(null, `spoken_${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
});

async function generateAiScript(prompt) {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) {
    throw new Error('GEMINI_API_KEY not configured');
  }
  const cleanPrompt = String(prompt || '').trim();
  if (!cleanPrompt) {
    throw new Error('prompt required');
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(key)}`;
  const r2 = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            {
              text: `Write a concise YouTube Short script (spoken style, under 90 seconds). Topic:\n${cleanPrompt}`,
            },
          ],
        },
      ],
    }),
  });
  const raw = await r2.text();
  if (!r2.ok) {
    const parsed = parseGeminiError(r2.status, raw);
    if (parsed.isQuota) {
      const e = new Error(parsed.message);
      e.statusCode = 429;
      throw e;
    }
    throw new Error(`Gemini ${r2.status}: ${parsed.message.slice(0, 400)}`);
  }
  const data = JSON.parse(raw);
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
  return String(text).trim();
}

function mimeForSpokenFile(originalname, mimetype) {
  const m = String(mimetype || '').toLowerCase();
  if (m.startsWith('audio/') || m.startsWith('video/')) return m || 'audio/webm';
  const lower = String(originalname || '').toLowerCase();
  if (lower.endsWith('.webm')) return 'audio/webm';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.m4a')) return 'audio/mp4';
  if (lower.endsWith('.ogg')) return 'audio/ogg';
  if (lower.endsWith('.mp4')) return 'audio/mp4';
  return 'audio/webm';
}

/** @param {Buffer} buf */
async function transcribeWithOpenAiWhisper(buf, filename, mimeType) {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new Error('OPENAI_API_KEY not configured');
  const form = new FormData();
  const blob = new Blob([buf], { type: mimeType });
  form.append('file', blob, filename || 'recording.webm');
  form.append('model', process.env.OPENAI_WHISPER_MODEL?.trim() || 'whisper-1');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Whisper HTTP ${res.status}: ${raw.slice(0, 500)}`);
  const data = JSON.parse(raw);
  const text = data?.text;
  if (!text || typeof text !== 'string') throw new Error('Whisper: no transcription text');
  return text.trim();
}

/** @param {Buffer} buf */
async function transcribeWithGemini(buf, mimeType) {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new Error('GEMINI_API_KEY not configured');
  const allowed =
    mimeType.includes('mpeg') ||
    mimeType.includes('wav') ||
    mimeType.includes('webm') ||
    mimeType.includes('ogg') ||
    mimeType.includes('mp4') ||
    mimeType.includes('x-m4a') ||
    mimeType.includes('m4a');
  if (!allowed) {
    throw new Error(`Unsupported audio MIME for Gemini (${mimeType}). Try .webm / .mp3 / .wav.`);
  }
  const b64 = buf.toString('base64');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            {
              text:
                'Transcribe this audio verbatim for captions on a YouTube Short.\nRules:\n- Output ONLY the spoken words.\n- No timestamps, bullets, markdown, speaker labels.',
            },
            { inline_data: { mime_type: mimeType, data: b64 } },
          ],
        },
      ],
    }),
  });
  const raw = await res.text();
  if (!res.ok) {
    const parsed = parseGeminiError(res.status, raw);
    if (parsed.isQuota) {
      const e = new Error(parsed.message);
      e.statusCode = 429;
      throw e;
    }
    throw new Error(`Gemini transcribe HTTP ${res.status}: ${parsed.message.slice(0, 400)}`);
  }
  const data = JSON.parse(raw);
  const text =
    data?.candidates?.[0]?.content?.parts?.map((/** @type {{ text?: string }} */ p) => p.text).join('') || '';
  const out = String(text).trim();
  if (!out) throw new Error('Gemini returned empty transcription');
  return out;
}

/**
 * Prefer OpenAI Whisper when configured (best quality); else Gemini audio.
 */
async function transcribeSpokenUpload(buf, originalname, mimetype) {
  const mimeType = mimeForSpokenFile(originalname, mimetype);
  try {
    if (process.env.OPENAI_API_KEY?.trim()) {
      return await transcribeWithOpenAiWhisper(buf, originalname || 'recording.webm', mimeType);
    }
  } catch (e) {
    if (!process.env.GEMINI_API_KEY?.trim()) throw e;
    console.warn('[spoken] Whisper failed, trying Gemini:', e.message || e);
  }
  if (process.env.GEMINI_API_KEY?.trim()) {
    return await transcribeWithGemini(buf, mimeType);
  }
  throw new Error(
    'Configure OPENAI_API_KEY (Whisper) or GEMINI_API_KEY (audio transcription) on the API server.'
  );
}

function titleFromTranscript(scriptText, optionalTitle) {
  const t = String(optionalTitle || '').trim();
  if (t) return t.slice(0, 200);
  const line =
    scriptText.split('\n')[0]?.trim() ||
    scriptText.split(/[.!?]/)[0]?.trim() ||
    scriptText.slice(0, 80).trim();
  const cleaned = line.replace(/\s+/g, ' ').trim().slice(0, 180);
  return cleaned.length > 8 ? cleaned : `Voice short ${new Date().toISOString().slice(0, 10)}`;
}

r.post('/ai', aiGenerateLimiter, authRequired, async (req, res) => {
  const prompt = String(req.body?.prompt || '').trim();
  if (!prompt) {
    res.status(400).json({ error: 'prompt required' });
    return;
  }
  try {
    const scriptText = await generateAiScript(prompt);
    res.json({ script_text: scriptText });
  } catch (e) {
    res.status(e?.statusCode || 500).json({ error: String(e.message || e) });
  }
});

function cleanStoryText(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeRedditPermalink(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  const noQuery = raw.split('?')[0].replace(/\/+$/, '');
  return noQuery.toLowerCase();
}

/**
 * Weekly top posts — long selftext only (filtered below). Shuffled per request so picks aren’t always AITA-first.
 * Uses the public RSS feeds: Reddit now returns HTTP 403 for anonymous `.json`, but `.rss` still works.
 */
const REDDIT_AUTO_STORY_FEEDS = [
  'https://www.reddit.com/r/nosleep/top.rss?limit=25&t=week',
  'https://www.reddit.com/r/LetsNotMeet/top.rss?limit=25&t=week',
  'https://www.reddit.com/r/tifu/top.rss?limit=25&t=week',
  'https://www.reddit.com/r/MaliciousCompliance/top.rss?limit=25&t=week',
  'https://www.reddit.com/r/pettyrevenge/top.rss?limit=25&t=week',
  'https://www.reddit.com/r/ProRevenge/top.rss?limit=25&t=week',
  'https://www.reddit.com/r/talesfromtechsupport/top.rss?limit=25&t=week',
  'https://www.reddit.com/r/talesfromretail/top.rss?limit=25&t=week',
  'https://www.reddit.com/r/offmychest/top.rss?limit=25&t=week',
  'https://www.reddit.com/r/TrueOffMyChest/top.rss?limit=25&t=week',
  'https://www.reddit.com/r/confession/top.rss?limit=25&t=week',
  'https://www.reddit.com/r/AmItheAsshole/top.rss?limit=25&t=week',
];

/**
 * Reddit serves its block page (HTTP 403) for anonymous `.json` requests with non-browser agents,
 * but the public `.rss` feeds respond normally to a browser-like User-Agent — and RSS entries
 * include the full post title, permalink, and selftext, which is all the auto-picker needs.
 */
const REDDIT_FETCH_USER_AGENT =
  (process.env.REDDIT_USER_AGENT || '').trim() ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function fetchRedditRss(url) {
  return fetch(url, {
    headers: { 'User-Agent': REDDIT_FETCH_USER_AGENT, Accept: 'application/rss+xml, application/xml, text/xml' },
  });
}

/** Turn an Atom `<content>`/`<title>` payload (HTML-encoded markdown) into plain text. */
function decodeRedditHtml(value) {
  return String(value || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Parse Reddit's Atom feed into `{ title, body, link }` entries. */
function parseRedditRssEntries(xml) {
  const out = [];
  const chunks = String(xml || '').split('<entry>').slice(1);
  for (const chunk of chunks) {
    const end = chunk.indexOf('</entry>');
    const entry = end === -1 ? chunk : chunk.slice(0, end);
    const grab = (re) => (entry.match(re) || [])[1] || '';
    out.push({
      title: decodeRedditHtml(grab(/<title>([\s\S]*?)<\/title>/)),
      body: decodeRedditHtml(grab(/<content[^>]*>([\s\S]*?)<\/content>/)),
      link: grab(/<link[^>]*href="([^"]+)"/),
    });
  }
  return out;
}

/** Preset subs backing {@link REDDIT_AUTO_STORY_FEEDS} — for UI + optional auto-pick filter. */
function listPresetRedditSubreddits() {
  const seen = new Set();
  const out = [];
  for (const feed of REDDIT_AUTO_STORY_FEEDS) {
    const m = feed.match(/\/r\/([^/?#]+)/i);
    if (!m) continue;
    const name = m[1];
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, label: `r/${name}` });
  }
  return out;
}

/** @param {unknown} raw from JSON body — must be a plain sub name (no URL). */
function normalizeRedditSubredditFilter(raw) {
  const s = String(raw ?? '')
    .trim()
    .replace(/^r\//i, '');
  if (!s) return null;
  if (!/^[A-Za-z0-9_]{2,21}$/.test(s)) return null;
  return s;
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function fetchUsedRedditPermalinksByUser(userId) {
  const { rows } = await pool.query(
    `SELECT reddit_permalink
     FROM projects
     WHERE user_id = $1
       AND source_type = 'reddit'
       AND reddit_permalink IS NOT NULL`,
    [userId]
  );
  return new Set(rows.map((r) => normalizeRedditPermalink(r.reddit_permalink)).filter(Boolean));
}

async function fetchRedditStory(optionalPermalink, userId, subredditFilter) {
  if (optionalPermalink) {
    const raw = String(optionalPermalink).trim();
    const noQuery = raw.split('?')[0].replace(/\/+$/, '');
    const rssUrl = noQuery.endsWith('.rss') ? noQuery : `${noQuery}/.rss`;
    const r2 = await fetchRedditRss(rssUrl);
    if (!r2.ok) throw new Error(`Reddit fetch failed (HTTP ${r2.status}). Try again in a minute.`);
    const [post] = parseRedditRssEntries(await r2.text());
    if (!post) throw new Error('Could not parse Reddit post');
    const body = cleanStoryText(post.body);
    if (!body) throw new Error('Reddit post has no usable story text (link posts have no text to narrate).');
    return {
      title: cleanStoryText(post.title || 'Reddit story'),
      body,
      permalink: post.link || raw,
    };
  }

  const subOnly = normalizeRedditSubredditFilter(subredditFilter);
  const fallbackFeeds = subOnly
    ? [`https://www.reddit.com/r/${subOnly}/top.rss?limit=25&t=week`]
    : shuffleInPlace([...REDDIT_AUTO_STORY_FEEDS]);
  const usedPermalinks = await fetchUsedRedditPermalinksByUser(userId);
  /** @type {{ title: string, body: string, permalink: string | null }[]} */
  const candidates = [];
  let okFeeds = 0;
  let lastBlockedStatus = null;
  for (const feed of fallbackFeeds) {
    const r2 = await fetchRedditRss(feed);
    if (!r2.ok) {
      lastBlockedStatus = r2.status;
      continue;
    }
    okFeeds += 1;
    for (const entry of parseRedditRssEntries(await r2.text())) {
      const body = cleanStoryText(entry.body);
      /** RSS has no NSFW/stickied flag — the length gate drops link posts and one-liners. */
      if (body.length <= 500) continue;
      const permalink = entry.link || null;
      const normalized = normalizeRedditPermalink(permalink);
      if (normalized && usedPermalinks.has(normalized)) continue;
      candidates.push({
        title: cleanStoryText(entry.title || 'Reddit story'),
        body,
        permalink,
      });
    }
  }
  if (candidates.length) {
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    if (pick.permalink) {
      usedPermalinks.add(normalizeRedditPermalink(pick.permalink));
    }
    return pick;
  }
  if (okFeeds === 0) {
    throw new Error(
      `Reddit blocked the request (HTTP ${lastBlockedStatus ?? 'error'}). This is usually temporary rate-limiting — wait a minute and try again.`
    );
  }
  const hint = subOnly
    ? `Could not auto-select a new long text post from r/${subOnly} (try another subreddit, paste a post URL, or try again later).`
    : 'Could not auto-select a new Reddit story right now (all recent picks may already be used).';
  throw new Error(hint);
}

r.get('/reddit/subreddits', authRequired, (_req, res) => {
  res.json({ subreddits: listPresetRedditSubreddits() });
});

r.post('/project/reddit', authRequired, async (req, res) => {
  try {
    const permalink = req.body?.reddit_permalink;
    const subPick = permalink ? null : req.body?.reddit_subreddit;
    const story = await fetchRedditStory(permalink, req.user.sub, subPick);
    const title = String(story.title || 'Reddit story').slice(0, 200);
    const scriptText = cleanStoryText(story.body).slice(0, 12000);
    const { rows } = await pool.query(
      `INSERT INTO projects (user_id, title, script_text, source_type, reddit_permalink)
       VALUES ($1, $2, $3, 'reddit', $4)
       RETURNING *`,
      [req.user.sub, title, scriptText, story.permalink]
    );
    res.json({ project: rows[0], story: { title: story.title, permalink: story.permalink } });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

r.post('/project/ai', aiGenerateLimiter, authRequired, async (req, res) => {
  try {
    const topic = String(req.body?.topic || req.body?.prompt || '').trim();
    if (!topic) {
      res.status(400).json({ error: 'topic required' });
      return;
    }
    const scriptText = await generateAiScript(topic);
    const title = String(req.body?.title || topic).slice(0, 200);
    const { rows } = await pool.query(
      `INSERT INTO projects (user_id, title, script_text, source_type)
       VALUES ($1, $2, $3, 'ai')
       RETURNING *`,
      [req.user.sub, title, scriptText]
    );
    res.json({ project: rows[0] });
  } catch (e) {
    res.status(e?.statusCode || 500).json({ error: String(e.message || e) });
  }
});

r.post('/project/spoken', authRequired, aiGenerateLimiter, spokenUpload.single('file'), async (req, res) => {
  if (!req.file?.path) {
    res.status(400).json({ error: 'file required (record or upload speech audio)' });
    return;
  }
  const absPath = req.file.path;
  try {
    const buf = readFileSync(absPath);
    const scriptRaw = await transcribeSpokenUpload(buf, req.file.originalname, req.file.mimetype);
    const scriptText = cleanStoryText(scriptRaw).slice(0, 12000);
    if (!scriptText) {
      res.status(400).json({ error: 'Transcription empty — speak closer to the mic or try another format (.webm, .mp3).' });
      return;
    }

    const title = titleFromTranscript(scriptText, req.body?.title);
    const theme = sanitizeThemeId(req.body?.background_theme ?? req.body?.bg_theme);
    const bgPath = pickRandomBundledAbsolutePath(theme);

    const insert = bgPath
      ? await pool.query(
          `INSERT INTO projects (user_id, title, script_text, source_type,
              voice_source, voice_asset_path, background_asset_path, background_theme)
           VALUES ($1, $2, $3, 'spoken', 'uploaded', $4, $5, $6)
           RETURNING *`,
          [req.user.sub, title, scriptText, absPath, bgPath, theme]
        )
      : await pool.query(
          `INSERT INTO projects (user_id, title, script_text, source_type, voice_source,
              voice_asset_path, background_theme)
           VALUES ($1, $2, $3, 'spoken', 'uploaded', $4, $5)
           RETURNING *`,
          [req.user.sub, title, scriptText, absPath, theme]
        );

    res.json({
      project: insert.rows[0],
      transcription_preview: `${scriptText.slice(0, 240)}${scriptText.length > 240 ? '…' : ''}`,
      background_applied: Boolean(bgPath),
      hint_bg: bgPath
        ? null
        : 'Add bundled clips under assets/gameplay or assets/background_themes/{calm,hype}, or choose a preset in the editor.',
    });
  } catch (e) {
    res.status(e?.statusCode || 502).json({ error: String(e.message || e) });
  }
});

r.post('/reddit/format', authRequired, async (req, res) => {
  const b = req.body || {};
  const title = String(b.title || 'Reddit story').slice(0, 200);
  const script_text = String(b.body || b.script_text || '').trim();
  const reddit_permalink = b.reddit_permalink != null ? String(b.reddit_permalink).slice(0, 2000) : null;
  if (!script_text) {
    res.status(400).json({ error: 'body or script_text required' });
    return;
  }
  const { rows } = await pool.query(
    `INSERT INTO projects (user_id, title, script_text, source_type, reddit_permalink)
     VALUES ($1, $2, $3, 'reddit', $4)
     RETURNING *`,
    [req.user.sub, title, script_text, reddit_permalink]
  );
  res.json({ project: rows[0] });
});

export default r;
