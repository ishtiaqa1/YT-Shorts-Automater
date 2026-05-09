import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, fetchAuthorizedBlob } from '../api';

type Project = {
  id: string;
  title: string;
  script_text: string;
  status: string;
  error_message: string | null;
  duration_seconds: number | null;
  background_asset_path?: string | null;
};

export default function Editor() {
  const { id } = useParams<{ id: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [scheduleAt, setScheduleAt] = useState('');
  const [uploadTitle, setUploadTitle] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [bgPresets, setBgPresets] = useState<string[]>([]);

  async function refresh() {
    if (!id) return;
    const data = await api<{ project: Project }>(`/api/projects/${id}`);
    setProject(data.project);
    setUploadTitle((t) => t || data.project.title);
  }

  useEffect(() => {
    api<{ presets: string[] }>('/api/projects/background-presets')
      .then((d) => setBgPresets(d.presets || []))
      .catch(() => setBgPresets([]));
  }, []);

  useEffect(() => {
    if (!id) return;
    refresh().catch((e) => setErr(String(e)));
    const t = setInterval(() => {
      refresh().catch(() => {});
    }, 4000);
    return () => clearInterval(t);
  }, [id]);

  useEffect(() => {
    if (!id || project?.status !== 'ready') {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
      setVideoUrl(null);
      return;
    }
    let revoked: string | null = null;
    fetchAuthorizedBlob(`/api/projects/${id}/file`)
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        revoked = url;
        setVideoUrl(url);
      })
      .catch(() => setVideoUrl(null));
    return () => {
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [id, project?.status]);

  async function uploadBg(file: File | null) {
    if (!id || !file) return;
    setErr('');
    const fd = new FormData();
    fd.append('file', file);
    try {
      await fetch(`/api/projects/${id}/background`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${localStorage.getItem('token')}`,
        },
        body: fd,
      }).then(async (r) => {
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error((j as { error?: string }).error || r.statusText);
        }
      });
      setMsg('Background saved. Re-render to apply.');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Upload failed');
    }
  }

  async function applyPreset(filename: string) {
    if (!id || !filename) return;
    setErr('');
    try {
      await api(`/api/projects/${id}/background-preset`, {
        method: 'POST',
        body: JSON.stringify({ filename }),
      });
      setMsg('Preset background saved. Re-render to apply.');
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Preset failed');
    }
  }

  async function renderNow() {
    if (!id) return;
    setErr('');
    try {
      await api(`/api/projects/${id}/render`, { method: 'POST' });
      setMsg('Render queued…');
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Render failed');
    }
  }

  async function schedule() {
    if (!id || !scheduleAt) return;
    setErr('');
    try {
      await api(`/api/projects/${id}/schedule`, {
        method: 'POST',
        body: JSON.stringify({
          scheduled_at: new Date(scheduleAt).toISOString(),
          title: uploadTitle || project?.title,
        }),
      });
      setMsg('Scheduled for YouTube upload job (requires connected channel).');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Schedule failed');
    }
  }

  if (!project) {
    return (
      <div className="editor">
        <p>Loading…</p>
        <Link to="/app">Back</Link>
      </div>
    );
  }

  return (
    <div className="editor">
      <header className="topbar">
        <Link to="/app">← Projects</Link>
        <h1>{project.title}</h1>
      </header>

      <div className="grid-2">
        <section className="card">
          <h2>Script</h2>
          <pre className="script-preview">{project.script_text}</pre>
          <p className="hint">
            Edit by creating a new project for now, or extend the API with PATCH later.
          </p>
        </section>

        <section className="card">
          <h2>Gameplay background</h2>
          <p className="hint">
            Drop bundled clips in <code>assets/gameplay/</code> as <code>.mp4</code> or <code>.webm</code>. Use
            simple filenames (letters, numbers, <code>_</code>, <code>-</code>, <code>.</code> only). Each render picks
            a random segment from long clips (short clips loop).
          </p>
          {bgPresets.length > 0 ? (
            <label>
              Bundled gameplay
              <select
                defaultValue=""
                onChange={(e) => {
                  const v = e.target.value;
                  e.target.value = '';
                  if (v) void applyPreset(v);
                }}
              >
                <option value="">Choose a clip…</option>
                {bgPresets.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="hint">No bundled clips yet — add files under assets/gameplay/</p>
          )}
          <p className="hint">Or upload your own file:</p>
          <input type="file" accept="video/*" onChange={(e) => uploadBg(e.target.files?.[0] || null)} />
          {project.background_asset_path ? (
            <p className="hint">
              Current background file set on server (render uses this path).
            </p>
          ) : null}
          <h2>Render</h2>
          <p>
            Status: <span className={`badge ${project.status}`}>{project.status}</span>
          </p>
          {project.error_message && <p className="error">{project.error_message}</p>}
          <button type="button" onClick={() => renderNow()}>
            Generate video
          </button>
        </section>
      </div>

      {videoUrl && (
        <section className="card preview">
          <h2>Preview</h2>
          <video src={videoUrl} controls playsInline className="short-preview" />
        </section>
      )}

      <section className="card">
        <h2>Schedule YouTube publish</h2>
        <p className="hint">
          Connect YouTube under Settings first. The API uploads your file and sets{' '}
          <code>publishAt</code> on YouTube when that time is far enough in the future.
        </p>
        <label>
          When to go public (your timezone)
          <input
            type="datetime-local"
            value={scheduleAt}
            onChange={(e) => setScheduleAt(e.target.value)}
          />
        </label>
        <label>
          Video title on YouTube
          <input value={uploadTitle} onChange={(e) => setUploadTitle(e.target.value)} />
        </label>
        <button type="button" onClick={() => schedule()}>
          Queue scheduled upload
        </button>
      </section>

      {msg && <p className="success">{msg}</p>}
      {err && <p className="error">{err}</p>}
    </div>
  );
}
