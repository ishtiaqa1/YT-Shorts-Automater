import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, fetchAuthorizedBlob } from '../api';
import { useAuth } from '../auth';
import { CaptionLivePreview } from '../components/CaptionLivePreview';
import { cssHex } from '../captionColor';

type CaptionSettings = {
  fontSize: number;
  marginV: number;
  marginLR: number;
  outline: number;
  /** RRGGBB without '#' */
  primaryColor: string;
  outlineColor: string;
  shadow: number;
  maxWordsPerLine: number;
  maxWordsPerCue: number;
};

const DEFAULT_CAPTIONS: CaptionSettings = {
  fontSize: 28,
  marginV: 0,
  marginLR: 4,
  outline: 4,
  primaryColor: 'ffffff',
  outlineColor: '000000',
  shadow: 2,
  maxWordsPerLine: 5,
  maxWordsPerCue: 16,
};

type YtConn = {
  id: string;
  channel_id: string;
  channel_title: string | null;
  google_account_email: string | null;
  is_default: boolean;
};

type Project = {
  id: string;
  title: string;
  script_text: string;
  /** When set, burned-in subtitles use this text (timed to voiceover); NULL means use script_text. */
  caption_text?: string | null;
  status: string;
  error_message: string | null;
  duration_seconds: number | null;
  background_asset_path?: string | null;
  render_progress?: number | null;
  render_phase?: string | null;
  caption_settings?: Partial<CaptionSettings> | null;
};

function parseCaptionSettingsBlob(raw: Project['caption_settings']): Partial<CaptionSettings> | null {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw) as unknown;
      if (p != null && typeof p === 'object' && !Array.isArray(p)) return p as Partial<CaptionSettings>;
      return null;
    } catch {
      return null;
    }
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Partial<CaptionSettings>;
  return null;
}

function captionFromProject(p: Project | null): CaptionSettings {
  const o = parseCaptionSettingsBlob(p?.caption_settings ?? null);
  if (!o) return { ...DEFAULT_CAPTIONS };
  const oExt = o as Partial<CaptionSettings> & {
    maxCharsPerLine?: number;
    maxCharsPerCue?: number;
  };
  const merged: CaptionSettings = { ...DEFAULT_CAPTIONS, ...oExt };
  if (oExt.maxWordsPerLine === undefined && typeof oExt.maxCharsPerLine === 'number') {
    merged.maxWordsPerLine = Math.max(2, Math.round(oExt.maxCharsPerLine / 5));
  }
  if (oExt.maxWordsPerCue === undefined && typeof oExt.maxCharsPerCue === 'number') {
    merged.maxWordsPerCue = Math.max(4, Math.round(oExt.maxCharsPerCue / 7));
  }
  return merged;
}

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

/** Local calendar date YYYY-MM-DD for `<input type="date">`. */
function localDateStr(d: Date) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Local HH:mm for `<input type="time" step={60}>`. */
function localTimeStr(d: Date) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function defaultScheduleAhead(minutesAhead: number) {
  const d = new Date(Date.now() + minutesAhead * 60 * 1000);
  return { date: localDateStr(d), time: localTimeStr(d) };
}

export default function Editor() {
  const { user } = useAuth();
  const { id } = useParams<{ id: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [scriptDraft, setScriptDraft] = useState('');
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [scheduleDate, setScheduleDate] = useState('');
  const [scheduleTime, setScheduleTime] = useState('');
  const [uploadTitle, setUploadTitle] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [bgPresets, setBgPresets] = useState<string[]>([]);
  const [renderStartedAt, setRenderStartedAt] = useState<number | null>(null);
  const [captions, setCaptions] = useState<CaptionSettings>(DEFAULT_CAPTIONS);
  const [ytConnections, setYtConnections] = useState<YtConn[]>([]);
  const [scheduleYtConnId, setScheduleYtConnId] = useState('');
  const [captionWordsDraft, setCaptionWordsDraft] = useState('');
  /** Optional override for live preview only; empty = follow script / caption wording drafts */
  const [previewSample, setPreviewSample] = useState('');
  /** singleBeat = one timed cue like the MP4; fullScript = all cues stacked (differs from video) */
  const [captionPreviewMode, setCaptionPreviewMode] = useState<'singleBeat' | 'fullScript'>('singleBeat');

  async function refresh() {
    if (!id) return;
    const data = await api<{ project: Project }>(`/api/projects/${id}`);
    setProject(data.project);
    setUploadTitle((t) => t || data.project.title);
    setScriptDraft(data.project.script_text);
  }

  useEffect(() => {
    api<{ presets: string[] }>('/api/projects/background-presets')
      .then((d) => setBgPresets(d.presets || []))
      .catch(() => setBgPresets([]));
    api<{ connections: YtConn[] }>('/api/youtube/status')
      .then((d) => setYtConnections(d.connections || []))
      .catch(() => setYtConnections([]));
  }, []);

  useEffect(() => {
    if (!id) return;
    refresh().catch((e) => setErr(String(e)));
    const pollMs = project?.status === 'rendering' ? 1200 : 4000;
    const t = setInterval(() => {
      refresh().catch(() => {});
    }, pollMs);
    return () => clearInterval(t);
  }, [id, project?.status]);

  useEffect(() => {
    if (project?.status === 'rendering') {
      setRenderStartedAt((p) => p ?? Date.now());
    } else if (project?.status === 'ready' || project?.status === 'failed' || project?.status === 'draft') {
      setRenderStartedAt(null);
    }
  }, [project?.status]);

  const captionKey = project?.caption_settings ? JSON.stringify(project.caption_settings) : '';
  useEffect(() => {
    if (!project?.id) return;
    setCaptions(captionFromProject(project));
  }, [project?.id, captionKey]);

  useEffect(() => {
    if (!project || project.caption_text == null) return;
    setCaptionWordsDraft(project.caption_text);
  }, [project?.id, project?.caption_text]);

  useEffect(() => {
    if (!project || project.caption_text != null) return;
    setCaptionWordsDraft(project.script_text);
  }, [project?.id, project?.script_text, project?.caption_text]);

  useEffect(() => {
    if (!id) return;
    const { date, time } = defaultScheduleAhead(60);
    setScheduleDate(date);
    setScheduleTime(time);
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
      setMsg('');
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Render failed');
    }
  }

  const pct = Math.min(100, Math.max(0, project?.render_progress ?? 0));
  const phase = project?.render_phase || 'Working…';
  let etaLabel = '';
  if (project?.status === 'rendering' && renderStartedAt && pct >= 6) {
    const elapsedSec = (Date.now() - renderStartedAt) / 1000;
    const totalEst = (elapsedSec / pct) * 100;
    const left = Math.max(0, totalEst - elapsedSec);
    if (Number.isFinite(left) && left < 3600) {
      etaLabel =
        left < 60 ? `About ${Math.max(5, Math.round(left))}s remaining (estimate)` : `About ${Math.ceil(left / 60)} min remaining (estimate)`;
    }
  }

  async function saveCaptionSettings(next?: CaptionSettings) {
    if (!id) return;
    const payload = next ?? captions;
    setErr('');
    try {
      const { project: updated } = await api<{ project: Project }>(`/api/projects/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ caption_settings: payload }),
      });
      /** Keep project in sync so captionKey + useEffect match the saved server row (avoids reset to defaults). */
      setProject(updated);
      setMsg('Caption settings saved. Click Generate video again to burn in the new look.');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed');
    }
  }

  async function resetCaptionAppearance() {
    const reset = { ...DEFAULT_CAPTIONS };
    setCaptions(reset);
    await saveCaptionSettings(reset);
    setMsg('Caption appearance reset to defaults (saved). Re-render to apply.');
  }

  async function saveScript() {
    if (!id) return;
    setErr('');
    try {
      const { project: updated } = await api<{ project: Project }>(`/api/projects/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ script_text: scriptDraft }),
      });
      setProject(updated);
      setScriptDraft(updated.script_text);
      setMsg(
        updated.caption_text != null
          ? 'Script saved. Voiceover will follow this after you re-render. On-screen captions still use the separate caption wording until you update that box or turn off custom captions.'
          : 'Script saved. Generate video again to update voiceover and captions.'
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed');
    }
  }

  async function toggleCaptionOverride(enabled: boolean) {
    if (!id || !project) return;
    setErr('');
    try {
      if (enabled) {
        const { project: updated } = await api<{ project: Project }>(`/api/projects/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ caption_text: project.script_text }),
        });
        setProject(updated);
        setCaptionWordsDraft(updated.caption_text ?? updated.script_text);
        setMsg('Custom caption wording enabled (starts as a copy of your saved script). Edit below and save, then generate video.');
      } else {
        const { project: updated } = await api<{ project: Project }>(`/api/projects/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ caption_text: null }),
        });
        setProject(updated);
        setCaptionWordsDraft(updated.script_text);
        setMsg('On-screen captions will match the script again after you re-render.');
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Update failed');
    }
  }

  async function saveCaptionWordsOnly() {
    if (!id) return;
    setErr('');
    try {
      const { project: updated } = await api<{ project: Project }>(`/api/projects/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ caption_text: captionWordsDraft }),
      });
      setProject(updated);
      setCaptionWordsDraft(updated.caption_text ?? '');
      setMsg('Caption wording saved. Generate video again to burn in the updated on-screen text.');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed');
    }
  }

  function fillCaptionWordsFromSavedScript() {
    if (!project) return;
    setCaptionWordsDraft(project.script_text);
    setMsg('Caption editor filled from saved script — click Save caption wording to apply.');
  }

  async function downloadVideo() {
    if (!id || !project) return;
    setErr('');
    try {
      const blob = await fetchAuthorizedBlob(`/api/projects/${id}/file`);
      const safe = project.title.replace(/[^\w\s.-]+/g, '').trim().slice(0, 80) || 'short';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${safe}.mp4`;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Download failed');
    }
  }

  async function schedule() {
    if (!id) return;
    if (!scheduleDate || !scheduleTime) {
      setErr('Choose both a date and a time for the publish.');
      return;
    }
    const combinedLocal = `${scheduleDate}T${scheduleTime}`;
    const when = new Date(combinedLocal);
    if (Number.isNaN(when.getTime())) {
      setErr('That date and time could not be read. Check your inputs.');
      return;
    }
    const minPublish = Date.now() + 11 * 60 * 1000;
    if (when.getTime() < minPublish) {
      setErr('YouTube needs the publish time at least ~10 minutes in the future. Pick a later time.');
      return;
    }
    setErr('');
    try {
      await api(`/api/projects/${id}/schedule`, {
        method: 'POST',
        body: JSON.stringify({
          scheduled_at: when.toISOString(),
          title: uploadTitle || project?.title,
          ...(scheduleYtConnId ? { youtube_connection_id: scheduleYtConnId } : {}),
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

  const scheduleTz = user?.timezone || 'UTC';
  let schedulePreview = '';
  if (scheduleDate && scheduleTime) {
    const d = new Date(`${scheduleDate}T${scheduleTime}`);
    if (!Number.isNaN(d.getTime())) {
      try {
        schedulePreview = d.toLocaleString(undefined, {
          timeZone: scheduleTz,
          dateStyle: 'medium',
          timeStyle: 'short',
        });
      } catch {
        schedulePreview = d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
      }
    }
  }

  const todayLocal = localDateStr(new Date());

  const hasCaptionOverride = project?.caption_text != null;
  const livePreviewSource =
    previewSample.trim() ||
    (hasCaptionOverride ? captionWordsDraft : scriptDraft) ||
    'Caption preview';

  return (
    <div className="editor">
      <header className="topbar">
        <Link to="/app">← Projects</Link>
        <h1>{project.title}</h1>
      </header>

      <div className="grid-2">
        <section className="card">
          <h2>Script</h2>
          <p className="hint">
            This text drives <strong>voiceover</strong>. Save, then use <strong>Generate video</strong>. By default,
            on-screen captions follow the same saved script — use the <strong>Caption wording</strong> section below if
            subtitles should say something different.
          </p>
          <label>
            Script
            <textarea
              className="script-editor"
              value={scriptDraft}
              onChange={(e) => setScriptDraft(e.target.value)}
              rows={14}
              spellCheck
            />
          </label>
          <button type="button" onClick={() => void saveScript()}>
            Save script
          </button>
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
          {project.status === 'rendering' && (
            <div className="render-progress" aria-live="polite">
              <div className="render-progress-track">
                <div className="render-progress-fill" style={{ width: `${pct}%` }} />
              </div>
              <p className="render-progress-phase">{phase}</p>
              <p className="hint render-progress-meta">
                {pct}% complete
                {etaLabel ? ` · ${etaLabel}` : pct < 6 ? ' · Estimating time…' : ''}
              </p>
            </div>
          )}
          {project.error_message && <p className="error">{project.error_message}</p>}
          <button type="button" onClick={() => renderNow()} disabled={project.status === 'rendering'}>
            {project.status === 'rendering' ? 'Rendering…' : 'Generate video'}
          </button>
        </section>
      </div>

      <section className="card caption-words-card">
        <h2>Caption wording (on-screen)</h2>
        <p className="hint">
          Burned-in subtitles are generated from your wording and timed to the voiceover length. Leave this matching the
          script, or write shorter/cleaner lines for the screen only — voiceover still uses <strong>Script</strong>{' '}
          above.
        </p>
        <label className="caption-toggle">
          <input
            type="checkbox"
            checked={hasCaptionOverride}
            onChange={(e) => void toggleCaptionOverride(e.target.checked)}
          />
          <span>Use different wording for on-screen captions than for voiceover</span>
        </label>
        {hasCaptionOverride ? (
          <>
            <label>
              Words shown on video (editable)
              <textarea
                className="script-editor caption-words-editor"
                value={captionWordsDraft}
                onChange={(e) => setCaptionWordsDraft(e.target.value)}
                rows={10}
                spellCheck
              />
            </label>
            <div className="caption-words-actions">
              <button type="button" onClick={() => void saveCaptionWordsOnly()}>
                Save caption wording
              </button>
              <button type="button" className="secondary-btn" onClick={() => fillCaptionWordsFromSavedScript()}>
                Replace editor with saved script
              </button>
              <button type="button" className="linkish" onClick={() => void toggleCaptionOverride(false)}>
                Turn off — use script for captions again
              </button>
            </div>
          </>
        ) : (
          <p className="hint">
            Captions will match your saved script (same timing rules). Enable the option above to edit subtitle wording
            separately — or enable once to copy the script into the editor, then tweak.
          </p>
        )}
      </section>

      <section className="card caption-card caption-studio">
        <h2>Caption look — edit in the preview</h2>
        <p className="hint">
          Adjust the frame below; everything updates live. <strong>Save caption settings</strong> stores what you see,
          then <strong>Generate video</strong> burns it in. One beat is shown at a time (how the Short plays).
        </p>

        <div className="caption-preview-hero">
          <CaptionLivePreview captions={captions} previewText={livePreviewSource} mode={captionPreviewMode} />
          <label className="caption-preview-toggle caption-preview-toggle-inline">
            <input
              type="checkbox"
              checked={captionPreviewMode === 'fullScript'}
              onChange={(e) => setCaptionPreviewMode(e.target.checked ? 'fullScript' : 'singleBeat')}
            />
            <span>Show full script in preview (stacked; playback is one beat at a time)</span>
          </label>
        </div>

        <label>
          Preview line (optional — overrides script/caption wording below only for this frame)
          <textarea
            className="preview-sample-editor"
            value={previewSample}
            onChange={(e) => setPreviewSample(e.target.value)}
            rows={3}
            placeholder={
              hasCaptionOverride
                ? 'Empty = use Caption wording drafts. Or type lines to try wording here…'
                : 'Empty = use Script drafts. Or type lines to try wording here…'
            }
          />
        </label>
        {previewSample.trim() ? (
          <p className="hint">
            <button type="button" className="linkish" onClick={() => setPreviewSample('')}>
              Clear preview line
            </button>{' '}
            to follow Script / Caption wording again.
          </p>
        ) : null}

        <h3 className="caption-controls-title">Appearance (same as export)</h3>
        <div className="caption-controls caption-controls-grid">
          <label className="caption-color-field">
            Text color
            <input
              type="color"
              value={cssHex(captions.primaryColor)}
              onChange={(e) =>
                setCaptions((c) => ({ ...c, primaryColor: e.target.value.replace(/^#/, '').toLowerCase() }))
              }
            />
          </label>
          <label className="caption-color-field">
            Outline color
            <input
              type="color"
              value={cssHex(captions.outlineColor)}
              onChange={(e) =>
                setCaptions((c) => ({ ...c, outlineColor: e.target.value.replace(/^#/, '').toLowerCase() }))
              }
            />
          </label>
          <label>
            Drop shadow ({captions.shadow}) — depth behind the text (ASS-style)
            <input
              type="range"
              min={0}
              max={8}
              value={captions.shadow}
              onChange={(e) => setCaptions((c) => ({ ...c, shadow: Number(e.target.value) }))}
            />
          </label>
          <label>
            Font size ({captions.fontSize}px)
            <input
              type="range"
              min={14}
              max={52}
              value={captions.fontSize}
              onChange={(e) => setCaptions((c) => ({ ...c, fontSize: Number(e.target.value) }))}
            />
          </label>
          <label>
            Vertical nudge ({captions.marginV}px) — 0 = dead center
            <input
              type="range"
              min={0}
              max={120}
              value={captions.marginV}
              onChange={(e) => setCaptions((c) => ({ ...c, marginV: Number(e.target.value) }))}
            />
          </label>
          <label>
            Side inset ({captions.marginLR}px) — <strong>0</strong> uses almost full width; higher = more padding from
            edges (also tighter wrapping)
            <input
              type="range"
              min={0}
              max={220}
              value={captions.marginLR}
              onChange={(e) => setCaptions((c) => ({ ...c, marginLR: Number(e.target.value) }))}
            />
          </label>
          <label>
            Outline ({captions.outline})
            <input
              type="range"
              min={0}
              max={12}
              value={captions.outline}
              onChange={(e) => setCaptions((c) => ({ ...c, outline: Number(e.target.value) }))}
            />
          </label>
          <label>
            Words per line ({captions.maxWordsPerLine})
            <input
              type="range"
              min={2}
              max={16}
              value={captions.maxWordsPerLine}
              onChange={(e) => setCaptions((c) => ({ ...c, maxWordsPerLine: Number(e.target.value) }))}
            />
          </label>
          <label>
            Words per beat ({captions.maxWordsPerCue})
            <input
              type="range"
              min={4}
              max={80}
              value={captions.maxWordsPerCue}
              onChange={(e) => setCaptions((c) => ({ ...c, maxWordsPerCue: Number(e.target.value) }))}
            />
          </label>
        </div>
        <p className="hint caption-controls-foot">
          Long lines still wrap early if they would exceed the usable width for your font size and side inset (matches
          FFmpeg).
        </p>
        <div className="caption-actions">
          <button type="button" className="secondary-btn" onClick={() => void saveCaptionSettings()}>
            Save caption settings
          </button>
          <button type="button" className="linkish" onClick={() => void resetCaptionAppearance()}>
            Reset to defaults
          </button>
        </div>
      </section>

      {videoUrl && (
        <section className="card preview">
          <h2>Exported video preview</h2>
          <p className="hint">
            This file is the <strong>last render</strong> (voiceover + captions baked in). It will not change until you
            click Generate video again. Tune captions in <strong>Caption look — edit in the preview</strong> first,
            then re-export when it looks right.
          </p>
          <div className="preview-toolbar">
            <button type="button" onClick={() => void downloadVideo()}>
              Download MP4
            </button>
          </div>
          <video src={videoUrl} controls playsInline className="short-preview" />
        </section>
      )}

      <section className="card">
        <h2>Schedule YouTube publish</h2>
        <p className="hint">
          Connect channels under <Link to="/app/settings">Settings</Link>. Pick date and time in{' '}
          <strong>your computer’s local timezone</strong>; we send that moment to YouTube. Preview below shows the same
          instant in your account timezone ({scheduleTz}) — change it in Settings if labels look wrong.
        </p>
        {ytConnections.length === 0 ? (
          <p className="hint">
            No YouTube channels linked. <Link to="/app/settings">Open Settings</Link> to connect Google.
          </p>
        ) : (
          <label>
            Upload with channel
            <select value={scheduleYtConnId} onChange={(e) => setScheduleYtConnId(e.target.value)}>
              <option value="">Default channel (see Settings)</option>
              {ytConnections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.channel_title || 'Channel'} {c.google_account_email ? `(${c.google_account_email})` : ''}
                  {c.is_default ? ' — default' : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="schedule-datetime">
          <label>
            Date (local)
            <input type="date" value={scheduleDate} min={todayLocal} onChange={(e) => setScheduleDate(e.target.value)} />
          </label>
          <label>
            Time (local)
            <input
              type="time"
              step={60}
              value={scheduleTime}
              onChange={(e) => setScheduleTime(e.target.value)}
            />
          </label>
        </div>
        {schedulePreview ? (
          <p className="hint">
            Same moment as: <strong>{schedulePreview}</strong> ({scheduleTz})
          </p>
        ) : (
          <p className="hint">Choose a date and time above. YouTube requires at least ~10 minutes lead time.</p>
        )}
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
