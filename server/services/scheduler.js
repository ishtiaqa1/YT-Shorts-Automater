import cron from 'node-cron';
import { existsSync } from 'fs';
import { pool } from '../db.js';
import { basename } from 'path';
import {
  uploadVideo,
  isYouTubeQuotaOrRateLimitError,
  clipYoutubeVideoTitle,
  youtubeShortsMultipartTitle,
  stripYoutubeMultipartTitleSuffix,
  parseMultipartPartMetaFromDescription,
} from './youtubeUpload.js';
import { mailUploadSuccess, mailUploadFailed } from './email.js';
import { appPublicOrigin } from '../appPublicUrl.js';
import { pickYoutubeConnectionIdSql } from '../youtubeConnectionPickSql.js';
import { pickTiktokConnectionIdSql } from '../tiktokConnectionPickSql.js';
import {
  refreshTiktokAccessToken,
  queryCreatorInfo,
  pickTiktokPrivacyLevel,
  clipTiktokCaption,
  directPostVideoFile,
  waitForTiktokPublish,
  tiktokPublicVideoUrl,
  isTiktokRateLimitError,
} from './tiktokUpload.js';
import {
  appendHashtagsToYoutubeDescription,
  buildYoutubeSnippetTags,
} from '../../shared/sourcePublishMeta.js';

let uploadSchedulerStarted = false;

function youtubeWatchUrl(videoId) {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

function buildYoutubeDescription(scheduledDesc, scriptSnippet, redditPermalink, sourceType) {
  let desc = scheduledDesc?.trim()
    ? String(scheduledDesc)
    : typeof scriptSnippet === 'string'
      ? scriptSnippet.slice(0, 4000)
      : '';
  if (sourceType === 'reddit' && redditPermalink) {
    const line = `\n\nSource / discussion:\n${redditPermalink}`;
    const maxLen = 4900;
    if (desc.length + line.length > maxLen) {
      desc = desc.slice(0, Math.max(0, maxLen - line.length)).trimEnd() + line;
    } else {
      desc += line;
    }
  }
  return appendHashtagsToYoutubeDescription(desc, {
    sourceType,
    redditPermalink,
    scriptText: scriptSnippet,
  });
}

/** node-pg may return `Date` or ISO `string` for `TIMESTAMPTZ` depending on config. */
function scheduledAtToIso(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString();
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error('Invalid scheduled_at on upload row');
  return d.toISOString();
}

/** Stop retrying rate-limited TikTok uploads after this many deferrals. */
const MAX_TIKTOK_RATE_LIMIT_RETRIES = 20;

/** Stop retrying rate-limited uploads after this many deferrals (then mark failed). */
const MAX_YOUTUBE_RATE_LIMIT_RETRIES = 25;

function rateLimitBackoffMs(retriesSoFar) {
  const step = Math.min(Math.max(0, Number(retriesSoFar) || 0), 10);
  return Math.min(15 * 60 * 1000 * 2 ** step, 6 * 60 * 60 * 1000);
}

/**
 * Claim jobs whose publish time is soon (we start the YouTube upload **before** `scheduled_at`
 * so the file can finish transferring before go-live). Do not resurrect very old missed rows.
 */
async function claimPendingUploadJobs(client) {
  const { rows: locked } = await client.query(`
    SELECT su.id
    FROM scheduled_uploads su
    INNER JOIN projects p ON p.id = su.project_id
    INNER JOIN users u ON u.id = su.user_id
    WHERE su.status = 'pending'
      AND (su.retry_after IS NULL OR su.retry_after <= NOW())
      AND su.scheduled_at <= NOW() + interval '60 minutes'
      AND su.scheduled_at >= NOW() - interval '36 hours'
      AND (su.output_video_path IS NOT NULL OR p.output_video_path IS NOT NULL)
      AND p.status = 'ready'
    ORDER BY su.upload_priority DESC, su.scheduled_at ASC
    LIMIT 5
    FOR UPDATE OF su SKIP LOCKED
  `);
  if (!locked.length) return [];
  const ids = locked.map((r) => r.id);
  const { rows: updated } = await client.query(
    `UPDATE scheduled_uploads
     SET status = 'uploading', updated_at = NOW()
     WHERE id = ANY($1::uuid[]) AND status = 'pending'
     RETURNING id`,
    [ids]
  );
  return updated.map((r) => r.id);
}

export function startUploadScheduler() {
  if (uploadSchedulerStarted) {
    console.warn('[scheduler] startUploadScheduler called again — ignoring (avoid duplicate crons)');
    return;
  }
  uploadSchedulerStarted = true;

  const originBase = () => appPublicOrigin() || '';
  let tickBusy = false;

  cron.schedule('* * * * *', async () => {
    if (tickBusy) return;
    tickBusy = true;
    /** Rows to upload after we release `tickBusy` — never hold the mutex across YouTube I/O or a stuck upload would block all future ticks (stale cleanup, other jobs). */
    let rows = [];
    let claimedIds = [];
    try {
      await pool.query(
        `UPDATE scheduled_uploads
         SET status = 'failed',
             last_error = $1,
             updated_at = NOW()
         WHERE status = 'uploading'
           AND scheduled_at <= NOW()
           AND updated_at < NOW() - interval '4 hours'`,
        [
          'Upload exceeded time limit (worker may have crashed or the connection stalled). Create a new schedule from the editor if you still need this publish.',
        ]
      );

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        claimedIds = await claimPendingUploadJobs(client);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[scheduler] claim transaction failed', e?.message || e);
        claimedIds = [];
      } finally {
        client.release();
      }

      if (!claimedIds.length) return;

      const yPick = pickYoutubeConnectionIdSql('su');
      const tPick = pickTiktokConnectionIdSql('su');
      const sel = await pool.query(
        `SELECT su.*, p.output_video_path AS project_output_video_path, p.title AS project_title, p.script_text,
                p.thumbnail_path, p.reddit_permalink, p.source_type, p.voice_source,
                u.email AS user_email,
                y.refresh_token,
                t.refresh_token AS tiktok_refresh_token,
                t.id AS tiktok_conn_row_id
         FROM scheduled_uploads su
         JOIN projects p ON p.id = su.project_id
         JOIN users u ON u.id = su.user_id
         LEFT JOIN youtube_connections y ON y.id = ${yPick} AND COALESCE(su.platform, 'youtube') = 'youtube'
         LEFT JOIN tiktok_connections t ON t.id = ${tPick} AND su.platform = 'tiktok'
         WHERE su.id = ANY($1::uuid[])`,
        [claimedIds]
      );
      rows = sel.rows;

      const seen = new Set(rows.map((r) => String(r.id)));
      for (const id of claimedIds) {
        if (!seen.has(String(id))) {
          await pool.query(
            `UPDATE scheduled_uploads SET status = 'failed', last_error = $2, updated_at = NOW() WHERE id = $1`,
            [id, 'Could not load schedule row after claim (project missing or DB inconsistency).']
          );
        }
      }
    } catch (e) {
      console.error('[scheduler] tick error', e?.message || e);
    } finally {
      tickBusy = false;
    }

    for (const row of rows) {
      const filePath =
        typeof row.output_video_path === 'string' && row.output_video_path.trim().length > 0
          ? row.output_video_path.trim()
          : row.project_output_video_path;

      if (!filePath) {
        await pool.query(
          `UPDATE scheduled_uploads SET status = 'failed', last_error = $2, updated_at = NOW() WHERE id = $1`,
          [row.id, 'Missing rendered video path on schedule row and project.']
        );
        continue;
      }

      if (!existsSync(filePath)) {
        await pool.query(
          `UPDATE scheduled_uploads SET status = 'failed', last_error = $2, updated_at = NOW() WHERE id = $1`,
          [
            row.id,
            `Rendered video file is missing on disk — open the project and render again. (${filePath})`,
          ]
        );
        continue;
      }

      const platform = row.platform === 'tiktok' ? 'tiktok' : 'youtube';
      if (platform === 'youtube' && !row.refresh_token) {
        await pool.query(
          `UPDATE scheduled_uploads SET status = 'failed', last_error = $2, updated_at = NOW() WHERE id = $1`,
          [
            row.id,
            'Missing YouTube channel (connect in Settings, set a default channel, or pick a channel when scheduling).',
          ]
        );
        continue;
      }
      if (platform === 'tiktok' && !row.tiktok_refresh_token) {
        await pool.query(
          `UPDATE scheduled_uploads SET status = 'failed', last_error = $2, updated_at = NOW() WHERE id = $1`,
          [
            row.id,
            'Missing TikTok account (connect TikTok under Settings, or pick an account when scheduling).',
          ]
        );
        continue;
      }

      const partMeta = parseMultipartPartMetaFromDescription(row.description);
      const rawTitle = row.title || row.project_title || 'Short';
      const titleFallback = row.project_title || basename(filePath) || 'Short';
      const uploadTitle =
        partMeta && partMeta.total > 1
          ? youtubeShortsMultipartTitle(
              stripYoutubeMultipartTitleSuffix(rawTitle) ||
                stripYoutubeMultipartTitleSuffix(row.project_title) ||
                row.project_title ||
                'Short',
              partMeta.index,
              partMeta.total,
              titleFallback
            )
          : clipYoutubeVideoTitle(rawTitle, basename(filePath));

      try {
        if (platform === 'tiktok') {
          console.log('[scheduler] tiktok upload start', row.id, row.title || row.project_title);
          const refreshed = await refreshTiktokAccessToken(row.tiktok_refresh_token);
          const expAt = new Date(Date.now() + Math.max(120, Number(refreshed.expires_in) || 86400) * 1000);
          if (row.tiktok_conn_row_id) {
            await pool.query(
              `UPDATE tiktok_connections SET access_token = $1, refresh_token = $2, access_token_expires_at = $3, updated_at = NOW()
               WHERE id = $4`,
              [refreshed.access_token, refreshed.refresh_token, expAt, row.tiktok_conn_row_id]
            );
          }
          const creator = await queryCreatorInfo(refreshed.access_token);
          const privacy = pickTiktokPrivacyLevel(creator.privacy_level_options, row.privacy_status || 'private');
          const capParts = [uploadTitle];
          if (typeof row.description === 'string' && row.description.trim()) {
            capParts.push(row.description.trim());
          }
          const tiktokCaption = clipTiktokCaption(capParts.join('\n\n'));
          const { publish_id } = await directPostVideoFile({
            accessToken: refreshed.access_token,
            filePath,
            title: tiktokCaption,
            privacyLevel: privacy,
            markAiGenerated: String(row.voice_source || '').toLowerCase() === 'ai',
          });
          await pool.query(
            `UPDATE scheduled_uploads SET tiktok_publish_id = $2, updated_at = NOW() WHERE id = $1`,
            [row.id, publish_id]
          );
          const done = await waitForTiktokPublish(refreshed.access_token, publish_id, { maxMs: 10 * 60 * 1000 });
          const postId = done.post_id;
          console.log('[scheduler] tiktok upload done', row.id, publish_id, postId || '');
          await pool.query(
            `UPDATE scheduled_uploads SET status = 'uploaded', tiktok_post_id = COALESCE($2, tiktok_post_id),
                tiktok_publish_id = NULL, last_error = NULL, retry_after = NULL, updated_at = NOW() WHERE id = $1`,
            [row.id, postId]
          );
          await pool.query(
            `INSERT INTO upload_diagnostics (scheduled_upload_id, user_id, metric, value_json)
             VALUES ($1, $2, 'tiktok_upload', $3::jsonb)`,
            [row.id, row.user_id, JSON.stringify({ publishId: publish_id, postId })]
          );
          const vidUrl = postId ? tiktokPublicVideoUrl(postId) : '';
          const projUrl = `${originBase().replace(/\/+$/, '')}/app/project/${row.project_id}`;
          if (row.user_email && String(row.user_email).includes('@')) {
            await mailUploadSuccess(
              row.user_email,
              row.title || row.project_title || 'Short',
              vidUrl,
              'TikTok'
            ).catch((e) => console.warn('[mail]', e));
          }
        } else {
          console.log('[scheduler] youtube upload start', row.id, row.title || row.project_title);
          const publishAt = scheduledAtToIso(row.scheduled_at);
          const description = buildYoutubeDescription(
            row.description,
            row.script_text,
            row.reddit_permalink,
            row.source_type
          );
          const thumb =
            typeof row.thumbnail_path === 'string' && existsSync(row.thumbnail_path)
              ? row.thumbnail_path
              : undefined;
          const up = await uploadVideo({
            refreshToken: row.refresh_token,
            filePath,
            title: uploadTitle,
            description,
            tags: buildYoutubeSnippetTags(Array.isArray(row.tags) ? row.tags : [], {
              sourceType: row.source_type,
              redditPermalink: row.reddit_permalink,
              scriptText: row.script_text,
            }),
            privacyStatus: row.privacy_status || 'private',
            publishAt,
            thumbnailPath: thumb,
          });

          if (!up?.id) {
            throw new Error('YouTube API returned no video id after insert');
          }

          console.log('[scheduler] youtube upload done', row.id, up.id);

          await pool.query(
            `UPDATE scheduled_uploads SET status = 'uploaded', youtube_video_id = $2, last_error = NULL,
                retry_after = NULL, updated_at = NOW() WHERE id = $1`,
            [row.id, up.id]
          );

          await pool.query(
            `INSERT INTO upload_diagnostics (scheduled_upload_id, user_id, metric, value_json)
             VALUES ($1, $2, 'youtube_upload', $3::jsonb)`,
            [row.id, row.user_id, JSON.stringify({ videoId: up.id })]
          );

          const vidUrl = youtubeWatchUrl(up.id);
          if (row.user_email && String(row.user_email).includes('@')) {
            await mailUploadSuccess(row.user_email, row.title || row.project_title || 'Short', vidUrl, 'YouTube').catch(
              (e) => console.warn('[mail]', e)
            );
          }
        }
      } catch (e) {
        console.error('[scheduler] upload failed', row.id, e?.message || e);
        const msg = String(e?.message || e);
        const rateLimited =
          platform === 'tiktok'
            ? isTiktokRateLimitError(e)
            : e?.youtubeRateLimited === true || isYouTubeQuotaOrRateLimitError(e);
        const prevRetries = Number(row.rate_limit_retries ?? 0);
        const maxRetries =
          platform === 'tiktok' ? MAX_TIKTOK_RATE_LIMIT_RETRIES : MAX_YOUTUBE_RATE_LIMIT_RETRIES;
        const label = platform === 'tiktok' ? 'TikTok' : 'YouTube';

        if (rateLimited) {
          if (prevRetries >= maxRetries) {
            const finalMsg = `${msg.slice(0, 3500)} (Stopped after ${maxRetries} ${label} rate-limit retries — try scheduling again later.)`;
            await pool.query(
              `UPDATE scheduled_uploads SET status = 'failed', last_error = $2, updated_at = NOW() WHERE id = $1`,
              [row.id, finalMsg]
            );
            const projUrl = `${originBase().replace(/\/+$/, '')}/app/project/${row.project_id}`;
            if (row.user_email && String(row.user_email).includes('@')) {
              await mailUploadFailed(
                row.user_email,
                row.title || row.project_title || 'Short',
                finalMsg,
                projUrl
              ).catch(() => {});
            }
            continue;
          }

          const backoff = rateLimitBackoffMs(prevRetries);
          const retryAfter = new Date(Date.now() + backoff);
          await pool.query(
            `UPDATE scheduled_uploads
             SET status = 'pending',
                 last_error = $2,
                 upload_priority = COALESCE(upload_priority, 0) + 100,
                 rate_limit_retries = COALESCE(rate_limit_retries, 0) + 1,
                 retry_after = $3,
                 updated_at = NOW()
             WHERE id = $1`,
            [row.id, msg, retryAfter]
          );
          console.warn(
            `[scheduler] ${label} rate limit — deferred retry`,
            row.id,
            'after',
            retryAfter.toISOString(),
            `attempt ${prevRetries + 1}/${maxRetries}`
          );
          await pool.query(
            `INSERT INTO upload_diagnostics (scheduled_upload_id, user_id, metric, value_json)
             VALUES ($1, $2, $3, $4::jsonb)`,
            [
              row.id,
              row.user_id,
              platform === 'tiktok' ? 'tiktok_upload_rate_limited' : 'youtube_upload_rate_limited',
              JSON.stringify({
                retryAfter: retryAfter.toISOString(),
                attempt: prevRetries + 1,
                error: msg.slice(0, 2000),
              }),
            ]
          );
          continue;
        }

        await pool.query(
          `UPDATE scheduled_uploads SET status = 'failed', last_error = $2, updated_at = NOW() WHERE id = $1`,
          [row.id, msg]
        );
        const projUrl = `${originBase().replace(/\/+$/, '')}/app/project/${row.project_id}`;
        if (row.user_email && String(row.user_email).includes('@')) {
          await mailUploadFailed(
            row.user_email,
            row.title || row.project_title || 'Short',
            msg,
            projUrl
          ).catch(() => {});
        }
      }
    }
  });
}
