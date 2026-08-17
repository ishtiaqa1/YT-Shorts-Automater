import { Router } from 'express';
import multer from 'multer';
import { basename, dirname, join, resolve, sep } from 'path';
import { platform } from 'node:os';
import { mkdirSync, existsSync, readdirSync, statSync } from 'fs';
import { unlink } from 'fs/promises';
import { pool } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { enqueueRender, maybeReconcileStaleRenderingProjects } from '../services/jobQueue.js';
import { normalizeCaptionSettings } from '../captionDefaults.js';
import {
  BACKGROUND_THEME_ORDER,
  DEFAULT_BACKGROUND_THEME_ID,
  sanitizeThemeId,
  listVideoBasenames,
  isBundledAssetPath,
  bundledVideoBelongsToTheme,
} from '../services/bundledBackgrounds.js';
import { enforceRenderDailyCap, renderLimiterFactory, suspiciousActivityWatcher } from '../middleware/apiGuards.js';
import { extractVideoThumbnailJpg, thumbnailSeekSecondsForProject } from '../services/thumbnail.js';
import { generateTitleThumbnailPng } from '../services/thumbnailGen.js';
import { clipYoutubeVideoTitle, youtubeShortsMultipartTitle } from '../services/youtubeUpload.js';
import {
  buildShortSizedSegments,
  SHORTS_MULTI_PART_GAP_MS,
} from '../services/splitVideoForShorts.js';
import { applySplitPartBookendTts } from '../services/splitPartBookends.js';
import {
  countActiveUploadQueueForProject,
  sameOutputRevisionAlreadyQueued,
} from '../services/uploadScheduleGuards.js';
import { getUserTimezone } from '../timezone.js';
import {
  getDailyUploadCap,
  countScheduledVideosByLocalDay,
  localDayKey,
} from '../services/uploadDailyCap.js';

const r = Router();
r.use(authRequired);
r.use(suspiciousActivityWatcher);

const MUSIC_DIR = join(process.cwd(), 'assets', 'music');
/** User-uploaded burns — FFmpeg accepts these container types. */
const USER_BG_VIDEO = /\.(mp4|webm|mov|m4v|mkv)$/i;
const MUSIC_EXT = /\.(mp3|m4a|aac|wav)$/i;
const VOICE_EXT = /\.(mp3|m4a|aac|wav|ogg|webm)$/i;

function isSafeMusicFilename(name) {
  if (!name || name !== basename(name) || name.includes('..')) return false;
  return /^[a-zA-Z0-9._-]+$/.test(name);
}

function listMusicTracks() {
  mkdirSync(MUSIC_DIR, { recursive: true });
  try {
    return readdirSync(MUSIC_DIR)
      .filter((n) => isSafeMusicFilename(n) && MUSIC_EXT.test(n))
      .filter((n) => {
        try {
          return statSync(join(MUSIC_DIR, n)).isFile();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

function pathOwnedByUser(absPath, userSub) {
  if (!absPath || typeof absPath !== 'string') return false;
  let p;
  try {
    p = resolve(absPath);
  } catch {
    return false;
  }
  const up = resolve(process.cwd(), 'uploads', userSub);
  const gen = resolve(process.cwd(), 'generated', userSub);
  /** Windows paths can differ only by drive letter casing — breaks `startsWith`. */
  const norm = platform() === 'win32' ? (s) => s.toLowerCase() : (s) => s;
  const np = norm(p);
  const nUp = norm(up);
  const nGen = norm(gen);
  const nSep = norm(sep);
  return (
    np === nUp ||
    np.startsWith(`${nUp}${nSep}`) ||
    np === nGen ||
    np.startsWith(`${nGen}${nSep}`)
  );
}

async function unlinkIfOwned(absPath, userSub) {
  if (!pathOwnedByUser(absPath, userSub)) return;
  await unlink(resolve(absPath)).catch(() => {});
}

/** Remove split Shorts segment files next to `short.mp4` (re-render / failed schedule cleanup). */
async function unlinkShortSplitPartsInDir(workDir, userSub) {
  if (!workDir || !existsSync(workDir)) return;
  for (const name of readdirSync(workDir)) {
    if (!/^short_part\d+\.mp4$/i.test(name)) continue;
    const abs = join(workDir, name);
    await unlinkIfOwned(abs, userSub);
  }
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = join(process.cwd(), 'uploads', req.user.sub);
      mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `${Date.now()}_${safe}`);
    },
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
});

const bgUpload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = join(process.cwd(), 'uploads', req.user.sub, 'user_bg');
      mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const safe = String(file.originalname || 'clip').replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `${Date.now()}_${safe}`);
    },
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
});

const musicUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      mkdirSync(MUSIC_DIR, { recursive: true });
      cb(null, MUSIC_DIR);
    },
    filename: (req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `${req.user.sub}_${Date.now()}_${safe}`);
    },
  }),
  limits: { fileSize: 80 * 1024 * 1024 },
});

const voiceUpload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = join(process.cwd(), 'uploads', req.user.sub, 'voice');
      mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `${Date.now()}_${safe}`);
    },
  }),
  limits: { fileSize: 120 * 1024 * 1024 },
});

/** @param {unknown} rawId */
async function deleteProjectById(req, res, rawId) {
  const id = String(rawId ?? '').trim();
  if (!id) {
    res.status(400).json({ error: 'project id required' });
    return;
  }
  const userSub = req.user.sub;

  try {
    const { rows } = await pool.query(
      `SELECT voice_asset_path, background_asset_path, output_video_path, thumbnail_path
       FROM projects WHERE id = $1 AND user_id = $2`,
      [id, userSub]
    );
    const row = rows[0];
    if (!row) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    await unlinkIfOwned(row.voice_asset_path, userSub);
    await unlinkIfOwned(row.background_asset_path, userSub);
    await unlinkIfOwned(row.output_video_path, userSub);
    await unlinkIfOwned(row.thumbnail_path, userSub);
    if (row.output_video_path) {
      await unlinkShortSplitPartsInDir(dirname(String(row.output_video_path)), userSub);
    }

    const del = await pool.query(`DELETE FROM projects WHERE id = $1 AND user_id = $2 RETURNING id`, [id, userSub]);
    if (!del.rows[0]) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    res.json({ ok: true, id: del.rows[0].id });
  } catch (e) {
    console.error('[projects delete]', e);
    res.status(500).json({ error: 'Could not delete project', detail: String(e?.message || e) });
  }
}

r.get('/', async (req, res) => {
  await maybeReconcileStaleRenderingProjects();
  const { rows } = await pool.query(
    `SELECT id, title, script_text, status, duration_seconds, error_message,
            thumbnail_path, source_type, music_track, music_volume,
            youtube_connection_id, created_at, updated_at
     FROM projects WHERE user_id = $1 ORDER BY updated_at DESC`,
    [req.user.sub]
  );
  res.json({ projects: rows });
});

r.post('/', async (req, res) => {
  const { title, script_text } = req.body || {};
  if (!title || !script_text) {
    res.status(400).json({ error: 'title and script_text required' });
    return;
  }
  const { rows } = await pool.query(
    `INSERT INTO projects (user_id, title, script_text) VALUES ($1, $2, $3)
     RETURNING *`,
    [req.user.sub, String(title).slice(0, 200), String(script_text)]
  );
  const proj = rows[0];
  await pool.query(
    `INSERT INTO upload_diagnostics (scheduled_upload_id, user_id, metric, value_json)
     VALUES (NULL, $1, 'project_created', $2::jsonb)`,
    [req.user.sub, JSON.stringify({ projectId: proj.id, title: proj.title })]
  );
  res.json({ project: proj });
});

r.get('/background-meta', (_req, res) => {
  const themes = BACKGROUND_THEME_ORDER.map(({ id, label }) => ({
    id,
    label,
    clip_count: listVideoBasenames(id).length,
  }));
  res.json({ themes, default_theme: DEFAULT_BACKGROUND_THEME_ID });
});

/** Clip names are not exposed; clients pick a theme only and the server randomizes per render. */
r.get('/background-presets', (req, res) => {
  const theme = sanitizeThemeId(req.query?.theme ?? 'gameplay');
  res.json({ theme, clip_count: listVideoBasenames(theme).length });
});

r.get('/music-tracks', (_req, res) => {
  res.json({ tracks: listMusicTracks() });
});

r.post('/music-upload', musicUpload.single('file'), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'file required' });
    return;
  }
  const name = req.file.filename;
  if (!isSafeMusicFilename(name) || !MUSIC_EXT.test(name)) {
    res.status(400).json({ error: 'Allowed audio: .mp3 .m4a .aac .wav' });
    return;
  }
  res.json({ ok: true, track: name });
});

/** Must precede handlers like `GET /:id` so `meta` is not treated as an id. */
r.get('/meta/quota', (_req, res) => {
  res.json({
    renders_per_week_cap: Number(process.env.FREE_RENDERS_PER_WEEK_CAP || '999'),
    hint: 'Per-plan quotas are enforced in middleware when enabled.',
  });
});

/**
 * Body: { project_id } or { id } — must precede `POST /:id/...` so `delete` is never parsed as a project uuid.
 * Also avoids proxies/WAFs that mishandle `.../delete` path segments.
 */
r.post('/delete', async (req, res) => {
  const body = req.body || {};
  const pid = body.project_id ?? body.id;
  await deleteProjectById(req, res, pid);
});

function bgUploadMw(req, res, next) {
  bgUpload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (typeof err.code === 'string' && err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: 'Background file too large (max 200 MB).' });
      return;
    }
    if (typeof err.code === 'string' && err.message) {
      res.status(400).json({ error: `Upload rejected: ${err.message}` });
      return;
    }
    console.error('[background upload]', err);
    res.status(500).json({ error: 'Upload failed', detail: String(err?.message || err) });
  });
}

r.post('/:id/background', bgUploadMw, async (req, res) => {
  const { id } = req.params;
  if (!req.file?.path) {
    res.status(400).json({
      error: 'No video file received. Use the form field named "file" (.mp4, .webm, .mov, …).',
    });
    return;
  }
  const lower = String(req.file.filename || req.file.originalname || '').toLowerCase();
  if (!USER_BG_VIDEO.test(lower)) {
    await unlink(req.file.path).catch(() => {});
    res.status(400).json({
      error: 'Unsupported format. Use .mp4, .webm, .mov, .m4v, or .mkv (FFmpeg must be able to read it).',
    });
    return;
  }
  const userSub = req.user.sub;

  try {
    const { rows: pr } = await pool.query(`SELECT background_asset_path FROM projects WHERE id = $1 AND user_id = $2`, [
      id,
      userSub,
    ]);
    if (!pr[0]) {
      await unlink(req.file.path).catch(() => {});
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    await unlinkIfOwned(pr[0].background_asset_path, userSub);

    const { rows } = await pool.query(
      `UPDATE projects SET background_asset_path = $2, updated_at = NOW()
       WHERE id = $1 AND user_id = $3 RETURNING id, background_asset_path, background_theme`,
      [id, req.file.path, userSub]
    );
    res.json({
      project: rows[0],
      hint:
        'This file is used only as a temporary burn-in background; it will be deleted after the next successful render.',
    });
  } catch (e) {
    await unlink(req.file.path).catch(() => {});
    console.error('[background upload]', e);
    res.status(500).json({ error: 'Upload failed', detail: String(e?.message || e) });
  }
});

r.post('/:id/voice', voiceUpload.single('file'), async (req, res) => {
  const { id } = req.params;
  if (!req.file) {
    res.status(400).json({ error: 'file required' });
    return;
  }
  const lowered = String(req.file.filename || '').toLowerCase();
  const original = String(req.file.originalname || '').toLowerCase();
  if (!VOICE_EXT.test(lowered) && !VOICE_EXT.test(original)) {
    res.status(400).json({ error: 'Allowed voice files: .mp3 .m4a .aac .wav .ogg .webm' });
    return;
  }
  const { rows } = await pool.query(
    `UPDATE projects SET voice_asset_path = $2, voice_source = 'uploaded', updated_at = NOW()
     WHERE id = $1 AND user_id = $3 RETURNING id, voice_source, voice_asset_path`,
    [id, req.file.path, req.user.sub]
  );
  if (!rows[0]) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  res.json({ project: rows[0] });
});

r.post('/:id/background-preset', (_req, res) => {
  res.status(410).json({
    error:
      'Choosing a specific bundled file is disabled. Pick a theme pack for a random library clip on each render, or upload your own background in the editor.',
  });
});

r.post('/:id/render', renderLimiterFactory, enforceRenderDailyCap, async (req, res) => {
  const { id } = req.params;
  const { rows } = await pool.query(`SELECT id FROM projects WHERE id = $1 AND user_id = $2`, [id, req.user.sub]);
  if (!rows[0]) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  enqueueRender(id);
  res.json({ ok: true, message: 'Render queued. Poll project status.' });
});

r.get('/:id/file', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT output_video_path, status FROM projects WHERE id = $1 AND user_id = $2`,
    [req.params.id, req.user.sub]
  );
  const p = rows[0];
  if (!p?.output_video_path || !existsSync(p.output_video_path)) {
    res.status(404).json({ error: 'No rendered file yet' });
    return;
  }
  res.setHeader('Content-Type', 'video/mp4');
  res.sendFile(p.output_video_path);
});

r.delete('/:id', (req, res) => deleteProjectById(req, res, req.params.id));
/** POST fallback when proxies/firewalls strip DELETE */
r.post('/:id/delete', (req, res) => deleteProjectById(req, res, req.params.id));

r.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const body = req.body || {};
  const { caption_settings, script_text, title, caption_style } = body;
  const hasCaption =
    caption_settings !== undefined && caption_settings !== null && typeof caption_settings === 'object';
  const hasCaptionStyle =
    caption_style !== undefined && caption_style !== null && typeof caption_style === 'string';
  const hasScript = typeof script_text === 'string';
  const hasTitle = typeof title === 'string';
  const hasCaptionTextKey = Object.prototype.hasOwnProperty.call(body, 'caption_text');
  const hasReddit = Object.prototype.hasOwnProperty.call(body, 'reddit_permalink');
  const hasSource = Object.prototype.hasOwnProperty.call(body, 'source_type');
  const hasMusicTrack = Object.prototype.hasOwnProperty.call(body, 'music_track');
  const hasMusicVol = Object.prototype.hasOwnProperty.call(body, 'music_volume');
  const hasYtProj = Object.prototype.hasOwnProperty.call(body, 'youtube_connection_id');
  const hasTiktokProj = Object.prototype.hasOwnProperty.call(body, 'tiktok_connection_id');
  const hasUploadDestYoutube = Object.prototype.hasOwnProperty.call(body, 'upload_dest_youtube');
  const hasUploadDestTiktok = Object.prototype.hasOwnProperty.call(body, 'upload_dest_tiktok');
  const hasVoiceSource = Object.prototype.hasOwnProperty.call(body, 'voice_source');
  const hasBackgroundAssetPath = Object.prototype.hasOwnProperty.call(body, 'background_asset_path');
  const hasBackgroundTheme = Object.prototype.hasOwnProperty.call(body, 'background_theme');
  const hasBurnCaptions = Object.prototype.hasOwnProperty.call(body, 'burn_captions');

  if (
    !hasCaption &&
    !hasScript &&
    !hasTitle &&
    !hasCaptionTextKey &&
    !hasCaptionStyle &&
    !hasReddit &&
    !hasSource &&
    !hasMusicTrack &&
    !hasMusicVol &&
    !hasYtProj &&
    !hasTiktokProj &&
    !hasUploadDestYoutube &&
    !hasUploadDestTiktok &&
    !hasVoiceSource &&
    !hasBackgroundAssetPath &&
    !hasBackgroundTheme &&
    !hasBurnCaptions
  ) {
    res.status(400).json({
      error:
        'Provide caption_settings, script_text, title, caption_style, caption_text, reddit_permalink, source_type, music_track, music_volume, youtube_connection_id, tiktok_connection_id, upload_dest_youtube, upload_dest_tiktok, voice_source, background_asset_path (null clear), background_theme, and/or burn_captions',
    });
    return;
  }

  const { rows: existing } = await pool.query(
    `SELECT caption_settings, script_text, title, background_asset_path,
            upload_dest_youtube, upload_dest_tiktok
     FROM projects WHERE id = $1 AND user_id = $2`,
    [id, req.user.sub]
  );
  if (!existing[0]) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  const updates = [];
  const params = [];
  let n = 1;

  if (hasTitle) {
    updates.push(`title = $${n++}`);
    params.push(String(title).slice(0, 200));
  }
  if (hasScript) {
    updates.push(`script_text = $${n++}`);
    params.push(String(script_text));
    updates.push(`status = 'draft'`);
  }
  if (hasCaption) {
    const merged = {
      ...(existing[0].caption_settings && typeof existing[0].caption_settings === 'object'
        ? existing[0].caption_settings
        : {}),
      ...caption_settings,
    };
    const normalized = normalizeCaptionSettings(merged);
    updates.push(`caption_settings = $${n++}::jsonb`);
    params.push(JSON.stringify(normalized));
  }

  if (hasCaptionStyle) {
    updates.push(`caption_style = $${n++}`);
    params.push(String(caption_style).slice(0, 64));
  }

  if (hasBackgroundAssetPath) {
    if (body.background_asset_path !== null) {
      res.status(400).json({
        error:
          'background_asset_path may only be set to null (clear). Use a background upload or rely on the theme pack (random clip per render).',
      });
      return;
    }
    const prevBg = existing[0].background_asset_path;
    await unlinkIfOwned(prevBg, req.user.sub);
    updates.push(`background_asset_path = $${n++}`);
    params.push(null);
  }

  if (hasBackgroundTheme) {
    if (typeof body.background_theme !== 'string' || !body.background_theme.trim()) {
      res.status(400).json({ error: 'background_theme must be a short id string' });
      return;
    }
    const nextTheme = sanitizeThemeId(body.background_theme);
    updates.push(`background_theme = $${n++}`);
    params.push(nextTheme);
    const prevBg = existing[0].background_asset_path;
    if (
      !hasBackgroundAssetPath &&
      typeof prevBg === 'string' &&
      prevBg.trim() &&
      existsSync(resolve(prevBg)) &&
      isBundledAssetPath(prevBg) &&
      !bundledVideoBelongsToTheme(nextTheme, prevBg)
    ) {
      updates.push(`background_asset_path = $${n++}`);
      params.push(null);
    }
  }

  if (hasCaptionTextKey) {
    if (body.caption_text === null) {
      updates.push(`caption_text = $${n++}`);
      params.push(null);
    } else if (typeof body.caption_text === 'string') {
      updates.push(`caption_text = $${n++}`);
      params.push(body.caption_text);
    } else {
      res.status(400).json({ error: 'caption_text must be a string or null' });
      return;
    }
  }

  if (hasReddit) {
    updates.push(`reddit_permalink = $${n++}`);
    params.push(body.reddit_permalink == null ? null : String(body.reddit_permalink).slice(0, 2000));
  }

  if (hasSource && body.source_type != null) {
    updates.push(`source_type = $${n++}`);
    params.push(String(body.source_type).slice(0, 64));
  } else if (hasSource && body.source_type === null) {
    updates.push(`source_type = $${n++}`);
    params.push('manual');
  }

  if (hasMusicVol) {
    const v = Number(body.music_volume);
    if (!Number.isFinite(v) || v < 0 || v > 1) {
      res.status(400).json({ error: 'music_volume must be a number between 0 and 1' });
      return;
    }
    updates.push(`music_volume = $${n++}`);
    params.push(v);
  }

  if (hasMusicTrack) {
    let trackName = body.music_track;
    if (trackName === '' || trackName === null) {
      updates.push(`music_track = $${n++}`);
      params.push(null);
    } else {
      trackName = String(trackName);
      if (!isSafeMusicFilename(trackName) || !MUSIC_EXT.test(trackName)) {
        res.status(400).json({ error: 'music_track must be a safe filename under assets/music' });
        return;
      }
      const abs = join(MUSIC_DIR, trackName);
      if (!existsSync(abs)) {
        res.status(400).json({ error: 'music file not found' });
        return;
      }
      updates.push(`music_track = $${n++}`);
      params.push(trackName);
    }
  }

  if (hasYtProj) {
    const yid = body.youtube_connection_id;
    if (yid === null || yid === '') {
      updates.push(`youtube_connection_id = $${n++}`);
      params.push(null);
    } else {
      const { rows: yc } = await pool.query(`SELECT id FROM youtube_connections WHERE id = $1 AND user_id = $2`, [
        yid,
        req.user.sub,
      ]);
      if (!yc[0]) {
        res.status(400).json({ error: 'Invalid youtube_connection_id' });
        return;
      }
      updates.push(`youtube_connection_id = $${n++}`);
      params.push(yc[0].id);
    }
  }

  if (hasTiktokProj) {
    const tid = body.tiktok_connection_id;
    if (tid === null || tid === '') {
      updates.push(`tiktok_connection_id = $${n++}`);
      params.push(null);
    } else {
      const { rows: tc } = await pool.query(`SELECT id FROM tiktok_connections WHERE id = $1 AND user_id = $2`, [
        tid,
        req.user.sub,
      ]);
      if (!tc[0]) {
        res.status(400).json({ error: 'Invalid tiktok_connection_id' });
        return;
      }
      updates.push(`tiktok_connection_id = $${n++}`);
      params.push(tc[0].id);
    }
  }

  if (hasUploadDestYoutube) {
    if (body.upload_dest_youtube !== true && body.upload_dest_youtube !== false) {
      res.status(400).json({ error: 'upload_dest_youtube must be a boolean' });
      return;
    }
    updates.push(`upload_dest_youtube = $${n++}`);
    params.push(Boolean(body.upload_dest_youtube));
  }
  if (hasUploadDestTiktok) {
    if (body.upload_dest_tiktok !== true && body.upload_dest_tiktok !== false) {
      res.status(400).json({ error: 'upload_dest_tiktok must be a boolean' });
      return;
    }
    updates.push(`upload_dest_tiktok = $${n++}`);
    params.push(Boolean(body.upload_dest_tiktok));
  }

  let nextYt =
    existing[0].upload_dest_youtube == null ? true : Boolean(existing[0].upload_dest_youtube);
  let nextTt = existing[0].upload_dest_tiktok === true;
  if (hasUploadDestYoutube) nextYt = Boolean(body.upload_dest_youtube);
  if (hasUploadDestTiktok) nextTt = Boolean(body.upload_dest_tiktok);
  if (!nextYt && !nextTt) {
    res.status(400).json({
      error: 'At least one publish destination must stay on: YouTube Shorts and/or TikTok.',
    });
    return;
  }

  if (hasVoiceSource) {
    const vs = String(body.voice_source || '').toLowerCase();
    if (vs !== 'ai' && vs !== 'uploaded') {
      res.status(400).json({ error: "voice_source must be 'ai' or 'uploaded'" });
      return;
    }
    if (vs === 'uploaded') {
      const { rows: ex } = await pool.query(`SELECT voice_asset_path FROM projects WHERE id = $1 AND user_id = $2`, [
        id,
        req.user.sub,
      ]);
      if (!ex[0]?.voice_asset_path || !existsSync(ex[0].voice_asset_path)) {
        res.status(400).json({ error: 'Upload a voice file first, then switch to uploaded voice.' });
        return;
      }
    }
    updates.push(`voice_source = $${n++}`);
    params.push(vs);
  }

  if (hasBurnCaptions) {
    if (body.burn_captions !== true && body.burn_captions !== false) {
      res.status(400).json({ error: 'burn_captions must be a boolean' });
      return;
    }
    updates.push(`burn_captions = $${n++}`);
    params.push(Boolean(body.burn_captions));
  }

  updates.push('updated_at = NOW()');
  params.push(id, req.user.sub);

  const sql = `UPDATE projects SET ${updates.join(', ')} WHERE id = $${n++} AND user_id = $${n++} RETURNING *`;
  const { rows } = await pool.query(sql, params);
  res.json({ project: rows[0] });
});

r.get('/:id/thumbnail', async (req, res) => {
  const { rows } = await pool.query(`SELECT thumbnail_path FROM projects WHERE id = $1 AND user_id = $2`, [
    req.params.id,
    req.user.sub,
  ]);
  const pth = rows[0]?.thumbnail_path;
  if (!pth || !existsSync(pth)) {
    res.status(404).json({ error: 'No thumbnail' });
    return;
  }
  const ct = String(pth).toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
  res.setHeader('Content-Type', ct);
  res.sendFile(pth);
});

r.post('/:id/generate-thumbnail', async (req, res) => {
  const { id } = req.params;
  const mode = String(req.body?.mode || 'canvas');
  const { rows: pr } = await pool.query(`SELECT * FROM projects WHERE id = $1 AND user_id = $2`, [id, req.user.sub]);
  const proj = pr[0];
  if (!proj) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  const outDir = join(process.cwd(), 'generated', req.user.sub);
  mkdirSync(outDir, { recursive: true });

  try {
    if (mode === 'extract') {
      if (!proj.output_video_path || !existsSync(proj.output_video_path)) {
        res.status(400).json({ error: 'Rendered video required for frame extract' });
        return;
      }
      const jpgPath = join(outDir, `${id}_thumb.jpg`);
      const seek = thumbnailSeekSecondsForProject(proj, Number(proj.duration_seconds));
      await extractVideoThumbnailJpg(proj.output_video_path, jpgPath, { seekSeconds: seek });
      await pool.query(`UPDATE projects SET thumbnail_path = $2, updated_at = NOW() WHERE id = $1 AND user_id = $3`, [
        id,
        jpgPath,
        req.user.sub,
      ]);
    } else {
      const subtitle = proj.source_type === 'reddit' ? 'reddit' : '';
      const pngPath = join(outDir, `${id}_thumb.png`);
      await generateTitleThumbnailPng({
        titleText: proj.title || 'Short',
        subtitleText: subtitle,
        destPath: pngPath,
        sourceType: proj.source_type,
        redditPermalink: proj.reddit_permalink,
      });
      await pool.query(`UPDATE projects SET thumbnail_path = $2, updated_at = NOW() WHERE id = $1 AND user_id = $3`, [
        id,
        pngPath,
        req.user.sub,
      ]);
    }

    const { rows } = await pool.query(`SELECT thumbnail_path FROM projects WHERE id = $1 AND user_id = $2`, [
      id,
      req.user.sub,
    ]);
    res.json({ ok: true, thumbnail_path: rows[0]?.thumbnail_path || null });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

r.get('/:id', async (req, res) => {
  await maybeReconcileStaleRenderingProjects();
  const { rows } = await pool.query(`SELECT * FROM projects WHERE id = $1 AND user_id = $2`, [
    req.params.id,
    req.user.sub,
  ]);
  if (!rows[0]) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  res.json({ project: rows[0] });
});

r.post('/:id/schedule', async (req, res) => {
  const { id } = req.params;
  const b = req.body || {};
  const {
    scheduled_at,
    title,
    description,
    tags,
    privacy_status,
    youtube_connection_id,
    tiktok_connection_id,
    allow_repeat_output_upload,
  } = b;
  const forceRepeatOutput =
    allow_repeat_output_upload === true ||
    allow_repeat_output_upload === 1 ||
    String(allow_repeat_output_upload || '').toLowerCase() === 'true';
  if (!scheduled_at) {
    res.status(400).json({ error: 'scheduled_at ISO datetime required' });
    return;
  }
  if (youtube_connection_id) {
    const { rows: yc } = await pool.query(
      `SELECT id FROM youtube_connections WHERE id = $1 AND user_id = $2`,
      [youtube_connection_id, req.user.sub]
    );
    if (!yc[0]) {
      res.status(400).json({ error: 'Invalid youtube_connection_id' });
      return;
    }
  }
  if (tiktok_connection_id) {
    const { rows: tc } = await pool.query(
      `SELECT id FROM tiktok_connections WHERE id = $1 AND user_id = $2`,
      [tiktok_connection_id, req.user.sub]
    );
    if (!tc[0]) {
      res.status(400).json({ error: 'Invalid tiktok_connection_id' });
      return;
    }
  }
  const { rows: pr } = await pool.query(
    `SELECT * FROM projects WHERE id = $1 AND user_id = $2`,
    [id, req.user.sub]
  );
  const project = pr[0];
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  if (project.status !== 'ready') {
    res.status(400).json({ error: 'Project must be rendered (status ready) before scheduling' });
    return;
  }
  if (!project.output_video_path || !existsSync(project.output_video_path)) {
    res.status(400).json({ error: 'Rendered video missing on disk — generate the video first.' });
    return;
  }

  const pendingEarly = await countActiveUploadQueueForProject(pool, id);
  if (pendingEarly > 0) {
    res.status(409).json({
      error:
        'This project already has uploads in the queue (pending or uploading). Remove them from the calendar or wait until they finish before queueing again.',
      code: 'UPLOAD_QUEUE_NON_EMPTY',
      pending_count: pendingEarly,
    });
    return;
  }
  if (sameOutputRevisionAlreadyQueued(project, forceRepeatOutput)) {
    res.status(409).json({
      error:
        'This exact rendered video was already queued for upload. Generate a new version (re-render), or enable “Allow uploading this same render again” in the editor to queue a duplicate.',
      code: 'DUPLICATE_OUTPUT_REVISION',
      output_revision: Number(project.output_revision ?? 0),
    });
    return;
  }

  const wantYt = project.upload_dest_youtube !== false;
  const wantTt = project.upload_dest_tiktok === true;
  if (!wantYt && !wantTt) {
    res.status(400).json({
      error:
        'This project is not set to publish anywhere. In the editor, turn on YouTube Shorts and/or TikTok under Schedule, then save.',
    });
    return;
  }

  let ytConnResolved = null;
  if (wantYt) {
    if (youtube_connection_id) {
      ytConnResolved = youtube_connection_id;
    } else if (project.youtube_connection_id) {
      ytConnResolved = project.youtube_connection_id;
    } else {
      const { rows: yd } = await pool.query(
        `SELECT id FROM youtube_connections WHERE user_id = $1 ORDER BY is_default DESC, updated_at DESC LIMIT 1`,
        [req.user.sub]
      );
      ytConnResolved = yd[0]?.id || null;
    }
  }
  let ttConnResolved = null;
  if (wantTt) {
    if (tiktok_connection_id) {
      ttConnResolved = tiktok_connection_id;
    } else if (project.tiktok_connection_id) {
      ttConnResolved = project.tiktok_connection_id;
    } else {
      const { rows: td } = await pool.query(
        `SELECT id FROM tiktok_connections WHERE user_id = $1 ORDER BY is_default DESC, updated_at DESC LIMIT 1`,
        [req.user.sub]
      );
      ttConnResolved = td[0]?.id || null;
    }
  }
  if (wantYt && !ytConnResolved) {
    res.status(400).json({
      error: 'YouTube Shorts is enabled for this project but no channel is selected. Connect Google under Settings or pick a channel in the editor.',
    });
    return;
  }
  if (wantTt && !ttConnResolved) {
    res.status(400).json({
      error: 'TikTok is enabled for this project but no TikTok account is linked. Connect TikTok under Settings or pick an account in the editor.',
    });
    return;
  }

  const resolvedScheduleTitle =
    title != null && String(title).trim() ? String(title).trim() : String(project.title || '').trim();
  const youtubeSafeTitle = clipYoutubeVideoTitle(resolvedScheduleTitle);
  const workDir = dirname(String(project.output_video_path));
  const baseDesc = description != null && String(description).trim() ? String(description).trim() : '';

  const baseMs = new Date(scheduled_at).getTime();
  if (Number.isNaN(baseMs)) {
    res.status(400).json({ error: 'scheduled_at must be a valid ISO datetime' });
    return;
  }

  let segMeta;
  try {
    segMeta = await buildShortSizedSegments(
      project.output_video_path,
      workDir,
      Number(project.duration_seconds)
    );
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
    return;
  }

  try {
    segMeta = await applySplitPartBookendTts(segMeta, workDir, {
      title: resolvedScheduleTitle,
      voiceSource: project.voice_source,
    });
  } catch (e) {
    if (Array.isArray(segMeta) && segMeta.some((s) => s.path && s.path !== project.output_video_path)) {
      await unlinkShortSplitPartsInDir(workDir, req.user.sub);
    }
    res.status(500).json({ error: String(e.message || e) });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: lockedRows } = await client.query(
      `SELECT * FROM projects WHERE id = $1::uuid AND user_id = $2::uuid FOR UPDATE`,
      [id, req.user.sub]
    );
    const locked = lockedRows[0];
    if (!locked || locked.status !== 'ready') {
      await client.query('ROLLBACK');
      if (!res.headersSent) {
        res.status(409).json({
          error: 'Project changed while scheduling — refresh and try again.',
          code: 'PROJECT_CHANGED',
        });
      }
      return;
    }
    const pendingLocked = await countActiveUploadQueueForProject(client, id);
    if (pendingLocked > 0) {
      await client.query('ROLLBACK');
      if (!res.headersSent) {
        res.status(409).json({
          error:
            'This project already has uploads in the queue (pending or uploading). Remove them from the calendar or wait before queueing again.',
          code: 'UPLOAD_QUEUE_NON_EMPTY',
          pending_count: pendingLocked,
        });
      }
      return;
    }
    if (sameOutputRevisionAlreadyQueued(locked, forceRepeatOutput)) {
      await client.query('ROLLBACK');
      if (!res.headersSent) {
        res.status(409).json({
          error:
            'This exact rendered video was already queued for upload. Re-render for a new file, or enable “Allow uploading this same render again”.',
          code: 'DUPLICATE_OUTPUT_REVISION',
          output_revision: Number(locked.output_revision ?? 0),
        });
      }
      return;
    }

    const insWantYt = locked.upload_dest_youtube !== false;
    const insWantTt = locked.upload_dest_tiktok === true;
    if (!insWantYt && !insWantTt) {
      await client.query('ROLLBACK');
      if (!res.headersSent) {
        res.status(409).json({
          error: 'Project upload destinations changed during scheduling — refresh and try again.',
          code: 'PROJECT_CHANGED',
        });
      }
      return;
    }

    let yId = null;
    if (insWantYt) {
      if (youtube_connection_id) {
        yId = youtube_connection_id;
      } else if (locked.youtube_connection_id) {
        yId = locked.youtube_connection_id;
      } else {
        const { rows: yd } = await client.query(
          `SELECT id FROM youtube_connections WHERE user_id = $1 ORDER BY is_default DESC, updated_at DESC LIMIT 1`,
          [req.user.sub]
        );
        yId = yd[0]?.id || null;
      }
    }
    let tId = null;
    if (insWantTt) {
      if (tiktok_connection_id) {
        tId = tiktok_connection_id;
      } else if (locked.tiktok_connection_id) {
        tId = locked.tiktok_connection_id;
      } else {
        const { rows: td } = await client.query(
          `SELECT id FROM tiktok_connections WHERE user_id = $1 ORDER BY is_default DESC, updated_at DESC LIMIT 1`,
          [req.user.sub]
        );
        tId = td[0]?.id || null;
      }
    }
    if (insWantYt && !yId) {
      await client.query('ROLLBACK');
      if (!res.headersSent) {
        res.status(400).json({
          error:
            'YouTube Shorts is enabled but no channel could be resolved. Connect Google under Settings or pick a channel.',
        });
      }
      return;
    }
    if (insWantTt && !tId) {
      await client.query('ROLLBACK');
      if (!res.headersSent) {
        res.status(400).json({
          error:
            'TikTok is enabled but no TikTok account could be resolved. Connect TikTok under Settings or pick an account.',
        });
      }
      return;
    }

    const tz = await getUserTimezone(client, req.user.sub);
    const { cap, isNewAccount } = await getDailyUploadCap(client, req.user.sub);
    const existingByDay = await countScheduledVideosByLocalDay(client, req.user.sub, tz);
    /** Each part is one video regardless of how many platforms it publishes to. */
    const newByDay = new Map();
    for (let i = 0; i < segMeta.length; i += 1) {
      const day = localDayKey(new Date(baseMs + i * SHORTS_MULTI_PART_GAP_MS), tz);
      newByDay.set(day, (newByDay.get(day) || 0) + 1);
    }
    for (const [day, addCount] of newByDay) {
      const already = existingByDay.get(day) || 0;
      if (already + addCount > cap) {
        await client.query('ROLLBACK');
        if (segMeta.length > 1) await unlinkShortSplitPartsInDir(workDir, req.user.sub);
        if (!res.headersSent) {
          res.status(409).json({
            error: isNewAccount
              ? `New accounts can publish up to ${cap} video per day for the first 2 weeks. ${day} already has ${already} scheduled. Pick a later start date — multi-part clips post one part per day.`
              : `You can publish up to ${cap} videos per day. ${day} already has ${already} scheduled. Pick a later start date — multi-part clips post one part per day.`,
            code: 'DAILY_UPLOAD_CAP_EXCEEDED',
            daily_cap: cap,
            day,
            already_scheduled: already,
          });
        }
        return;
      }
    }

    /** @type {Record<string, unknown>[]} */
    const inserted = [];
    for (let i = 0; i < segMeta.length; i += 1) {
      const seg = segMeta[i];
      const when = new Date(baseMs + i * SHORTS_MULTI_PART_GAP_MS);
      const rowTitle =
        seg.total > 1
          ? youtubeShortsMultipartTitle(
              resolvedScheduleTitle,
              seg.index,
              seg.total,
              String(locked.title || '').trim() || 'Short'
            )
          : youtubeSafeTitle;
      const descForRow =
        seg.total > 1
          ? (() => {
              const suffix = `Part ${seg.index} of ${seg.total}.`;
              const combined = baseDesc ? `${baseDesc}\n\n${suffix}` : suffix;
              return combined.length > 4900 ? combined.slice(0, 4900) : combined;
            })()
          : baseDesc || null;

      const videoPath = seg.total > 1 ? seg.path : null;

      const insertOne = async (platform) => {
        const { rows: ins } = await client.query(
          `INSERT INTO scheduled_uploads
      (project_id, user_id, platform, youtube_connection_id, tiktok_connection_id, scheduled_at, title, description, tags, privacy_status, status, output_video_path)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11)
     RETURNING *`,
          [
            id,
            req.user.sub,
            platform,
            platform === 'youtube' ? yId : null,
            platform === 'tiktok' ? tId : null,
            when,
            rowTitle,
            descForRow,
            Array.isArray(tags) ? tags : null,
            privacy_status || 'private',
            videoPath,
          ]
        );
        inserted.push(ins[0]);
        await client.query(
          `INSERT INTO upload_diagnostics (scheduled_upload_id, user_id, metric, value_json)
     VALUES ($1, $2, 'upload_scheduled', $3::jsonb)`,
          [
            ins[0].id,
            req.user.sub,
            JSON.stringify({
              projectId: id,
              projectTitle: locked.title,
              title: ins[0].title,
              partIndex: seg.index,
              partTotal: seg.total,
              platform,
              scheduledAt:
                ins[0].scheduled_at instanceof Date
                  ? ins[0].scheduled_at.toISOString()
                  : new Date(ins[0].scheduled_at).toISOString(),
            }),
          ]
        );
      };

      if (insWantYt) await insertOne('youtube');
      if (insWantTt) await insertOne('tiktok');
    }
    await client.query(
      `UPDATE projects SET last_queued_output_revision = output_revision, updated_at = NOW()
       WHERE id = $1::uuid AND user_id = $2::uuid`,
      [id, req.user.sub]
    );
    await client.query('COMMIT');
    res.json({ scheduled: inserted, part_count: inserted.length });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (segMeta.length > 1) await unlinkShortSplitPartsInDir(workDir, req.user.sub);
    if (!res.headersSent) {
      res.status(500).json({ error: String(e.message || e) });
    }
  } finally {
    client.release();
  }
});

export default r;
