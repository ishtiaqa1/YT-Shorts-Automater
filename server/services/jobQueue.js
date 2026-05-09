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
    `SELECT id, user_id, title, script_text, background_asset_path FROM projects WHERE id = $1`,
    [projectId]
  );
  const p = rows[0];
  if (!p) return;

  await pool.query(`UPDATE projects SET status = 'rendering', error_message = NULL, updated_at = NOW() WHERE id = $1`, [
    projectId,
  ]);

  const base = join(process.cwd(), 'generated', p.user_id);
  mkdirSync(base, { recursive: true });
  const workDir = join(base, projectId);

  try {
    const { outPath, durationSeconds } = await renderShort({
      scriptText: p.script_text,
      workDir,
      backgroundPath: p.background_asset_path || undefined,
      outputFilename: 'short.mp4',
    });

    await pool.query(
      `UPDATE projects SET status = 'ready', output_video_path = $2, duration_seconds = $3, updated_at = NOW() WHERE id = $1`,
      [projectId, outPath, durationSeconds]
    );

    await pool.query(
      `INSERT INTO upload_diagnostics (scheduled_upload_id, user_id, metric, value_json)
       SELECT NULL, $1, 'render_complete', $2::jsonb`,
      [p.user_id, JSON.stringify({ projectId, durationSeconds })]
    );
  } catch (err) {
    await pool.query(
      `UPDATE projects SET status = 'failed', error_message = $2, updated_at = NOW() WHERE id = $1`,
      [projectId, String(err.message || err)]
    );
  }
}
