import { google } from 'googleapis';
import { getOAuthClient } from './youtubeUpload.js';

function fmtYmd(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * @param {{ refreshToken: string; channelId: string; videoId: string }} p
 */
export async function fetchVideoAnalyticsSnippet(p) {
  const oauth2 = getOAuthClient();
  oauth2.setCredentials({ refresh_token: p.refreshToken });
  const yt = google.youtubeAnalytics({ version: 'v2', auth: oauth2 });
  const end = new Date();
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - 28);

  const { data } = await yt.reports.query({
    ids: `channel==${p.channelId}`,
    startDate: fmtYmd(start),
    endDate: fmtYmd(end),
    metrics: 'views,estimatedMinutesWatched,averageViewDuration,likes,comments,shares',
    dimensions: 'video',
    filters: `video==${p.videoId}`,
    sort: '-views',
  });

  const rows = data.rows?.[0];
  const headers = data.columnHeaders?.map((h) => h.name) || [];
  if (!rows) {
    return { videoId: p.videoId, headers, values: {}, raw: data };
  }
  /** @type {Record<string, number>} */
  const values = {};
  headers.forEach((h, i) => {
    if (h !== 'video') values[h] = Number(rows[i]) || 0;
  });
  return { videoId: p.videoId, headers, values, raw: data };
}
