import { Router } from 'express';
import multer from 'multer';
import { basename, join } from 'path';
import { mkdirSync, existsSync, readdirSync, statSync } from 'fs';
import { pool } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { enqueueRender } from '../services/jobQueue.js';
import { normalizeCaptionSettings } from '../captionDefaults.js';

const r = Router();
r.use(authRequired);

const GAMEPLAY_DIR = join(process.cwd(), 'assets', 'gameplay');
const PRESET_VIDEO = /\.(mp4|webm)$/i;

function isSafePresetFilename(name) {
  if (!name || name !== basename(name) || name.includes('..')) return false;
  return /^[a-zA-Z0-9._-]+$/.test(name);
}

function listGameplayPresets() {
  mkdirSync(GAMEPLAY_DIR, { recursive: true });
  try {
    return readdirSync(GAMEPLAY_DIR)
      .filter((n) => isSafePresetFilename(n) && PRESET_VIDEO.test(n))
      .filter((n) => {
        try {
          return statSync(join(GAMEPLAY_DIR, n)).isFile();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
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

r.get('/', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, title, script_text, status, duration_seconds, error_message, created_at, updated_at
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

r.get('/background-presets', (_req, res) => {
  res.json({ presets: listGameplayPresets() });
});

r.post('/:id/background', upload.single('file'), async (req, res) => {
  const { id } = req.params;
  if (!req.file) {
    res.status(400).json({ error: 'file required (mp4/webm)' });
    return;
  }
  const { rows } = await pool.query(
    `UPDATE projects SET background_asset_path = $2, updated_at = NOW()
     WHERE id = $1 AND user_id = $3 RETURNING id, background_asset_path`,
    [id, req.file.path, req.user.sub]
  );
  if (!rows[0]) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  res.json({ project: rows[0] });
});

r.post('/:id/background-preset', async (req, res) => {
  const { id } = req.params;
  const filename = req.body?.filename;
  if (!filename || typeof filename !== 'string' || !isSafePresetFilename(filename) || !PRESET_VIDEO.test(filename)) {
    res.status(400).json({ error: 'filename must be a .mp4 or .webm under assets/gameplay' });
    return;
  }
  const absPath = join(GAMEPLAY_DIR, filename);
  if (!existsSync(absPath)) {
    res.status(404).json({ error: 'Preset file not found' });
    return;
  }
  const { rows } = await pool.query(
    `UPDATE projects SET background_asset_path = $2, updated_at = NOW()
     WHERE id = $1 AND user_id = $3 RETURNING id, background_asset_path`,
    [id, absPath, req.user.sub]
  );
  if (!rows[0]) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  res.json({ project: rows[0] });
});

r.post('/:id/render', async (req, res) => {
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

r.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const body = req.body || {};
  const { caption_settings, script_text, title } = body;
  const hasCaption =
    caption_settings !== undefined && caption_settings !== null && typeof caption_settings === 'object';
  const hasScript = typeof script_text === 'string';
  const hasTitle = typeof title === 'string';
  const hasCaptionTextKey = Object.prototype.hasOwnProperty.call(body, 'caption_text');

  if (!hasCaption && !hasScript && !hasTitle && !hasCaptionTextKey) {
    res.status(400).json({ error: 'Provide caption_settings, script_text, title, and/or caption_text' });
    return;
  }

  const { rows: existing } = await pool.query(
    `SELECT caption_settings, script_text, title FROM projects WHERE id = $1 AND user_id = $2`,
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

  updates.push('updated_at = NOW()');
  params.push(id, req.user.sub);

  const sql = `UPDATE projects SET ${updates.join(', ')} WHERE id = $${n++} AND user_id = $${n++} RETURNING *`;
  const { rows } = await pool.query(sql, params);
  res.json({ project: rows[0] });
});

r.get('/:id', async (req, res) => {
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
  const { scheduled_at, title, description, tags, privacy_status, youtube_connection_id } = req.body || {};
  if (!scheduled_at) {
    res.status(400).json({ error: 'scheduled_at ISO datetime required' });
    return;
  }
  let ytConnId = null;
  if (youtube_connection_id) {
    const { rows: yc } = await pool.query(
      `SELECT id FROM youtube_connections WHERE id = $1 AND user_id = $2`,
      [youtube_connection_id, req.user.sub]
    );
    if (!yc[0]) {
      res.status(400).json({ error: 'Invalid youtube_connection_id' });
      return;
    }
    ytConnId = yc[0].id;
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

  const { rows } = await pool.query(
    `INSERT INTO scheduled_uploads
      (project_id, user_id, youtube_connection_id, scheduled_at, title, description, tags, privacy_status, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
     RETURNING *`,
    [
      id,
      req.user.sub,
      ytConnId,
      new Date(scheduled_at),
      title || project.title,
      description || null,
      Array.isArray(tags) ? tags : null,
      privacy_status || 'private',
    ]
  );
  const scheduled = rows[0];
  await pool.query(
    `INSERT INTO upload_diagnostics (scheduled_upload_id, user_id, metric, value_json)
     VALUES ($1, $2, 'upload_scheduled', $3::jsonb)`,
    [
      scheduled.id,
      req.user.sub,
      JSON.stringify({
        projectId: id,
        projectTitle: project.title,
        title: scheduled.title,
        scheduledAt: scheduled.scheduled_at.toISOString(),
      }),
    ]
  );
  res.json({ scheduled });
});

export default r;
