import { renderShort } from './render.js';
import { pool } from '../db.js';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { uploadVideo } from './youtubeUpload.js';

const queue = [];
let busy = false;

export function enqueueRender(projectId) {
  queue.push({ type: 'render', projectId });
  drain();
}

async function drain() {
  if (busy) return;
  const job = queue.shift();
  if (!job) return;
  busy = true;
  try {
    if (job.type === 'render') await runRenderJob(job.projectId);
  } catch (e) {
    console.error('Job failed', e);
  } finally {
    busy = false;
    drain();
  }
}

async function runRenderJob(projectId) {
  const { rows } = await pool.query(
    `SELECT id, user_id, title, script_text, caption_text, background_asset_path, caption_settings FROM projects WHERE id = $1`,
    [projectId]
  );
  const p = rows[0];
  if (!p) return;

  await pool.query(
    `UPDATE projects SET status = 'rendering', error_message = NULL,
       render_progress = 5, render_phase = $2, updated_at = NOW() WHERE id = $1`,
    [projectId, 'Starting…']
  );

  await pool.query(
    `INSERT INTO upload_diagnostics (scheduled_upload_id, user_id, metric, value_json)
     VALUES (NULL, $1, 'render_started', $2::jsonb)`,
    [p.user_id, JSON.stringify({ projectId, title: p.title })]
  );

  const base = join(process.cwd(), 'generated', p.user_id);
  mkdirSync(base, { recursive: true });
  const workDir = join(base, projectId);

  const reportProgress = async (pct, phase) => {
    await pool.query(
      `UPDATE projects SET render_progress = $2, render_phase = $3, updated_at = NOW() WHERE id = $1`,
      [projectId, Math.min(100, Math.max(0, pct)), phase]
    );
  };

  try {
    const { outPath, durationSeconds } = await renderShort({
      scriptText: p.script_text,
      captionScriptText: p.caption_text != null ? p.caption_text : undefined,
      workDir,
      backgroundPath: p.background_asset_path || undefined,
      outputFilename: 'short.mp4',
      onProgress: reportProgress,
      captionSettings: p.caption_settings || undefined,
    });

    await pool.query(
      `UPDATE projects SET status = 'ready', output_video_path = $2, duration_seconds = $3,
         render_progress = NULL, render_phase = NULL, updated_at = NOW() WHERE id = $1`,
      [projectId, outPath, durationSeconds]
    );

    await pool.query(
      `INSERT INTO upload_diagnostics (scheduled_upload_id, user_id, metric, value_json)
       SELECT NULL, $1, 'render_complete', $2::jsonb`,
      [p.user_id, JSON.stringify({ projectId, durationSeconds })]
    );
  } catch (err) {
    await pool.query(
      `UPDATE projects SET status = 'failed', error_message = $2,
         render_progress = NULL, render_phase = NULL, updated_at = NOW() WHERE id = $1`,
      [projectId, String(err.message || err)]
    );
  }
}
