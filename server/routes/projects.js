import { Router } from 'express';
import multer from 'multer';
import { basename, join } from 'path';
import { mkdirSync, existsSync, readdirSync, statSync } from 'fs';
import { pool } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { enqueueRender } from '../services/jobQueue.js';

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
  res.json({ project: rows[0] });
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
  const { scheduled_at, title, description, tags, privacy_status } = req.body || {};
  if (!scheduled_at) {
    res.status(400).json({ error: 'scheduled_at ISO datetime required' });
    return;
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
      (project_id, user_id, scheduled_at, title, description, tags, privacy_status, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
     RETURNING *`,
    [
      id,
      req.user.sub,
      new Date(scheduled_at),
      title || project.title,
      description || null,
      Array.isArray(tags) ? tags : null,
      privacy_status || 'private',
    ]
  );
  res.json({ scheduled: rows[0] });
});

export default r;
