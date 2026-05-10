import { google } from 'googleapis';
import { pool } from '../db.js';
import { getOAuthClient } from './youtubeUpload.js';

/**
 * Recent uploads on the user's default YouTube channel, with whether each video
 * was published via Shorts Studio (scheduled_uploads.youtube_video_id match).
 */
export async function listRecentChannelVideosWithStudioFlag(userId, maxResults = 40) {
  const { rows: yc } = await pool.query(
    `SELECT refresh_token, channel_title FROM youtube_connections
     WHERE user_id = $1 AND is_default = true
     LIMIT 1`,
    [userId]
  );
  if (!yc[0]?.refresh_token) {
    return {
      ok: false,
      code: 'not_connected',
      channel_title: null,
      message: 'Connect a YouTube channel in Settings to list uploads and match them to this app.',
      items: [],
    };
  }

  try {
    const oauth2 = getOAuthClient();
    oauth2.setCredentials({ refresh_token: yc[0].refresh_token });
    const youtube = google.youtube({ version: 'v3', auth: oauth2 });

    const ch = await youtube.channels.list({ part: ['contentDetails', 'snippet'], mine: true });
    const uploadsPlaylistId = ch.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    const channelTitle = ch.data.items?.[0]?.snippet?.title || yc[0].channel_title || null;
    if (!uploadsPlaylistId) {
      return {
        ok: false,
        code: 'no_uploads_playlist',
        channel_title: channelTitle,
        message: 'Could not read the channel uploads playlist from YouTube.',
        items: [],
      };
    }

    const pl = await youtube.playlistItems.list({
      part: ['contentDetails', 'snippet'],
      playlistId: uploadsPlaylistId,
      maxResults: Math.min(50, maxResults),
    });

    const pairs = (pl.data.items || [])
      .map((i) => ({
        videoId: i.contentDetails?.videoId,
        playlistPublishedAt: i.snippet?.publishedAt,
      }))
      .filter((x) => x.videoId);

    const ids = pairs.map((p) => p.videoId);
    if (ids.length === 0) {
      return { ok: true, channel_title: channelTitle, message: null, items: [] };
    }

    const vid = await youtube.videos.list({
      part: ['snippet', 'status', 'contentDetails'],
      id: ids.join(','),
    });

    const { rows: linked } = await pool.query(
      `SELECT su.youtube_video_id, su.id AS scheduled_upload_id, su.status AS upload_status,
              su.created_at AS scheduled_created_at, su.scheduled_at,
              p.id AS project_id, p.title AS project_title
       FROM scheduled_uploads su
       JOIN projects p ON p.id = su.project_id
       WHERE su.user_id = $1 AND su.youtube_video_id = ANY($2::text[])`,
      [userId, ids]
    );
    const byVid = Object.fromEntries(linked.map((r) => [r.youtube_video_id, r]));

    const items = (vid.data.items || []).map((item) => {
      const id = item.id;
      const link = byVid[id];
      const uploadedViaScheduler = Boolean(link && link.upload_status === 'uploaded');
      return {
        video_id: id,
        title: item.snippet?.title || 'Untitled',
        published_at: item.snippet?.publishedAt,
        privacy_status: item.status?.privacyStatus,
        duration_iso: item.contentDetails?.duration,
        /** True when this video id was recorded after a successful Shorts Studio scheduled upload. */
        from_shorts_studio: uploadedViaScheduler,
        /** We had a schedule row for this id but it is not in uploaded state (rare). */
        studio_schedule_status: link?.upload_status || null,
        studio_project_id: link?.project_id || null,
        studio_project_title: link?.project_title || null,
        scheduled_upload_id: link?.scheduled_upload_id || null,
      };
    });

    items.sort((a, b) => {
      const ta = a.published_at ? new Date(a.published_at).getTime() : 0;
      const tb = b.published_at ? new Date(b.published_at).getTime() : 0;
      return tb - ta;
    });

    return { ok: true, channel_title: channelTitle, message: null, items };
  } catch (e) {
    return {
      ok: false,
      code: 'youtube_error',
      channel_title: null,
      message: String(e.message || e),
      items: [],
    };
  }
}
