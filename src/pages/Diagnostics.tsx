import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ResponsiveContainer, BarChart, Bar, CartesianGrid, XAxis, YAxis, Tooltip } from 'recharts';
import { api, apiDeleteSchedule } from '../api';
import { describeYoutubeUploadError } from '../youtubeUploadErrors';
import { useAuth } from '../auth';

type ActivityRow = {
  id: string;
  at: string;
  kind: string;
  headline: string;
  detail: string;
  scheduled_upload_id: string | null;
  youtube_video_id: string | null;
  upload_status: string | null;
  scheduled_at: string | null;
  project_id: string | null;
};

type ScheduledRow = {
  id: string;
  project_id: string;
  youtube_video_id: string | null;
  tiktok_post_id?: string | null;
  platform?: string | null;
  scheduled_at: string;
  privacy_status: string | null;
  title: string | null;
  status: string;
  last_error: string | null;
  created_at: string;
  project_title: string | null;
  project_status: string | null;
};

type ChannelVideoRow = {
  video_id: string;
  title: string;
  published_at: string | null;
  privacy_status: string | null;
  duration_iso: string | null;
  from_shorts_studio: boolean;
  studio_schedule_status: string | null;
  studio_project_id: string | null;
  studio_project_title: string | null;
  scheduled_upload_id: string | null;
};

type ChannelVideosPayload = {
  ok: boolean;
  code?: string;
  message?: string | null;
  channel_title?: string | null;
  items: ChannelVideoRow[];
};

type RawEvent = {
  id: string;
  metric: string;
  value_json: unknown;
  recorded_at: string;
};

type AnalyticsSnap = { recorded_at: string; value_json: unknown };

function formatWhen(iso: string | null | undefined, timeZone: string) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(undefined, {
      timeZone: timeZone || 'UTC',
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return new Date(iso).toLocaleString();
  }
}

function statusBadgeClass(status: string) {
  if (status === 'uploaded' || status === 'ready') return 'badge ready';
  if (status === 'failed') return 'badge failed';
  if (status === 'rendering' || status === 'pending' || status === 'uploading') return 'badge rendering';
  return 'badge';
}

function latestMetricsByVideo(rows: AnalyticsSnap[]) {
  const latest = new Map<string, { video_id: string; views: number; likes: number }>();
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const r = rows[i];
    const j =
      typeof r.value_json === 'object' && r.value_json != null && !Array.isArray(r.value_json)
        ? (r.value_json as Record<string, unknown>)
        : {};
    const vid = String(j.videoId ?? j.video_id ?? '').trim();
    if (!vid || latest.has(vid)) continue;
    latest.set(vid, {
      video_id: vid.length > 10 ? `${vid.slice(0, 6)}…` : vid,
      views: Number(j.views) || 0,
      likes: Number(j.likes) || 0,
    });
  }
  return [...latest.values()].sort((a, b) => b.views - a.views).slice(0, 18);
}

export default function Diagnostics() {
  const { user } = useAuth();
  const tz = user?.timezone || 'UTC';
  const [loadErr, setLoadErr] = useState('');
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [summary, setSummary] = useState<{ status: string; n: number }[]>([]);
  const [scheduled, setScheduled] = useState<ScheduledRow[]>([]);
  const [channelVideos, setChannelVideos] = useState<ChannelVideosPayload | null>(null);
  const [rawEvents, setRawEvents] = useState<RawEvent[]>([]);
  const [analytics, setAnalytics] = useState<AnalyticsSnap[]>([]);
  const [scheduleRmErr, setScheduleRmErr] = useState('');
  const [rmScheduleId, setRmScheduleId] = useState<string | null>(null);
  const removingScheduleIdsRef = useRef(new Set<string>());

  const loadDiagnostics = useCallback(async () => {
    setLoadErr('');
    setScheduleRmErr('');
    try {
      const [d, a] = await Promise.all([
        api<{
          activity: ActivityRow[];
          upload_summary: { status: string; n: number }[];
          scheduled_uploads: ScheduledRow[];
          channel_videos: ChannelVideosPayload;
          events: RawEvent[];
        }>('/api/diagnostics'),
        api<{ snapshots: AnalyticsSnap[] }>('/api/diagnostics/analytics').catch(() => ({ snapshots: [] })),
      ]);
      setActivity(d.activity || []);
      setSummary(d.upload_summary || []);
      setScheduled(d.scheduled_uploads || []);
      setChannelVideos(d.channel_videos || { ok: false, items: [], message: null });
      setRawEvents(d.events || []);
      setAnalytics(a.snapshots || []);
    } catch {
      setLoadErr('Could not load diagnostics.');
    }
  }, []);

  useEffect(() => {
    void loadDiagnostics();
  }, [loadDiagnostics]);

  async function removeScheduledRow(s: ScheduledRow) {
    const sid = String(s.id);
    if (removingScheduleIdsRef.current.has(sid) || s.status === 'uploading') return;
    removingScheduleIdsRef.current.add(sid);

    const st = String(s.status || '').toLowerCase();
    const skipConfirm = st === 'failed' || st === 'pending';
    if (
      !skipConfirm &&
      !window.confirm(
        `Remove this scheduled row from the database?\n\n"${(s.title || s.project_title || 'Untitled').slice(0, 120)}"`
      )
    ) {
      removingScheduleIdsRef.current.delete(sid);
      return;
    }
    setScheduleRmErr('');
    setRmScheduleId(sid);
    try {
      await apiDeleteSchedule(sid);
      await loadDiagnostics();
    } catch (e) {
      setScheduleRmErr(e instanceof Error ? e.message : 'Could not remove schedule');
    } finally {
      removingScheduleIdsRef.current.delete(sid);
      setRmScheduleId(null);
    }
  }

  return (
    <div className="page">
      <header className="topbar">
        <h1>Diagnostics</h1>
        <Link to="/app">← App</Link>
      </header>

      <p className="hint diag-intro">
        Recent work in Shorts Studio and your YouTube channel. Times use your account timezone ({tz}). “From this
        app” means we recorded a successful scheduled upload with that video ID.
      </p>

      {loadErr && <p className="error">{loadErr}</p>}
      {scheduleRmErr ? <p className="error">{scheduleRmErr}</p> : null}

      <section className="card">
        <h2>YouTube Analytics snapshots</h2>
        <p className="hint">
          Latest synced metrics per video (requires Analytics scope + channel with uploads from this app; cron inserts
          rows into diagnostics).
        </p>
        {analytics.length === 0 ? (
          <p className="hint">No analytics rows yet.</p>
        ) : (
          <div style={{ width: '100%', height: 280 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={latestMetricsByVideo(analytics)}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                <XAxis dataKey="video_id" tick={{ fontSize: 10 }} angle={-20} height={54} interval={0} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Bar dataKey="views" fill="#f43f5e" radius={[4, 4, 0, 0]} name="Views" />
                <Bar dataKey="likes" fill="#818cf8" radius={[4, 4, 0, 0]} name="Likes" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>

      <section className="card">
        <h2>Publish queue summary</h2>
        <p className="hint">Counts of scheduled upload rows by status.</p>
        <ul className="diag-summary">
          {summary.length === 0 ? (
            <li>No scheduled uploads yet.</li>
          ) : (
            summary.map((s) => (
              <li key={s.status}>
                <span className={statusBadgeClass(s.status)}>{s.status}</span>
                <span className="diag-summary-n">{s.n}</span>
              </li>
            ))
          )}
        </ul>
      </section>

      <section className="card">
        <h2>Activity timeline</h2>
        <p className="hint">Renders, scheduling, uploads, and new projects (newest first).</p>
        {activity.length === 0 ? (
          <p className="hint">No activity logged yet. Create a project, render, or schedule a publish.</p>
        ) : (
          <ol className="diag-activity">
            {activity.map((a) => (
              <li key={a.id} className="diag-activity-item">
                <time className="diag-time" dateTime={a.at}>
                  {formatWhen(a.at, tz)}
                </time>
                <div className="diag-activity-body">
                  <div className="diag-headline">{a.headline}</div>
                  {a.detail ? <div className="diag-detail">{a.detail}</div> : null}
                  <div className="diag-links">
                    {a.project_id ? (
                      <Link to={`/app/project/${a.project_id}`}>Open project</Link>
                    ) : null}
                    {a.youtube_video_id ? (
                      <>
                        {a.project_id ? <span className="hint"> · </span> : null}
                        <a href={`https://www.youtube.com/watch?v=${encodeURIComponent(a.youtube_video_id)}`} target="_blank" rel="noreferrer">
                          Open on YouTube
                        </a>
                      </>
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="card">
        <h2>Scheduled uploads (detail)</h2>
        <p className="hint">
          Each row is a publish you set up from the editor. Successful runs show a YouTube video ID and/or a TikTok post
          ID. Use Remove to delete rows; <strong>failed</strong> and <strong>pending</strong> remove in one click (same
          as Calendar).
        </p>
        {scheduled.length === 0 ? (
          <p className="hint">None yet.</p>
        ) : (
          <div className="diag-table-wrap">
            <table className="data-table diag-table">
              <thead>
                <tr>
                  <th>Queued</th>
                  <th>Publish at</th>
                  <th>Project</th>
                  <th>Title</th>
                  <th>Platform</th>
                  <th>Status</th>
                  <th>Link</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {scheduled.map((s) => (
                  <tr key={s.id}>
                    <td>{formatWhen(s.created_at, tz)}</td>
                    <td>{formatWhen(s.scheduled_at, tz)}</td>
                    <td>
                      <Link to={`/app/project/${s.project_id}`}>{s.project_title || s.project_id.slice(0, 8)}</Link>
                      <div className="hint">Project status: {s.project_status}</div>
                    </td>
                    <td>{s.title || '—'}</td>
                    <td>{s.platform === 'tiktok' ? 'TikTok' : 'YouTube'}</td>
                    <td>
                      <span className={statusBadgeClass(s.status)}>{s.status}</span>
                      {s.last_error ? (
                        <div className="error diag-err">{describeYoutubeUploadError(s.last_error)}</div>
                      ) : null}
                    </td>
                    <td>
                      {s.youtube_video_id ? (
                        <a href={`https://www.youtube.com/watch?v=${encodeURIComponent(s.youtube_video_id)}`} target="_blank" rel="noreferrer">
                          YouTube
                        </a>
                      ) : null}
                      {s.tiktok_post_id ? (
                        <>
                          {s.youtube_video_id ? <span className="hint"> · </span> : null}
                          <a
                            href={`https://www.tiktok.com/video/${encodeURIComponent(s.tiktok_post_id)}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            TikTok
                          </a>
                        </>
                      ) : null}
                      {!s.youtube_video_id && !s.tiktok_post_id ? <span className="hint">—</span> : null}
                    </td>
                    <td>
                      {s.status === 'uploading' ? (
                        <span className="hint">—</span>
                      ) : (
                        <button
                          type="button"
                          className="secondary-btn"
                          style={{ fontSize: '0.82rem', padding: '0.25rem 0.5rem' }}
                          disabled={rmScheduleId === s.id}
                          onClick={() => void removeScheduledRow(s)}
                        >
                          {rmScheduleId === s.id ? 'Removing…' : 'Remove'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2>Recent videos on your channel</h2>
        {channelVideos && !channelVideos.ok ? (
          <p className="hint">{channelVideos.message || 'Could not load YouTube uploads.'}</p>
        ) : channelVideos && channelVideos.ok ? (
          <>
            {channelVideos.channel_title ? (
              <p className="hint">
                Channel: <strong>{channelVideos.channel_title}</strong> · up to {channelVideos.items.length} recent uploads
              </p>
            ) : null}
            {channelVideos.items.length === 0 ? (
              <p className="hint">No uploads returned (empty channel or API limit).</p>
            ) : (
              <div className="diag-table-wrap">
                <table className="data-table diag-table">
                  <thead>
                    <tr>
                      <th>Published</th>
                      <th>Title</th>
                      <th>Visibility</th>
                      <th>From Shorts Studio?</th>
                      <th>Project</th>
                    </tr>
                  </thead>
                  <tbody>
                    {channelVideos.items.map((v) => (
                      <tr key={v.video_id}>
                        <td>{formatWhen(v.published_at, tz)}</td>
                        <td>
                          <a href={`https://www.youtube.com/watch?v=${encodeURIComponent(v.video_id)}`} target="_blank" rel="noreferrer">
                            {v.title}
                          </a>
                          <div className="hint mono">{v.video_id}</div>
                        </td>
                        <td>{v.privacy_status || '—'}</td>
                        <td>
                          {v.from_shorts_studio ? (
                            <span className="badge ready">Yes — scheduled upload</span>
                          ) : (
                            <span className="diag-external">No — not linked to a completed publish from this app</span>
                          )}
                          {v.studio_schedule_status && !v.from_shorts_studio ? (
                            <div className="hint">Studio row status: {v.studio_schedule_status}</div>
                          ) : null}
                        </td>
                        <td>
                          {v.studio_project_id ? (
                            <Link to={`/app/project/${v.studio_project_id}`}>{v.studio_project_title || 'Open project'}</Link>
                          ) : (
                            <span className="hint">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : null}
      </section>

      <section className="card">
        <details className="diag-raw">
          <summary>Technical log (raw metrics)</summary>
          <p className="hint">For support; same data as the timeline above in machine-oriented form.</p>
          <div className="diag-table-wrap">
            <table className="data-table diag-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Metric</th>
                  <th>Payload</th>
                </tr>
              </thead>
              <tbody>
                {rawEvents.map((e) => (
                  <tr key={e.id}>
                    <td>{formatWhen(e.recorded_at, tz)}</td>
                    <td>
                      <code>{e.metric}</code>
                    </td>
                    <td>
                      <code>{JSON.stringify(e.value_json)}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </section>
    </div>
  );
}
