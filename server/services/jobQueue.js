import { existsSync, mkdirSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { unlink } from 'fs/promises';
import { renderShort } from './render.js';
import { pool } from '../db.js';
import { extractVideoThumbnailJpg, thumbnailSeekSecondsForProject } from './thumbnail.js';
import { mailRenderReady } from './email.js';
import { appPublicOrigin } from '../appPublicUrl.js';
import {
  pickRandomBundledAbsolutePath,
  sanitizeThemeId,
  isBundledAssetPath,
  bundledVideoBelongsToTheme,
  isEphemeralUserBackgroundPath,
} from './bundledBackgrounds.js';
import { combineTitleBeforeStory } from './spokenScript.js';

const queue = [];
let busy = false;

/** If `updated_at` is this old while still `rendering`, the worker likely crashed (heartbeats stop). */
const STALE_RENDERING_MINUTES = Math.max(
  10,
  Math.min(120, Number(process.env.STALE_RENDERING_MINUTES || 25))
);
const RENDER_HEARTBEAT_MS = Math.max(10_000, Number(process.env.RENDER_HEARTBEAT_MS || 20_000));

let lastStaleReconcileAt = 0;
const STALE_RECONCILE_INTERVAL_MS = 90_000;

export function enqueueRender(projectId) {
  queue.push({ type: 'render', projectId });
  drain();
}

/** Marks long-dead `rendering` rows failed so the UI can recover (throttled). */
export async function maybeReconcileStaleRenderingProjects() {
  const now = Date.now();
  if (now - lastStaleReconcileAt < STALE_RECONCILE_INTERVAL_MS) return;
  lastStaleReconcileAt = now;
  const msg =
    'Render had no server heartbeat for a long time (API may have restarted or the worker stalled). Try Generate video again.';
  await pool.query(
    `UPDATE projects SET status = 'failed', error_message = $2,
       render_progress = NULL, render_phase = NULL, updated_at = NOW()
     WHERE status = 'rendering' AND updated_at < NOW() - ($1 * INTERVAL '1 minute')`,
    [STALE_RENDERING_MINUTES, msg]
  );
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
    `SELECT id, user_id, title, script_text, caption_text,
            background_asset_path,
            COALESCE(background_theme, 'gameplay') AS background_theme,
            caption_settings,
            COALESCE(caption_style, 'bold_pop') AS caption_style,
            music_track, COALESCE(music_volume, 0.15)::float AS music_volume,
            COALESCE(voice_source, 'ai') AS voice_source, voice_asset_path,
            COALESCE(burn_captions, true) AS burn_captions,
            reddit_permalink, source_type
     FROM projects WHERE id = $1`,
    [projectId]
  );
  const p = rows[0];
  if (!p) return;

  await pool.query(
    `UPDATE projects SET status = 'rendering', error_message = NULL,
       render_progress = 0, render_phase = $2, updated_at = NOW() WHERE id = $1`,
    [projectId, 'Queued…']
  );

  await pool.query(
    `INSERT INTO upload_diagnostics (scheduled_upload_id, user_id, metric, value_json)
     VALUES (NULL, $1, 'render_started', $2::jsonb)`,
    [p.user_id, JSON.stringify({ projectId, title: p.title })]
  );

  const base = join(process.cwd(), 'generated', p.user_id);
  mkdirSync(base, { recursive: true });
  const workDir = join(base, projectId);
  if (existsSync(workDir)) {
    for (const name of readdirSync(workDir)) {
      if (/^short_part\d+\.mp4$/i.test(name)) {
        await unlink(join(workDir, name)).catch(() => {});
      }
    }
  }

  const reportProgress = async (pct, phase) => {
    await pool.query(
      `UPDATE projects SET render_progress = $2, render_phase = $3, updated_at = NOW() WHERE id = $1`,
      [projectId, Math.min(100, Math.max(0, pct)), phase]
    );
  };

  const hb = setInterval(() => {
    void pool
      .query(`UPDATE projects SET updated_at = NOW() WHERE id = $1 AND status = 'rendering'`, [projectId])
      .catch(() => {});
  }, RENDER_HEARTBEAT_MS);
  hb.unref?.();

  try {
    let musicAbsolute;
    const track = typeof p.music_track === 'string' ? p.music_track.trim() : '';
    if (track && /^[a-zA-Z0-9._-]+$/.test(track)) {
      const m = join(process.cwd(), 'assets', 'music', track);
      if (existsSync(m)) musicAbsolute = m;
    }

    const theme = sanitizeThemeId(p.background_theme);
    const rawBg = typeof p.background_asset_path === 'string' ? p.background_asset_path.trim() : '';
    let renderBgAbs = null;
    if (rawBg) {
      const rp = resolve(rawBg);
      if (existsSync(rp)) {
        if (isEphemeralUserBackgroundPath(rp, p.user_id)) {
          renderBgAbs = rp;
        } else if (isBundledAssetPath(rp)) {
          if (bundledVideoBelongsToTheme(theme, rp)) renderBgAbs = rp;
        } else {
          renderBgAbs = rp;
        }
      }
    }

    if (!renderBgAbs) {
      renderBgAbs = pickRandomBundledAbsolutePath(theme);
      if (renderBgAbs) {
        await pool.query(
          `UPDATE projects SET background_asset_path = $2, updated_at = NOW() WHERE id = $1`,
          [projectId, renderBgAbs]
        );
      }
    }

    const userBgUsed =
      typeof renderBgAbs === 'string' &&
      Boolean(renderBgAbs) &&
      isEphemeralUserBackgroundPath(renderBgAbs, p.user_id);

    const captionOverride = p.caption_text != null ? String(p.caption_text).trim() : '';

    const useUploadedVoice =
      p.voice_source === 'uploaded' &&
      typeof p.voice_asset_path === 'string' &&
      existsSync(p.voice_asset_path);
    const titleStr = typeof p.title === 'string' ? p.title : '';
    const rawScript = String(p.script_text ?? '');
    let scriptTextForRender = rawScript;
    let captionScriptForRender = captionOverride || undefined;
    if (!useUploadedVoice) {
      scriptTextForRender = combineTitleBeforeStory(titleStr, rawScript);
      if (captionOverride) {
        captionScriptForRender = combineTitleBeforeStory(titleStr, captionOverride);
      }
    }

    const { outPath, durationSeconds } = await renderShort({
      scriptText: scriptTextForRender,
      captionScriptText: captionScriptForRender,
      workDir,
      backgroundPath: renderBgAbs || undefined,
      outputFilename: 'short.mp4',
      onProgress: reportProgress,
      captionSettings: p.caption_settings || undefined,
      captionStyle: p.caption_style || undefined,
      musicPath: musicAbsolute,
      musicVolume: p.music_volume,
      voiceoverPath: useUploadedVoice ? p.voice_asset_path : undefined,
      redditPermalink: typeof p.reddit_permalink === 'string' ? p.reddit_permalink : null,
      redditIntroTitle: typeof p.title === 'string' ? p.title : null,
      burnCaptions: p.burn_captions !== false,
    });

    let thumbStored = null;
    try {
      const thumbAbs = join(base, `${projectId}_thumb.jpg`);
      await extractVideoThumbnailJpg(outPath, thumbAbs, {
        seekSeconds: thumbnailSeekSecondsForProject(p, durationSeconds),
      });
      thumbStored = thumbAbs;
    } catch (e) {
      console.warn('[render] thumbnail extract skipped', e?.message || e);
    }

    await pool.query(
      `UPDATE projects SET status = 'ready', output_video_path = $2, duration_seconds = $3,
         thumbnail_path = COALESCE($4, thumbnail_path),
         render_progress = NULL, render_phase = NULL,
         output_revision = COALESCE(output_revision, 0) + 1,
         updated_at = NOW() WHERE id = $1`,
      [projectId, outPath, durationSeconds, thumbStored]
    );

    /** Remove one-off user uploads after a successful burn; persist a bundled path for subsequent renders/UI. */
    if (userBgUsed && typeof renderBgAbs === 'string' && renderBgAbs) {
      await unlink(renderBgAbs).catch(() => {});
      const nextStore = pickRandomBundledAbsolutePath(theme);
      await pool.query(`UPDATE projects SET background_asset_path = $2, updated_at = NOW() WHERE id = $1`, [
        projectId,
        nextStore ?? null,
      ]);
    }

    await pool.query(
      `INSERT INTO upload_diagnostics (scheduled_upload_id, user_id, metric, value_json)
       SELECT NULL, $1, 'render_complete', $2::jsonb`,
      [p.user_id, JSON.stringify({ projectId, durationSeconds })]
    );

    try {
      const { rows: ur } = await pool.query(`SELECT email FROM users WHERE id = $1`, [p.user_id]);
      const em = ur[0]?.email;
      if (em) {
        const origin = appPublicOrigin();
        const projUrl = origin ? `${origin}/app/project/${projectId}` : undefined;
        await mailRenderReady(em, p.title, projUrl);
      }
    } catch (e) {
      console.warn('[render] email notify skipped', e?.message || e);
    }
  } catch (err) {
    await pool.query(
      `UPDATE projects SET status = 'failed', error_message = $2,
         render_progress = NULL, render_phase = NULL, updated_at = NOW() WHERE id = $1`,
      [projectId, String(err.message || err)]
    );
  } finally {
    clearInterval(hb);
  }
}
