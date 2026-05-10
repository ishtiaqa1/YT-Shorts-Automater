/** Human-readable labels for upload_diagnostics.metric */
export function metricHeadline(metric) {
  switch (metric) {
    case 'youtube_upload':
      return 'YouTube upload finished';
    case 'render_complete':
      return 'Video render finished';
    case 'render_started':
      return 'Video render started';
    case 'project_created':
      return 'New project created';
    case 'upload_scheduled':
      return 'YouTube publish scheduled';
    default:
      return metric.replace(/_/g, ' ');
  }
}

/**
 * @param {object} row - diagnostic row with value_json, metric, optional join fields
 */
export function metricDetailText(row) {
  const v = row.value_json;
  const metric = row.metric;
  if (metric === 'youtube_upload' && v && typeof v === 'object' && v.videoId) {
    const parts = [`Video ID ${v.videoId}`];
    if (row.youtube_video_id) parts.push('saved to your publish queue');
    return parts.join(' · ');
  }
  if (metric === 'render_complete' && v && typeof v === 'object') {
    const dur = v.durationSeconds != null ? ` · ${Number(v.durationSeconds).toFixed(1)}s` : '';
    const pid = v.projectId ? ` · project ${v.projectId}` : '';
    return `Output ready${dur}${pid}`;
  }
  if (metric === 'render_started' && v && typeof v === 'object') {
    return v.title ? `“${v.title}”` : v.projectId ? `Project ${v.projectId}` : '';
  }
  if (metric === 'project_created' && v && typeof v === 'object') {
    return v.title ? `“${String(v.title).slice(0, 120)}”` : '';
  }
  if (metric === 'upload_scheduled' && v && typeof v === 'object') {
    const bits = [];
    if (v.title) bits.push(`“${String(v.title).slice(0, 80)}”`);
    if (v.scheduledAt) bits.push(`publish ${v.scheduledAt}`);
    if (v.projectTitle) bits.push(`from “${String(v.projectTitle).slice(0, 60)}”`);
    return bits.join(' · ') || 'Scheduled a publish';
  }
  if (v == null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function parseValueJson(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try {
    return JSON.parse(String(v));
  } catch {
    return null;
  }
}

/**
 * @param {object[]} diagRows
 * @returns {object[]}
 */
export function buildActivityFeed(diagRows) {
  return diagRows.map((row) => {
    const v = parseValueJson(row.value_json);
    const projectId =
      v && typeof v === 'object' && v.projectId != null ? String(v.projectId) : null;
    return {
      id: row.id,
      at: row.recorded_at,
      kind: row.metric,
      headline: metricHeadline(row.metric),
      detail: metricDetailText({ ...row, value_json: v }),
      scheduled_upload_id: row.scheduled_upload_id,
      youtube_video_id: row.youtube_video_id ?? null,
      upload_status: row.upload_status ?? null,
      scheduled_at: row.scheduled_at ?? null,
      project_id: projectId,
    };
  });
}
