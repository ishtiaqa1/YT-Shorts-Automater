import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, apiDeleteProject, getToken, resolveApiOrigin } from '../api';
import { useAuth } from '../auth';

type Project = {
  id: string;
  title: string;
  status: string;
  duration_seconds: number | null;
  updated_at: string;
  thumbnail_path?: string | null;
};

type RedditSubOption = { name: string; label: string };

export default function Dashboard() {
  const { user, logout, refreshUser } = useAuth();
  const navigate = useNavigate();
  const apiBase = useMemo(() => resolveApiOrigin(), []);

  const [projects, setProjects] = useState<Project[]>([]);
  const [projectType, setProjectType] = useState<'script' | 'ai' | 'reddit' | 'spoken'>('script');
  const [title, setTitle] = useState('');
  const [script, setScript] = useState('');
  const [aiTopic, setAiTopic] = useState('');
  const [redditLink, setRedditLink] = useState('');
  const [redditSubreddit, setRedditSubreddit] = useState('');
  const [redditSubOptions, setRedditSubOptions] = useState<RedditSubOption[]>([]);
  const [spokenTitle, setSpokenTitle] = useState('');
  const [spokenBgTheme, setSpokenBgTheme] = useState<'gameplay' | 'calm' | 'hype'>('gameplay');
  const [pickedAudioFile, setPickedAudioFile] = useState<File | null>(null);
  const [recordingBlob, setRecordingBlob] = useState<Blob | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  const [err, setErr] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [armedDeleteId, setArmedDeleteId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ subreddits: RedditSubOption[] }>('/api/generate/reddit/subreddits')
      .then((d) => {
        if (!cancelled && Array.isArray(d.subreddits)) setRedditSubOptions(d.subreddits);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(async () => {
    const data = await api<{ projects: Project[] }>('/api/projects');
    setProjects(data.projects);
  }, []);

  useEffect(() => {
    load().catch(() => setErr('Could not load projects'));
  }, [load]);

  const anyRendering = useMemo(() => projects.some((p) => p.status === 'rendering'), [projects]);
  useEffect(() => {
    if (!anyRendering) return undefined;
    const t = setInterval(() => {
      load().catch(() => {});
    }, 2500);
    return () => clearInterval(t);
  }, [anyRendering, load]);

  useEffect(() => {
    return () => {
      try {
        recorderRef.current?.stop();
      } catch {
        /* */
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  async function dismissOnboarding() {
    await api('/api/auth/me', { method: 'PATCH', body: JSON.stringify({ onboarding_completed: true }) });
    await refreshUser();
  }

  async function startRecording() {
    setErr('');
    streamRef.current?.getTracks().forEach((t) => t.stop());
    recorderRef.current = null;
    setRecordingBlob(null);
    chunksRef.current = [];
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : '';
      const mr = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      mr.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        const blob = new Blob(chunksRef.current, {
          type: mr.mimeType || 'audio/webm',
        });
        setRecordingBlob(blob);
        chunksRef.current = [];
        recorderRef.current = null;
        setIsRecording(false);
      };
      recorderRef.current = mr;
      mr.start(250);
      setIsRecording(true);
    } catch (ex) {
      setErr(
        ex instanceof Error
          ? ex.message
          : 'Microphone permission denied — allow access or upload an audio file instead.'
      );
    }
  }

  function stopRecording() {
    try {
      recorderRef.current?.stop();
    } catch {
      /* */
    }
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    setErr('');
    try {
      let projectId = '';
      if (projectType === 'spoken') {
        const token = getToken();
        const toSend = recordingBlob ?? pickedAudioFile;
        if (!toSend) {
          setErr('Record audio in the browser or choose an audio file to upload.');
          return;
        }
        const fd = new FormData();
        const name =
          recordingBlob !== null ? 'recording.webm' : pickedAudioFile?.name || 'recording.webm';
        fd.append('file', toSend, name);
        if (spokenTitle.trim()) fd.append('title', spokenTitle.trim());
        fd.append('background_theme', spokenBgTheme);
        const res = await fetch(`${apiBase}/api/generate/project/spoken`, {
          method: 'POST',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          body: fd,
        });
        const body = (await res.json().catch(() => ({}))) as { project?: { id: string }; error?: string };
        if (!res.ok) throw new Error(body.error || res.statusText);
        if (!body.project?.id) throw new Error('Invalid response');
        projectId = body.project.id;
      } else if (projectType === 'script') {
        const { project } = await api<{ project: { id: string } }>('/api/projects', {
          method: 'POST',
          body: JSON.stringify({ title, script_text: script }),
        });
        projectId = project.id;
      } else if (projectType === 'ai') {
        const { project } = await api<{ project: { id: string } }>('/api/generate/project/ai', {
          method: 'POST',
          body: JSON.stringify({ title, topic: aiTopic }),
        });
        projectId = project.id;
      } else {
        const { project } = await api<{ project: { id: string } }>('/api/generate/project/reddit', {
          method: 'POST',
          body: JSON.stringify({
            reddit_permalink: redditLink.trim() || null,
            reddit_subreddit: redditLink.trim() ? null : redditSubreddit.trim() || null,
          }),
        });
        projectId = project.id;
      }
      setTitle('');
      setScript('');
      setAiTopic('');
      setRedditLink('');
      setRedditSubreddit('');
      setSpokenTitle('');
      setPickedAudioFile(null);
      setRecordingBlob(null);
      await load();
      navigate(`/app/project/${projectId}`);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Error');
    }
  }

  async function deleteProject(id: string, title: string) {
    if (armedDeleteId !== id) {
      setArmedDeleteId(id);
      setErr(`Click Delete again to confirm deleting "${title}".`);
      return;
    }
    setArmedDeleteId(null);
    setErr('Deleting project...');
    setDeletingId(id);
    try {
      await apiDeleteProject(id);
      setErr('');
      await load();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Delete failed');
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="dashboard">
      {user?.onboarding_completed === false && (
        <div className="onboarding-backdrop">
          <div className="onboarding-modal card">
            <h2>Welcome to Shorts Studio</h2>
            <ol className="onboarding-list">
              <li>
                Paste a script, choose a bundled background theme or upload a temporary clip — then{' '}
                <strong>Generate video</strong>.
              </li>
              <li>
                Link YouTube under <Link to="/app/settings">Settings</Link>, then schedule from the editor.
              </li>
              <li>
                Use <Link to="/app/calendar">Calendar</Link> for a month view and weekday bulk scheduling.
              </li>
            </ol>
            <button type="button" onClick={() => void dismissOnboarding()}>
              Got it — don’t show again
            </button>
          </div>
        </div>
      )}
      <header className="topbar">
        <h1>Projects</h1>
        <nav>
          <Link to="/app/settings">YouTube & account</Link>
          <Link to="/app/billing">Billing</Link>
          <Link to="/app/diagnostics">Diagnostics</Link>
          <Link to="/app/calendar">Calendar</Link>
          <Link to="/app/templates">Templates</Link>
          <Link to="/app/admin">Admin</Link>
          <button type="button" className="linkish" onClick={() => logout()}>
            Sign out
          </button>
        </nav>
      </header>

      {err ? (
        <p className="error dashboard-alert" role="alert">
          {err}
        </p>
      ) : null}

      <form className="card" onSubmit={create}>
        <h2>New Short</h2>
        <label>
          Project type
          <select
            value={projectType}
            onChange={(e) =>
              setProjectType(e.target.value as 'script' | 'ai' | 'reddit' | 'spoken')
            }
          >
            <option value="script">Script provided by you</option>
            <option value="ai">AI-generated script</option>
            <option value="reddit">Reddit story</option>
            <option value="spoken">Speak your content (captions + auto background)</option>
          </select>
        </label>

        {projectType === 'script' && (
          <>
            <label>
              Title
              <input value={title} onChange={(e) => setTitle(e.target.value)} required />
            </label>
            <label>
              Script (spoken + captions)
              <textarea
                value={script}
                onChange={(e) => setScript(e.target.value)}
                required
                rows={6}
                placeholder="Your Short script..."
              />
            </label>
          </>
        )}

        {projectType === 'ai' && (
          <>
            <label>
              Optional title
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="If blank, topic is used" />
            </label>
            <label>
              Topic for AI
              <textarea
                value={aiTopic}
                onChange={(e) => setAiTopic(e.target.value)}
                required
                rows={4}
                placeholder="e.g. 5 habits that made me more productive in 30 days"
              />
            </label>
          </>
        )}

        {projectType === 'spoken' && (
          <>
            <p className="hint">
              Speak in your own voice — we transcribe it for burned-in captions, keep your uploaded audio as voiceover,
              and pick a <strong>random</strong> bundled clip from the theme you choose (Gameplay / Calm / Hype) when
              videos exist on the server under <code>assets/gameplay</code> or <code>assets/background_themes</code>.
              Transcription uses <strong>OpenAI Whisper</strong> when <code>OPENAI_API_KEY</code> is set; otherwise Gemini
              audio (<code>GEMINI_API_KEY</code>).
            </p>
            <label>
              Background theme (when bundled clips exist)
              <select
                value={spokenBgTheme}
                onChange={(e) =>
                  setSpokenBgTheme(e.target.value as 'gameplay' | 'calm' | 'hype')
                }
              >
                <option value="gameplay">Gameplay</option>
                <option value="calm">Calm</option>
                <option value="hype">Hype</option>
              </select>
            </label>
            <label>
              Optional title
              <input
                value={spokenTitle}
                onChange={(e) => setSpokenTitle(e.target.value)}
                placeholder="Otherwise we derive short title from the first spoken line"
              />
            </label>
            <div className="spoken-recorder-actions">
              <button type="button" className="secondary-btn" onClick={() => void startRecording()} disabled={isRecording}>
                Record
              </button>
              <button type="button" onClick={() => stopRecording()} disabled={!isRecording}>
                Stop
              </button>
            </div>
            {(recordingBlob || pickedAudioFile) && (
              <p className="hint">{recordingBlob ? 'Ready: browser recording' : `Ready file: ${pickedAudioFile?.name}`}</p>
            )}
            <label>
              Or upload speech audio (.webm, .mp3, .wav …)
              <input
                type="file"
                accept="audio/*,.webm,video/mp4,.mp4"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  setPickedAudioFile(f);
                  if (f) setRecordingBlob(null);
                }}
              />
            </label>
          </>
        )}

        {projectType === 'reddit' && (
          <>
            <p className="hint">
              Paste a Reddit post URL to use that thread, or leave the link blank and we will auto-pick a long text
              post. With a blank link, you can optionally limit auto-pick to one subreddit below; otherwise we rotate
              across story subs (nosleep, LetsNotMeet, TIFU, MaliciousCompliance, revenge tales, tech/retail tales,
              offmychest, confessions, AITA, and similar).
            </p>
            <label>
              Subreddit for auto-pick (optional)
              <select
                value={redditSubreddit}
                onChange={(e) => setRedditSubreddit(e.target.value)}
                disabled={Boolean(redditLink.trim())}
              >
                <option value="">Mix — any preset story sub</option>
                {redditSubOptions.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            {redditLink.trim() ? (
              <p className="hint">Clear the link above to use the subreddit filter.</p>
            ) : null}
            <label>
              Reddit link (optional)
              <input
                type="url"
                value={redditLink}
                onChange={(e) => setRedditLink(e.target.value)}
                placeholder="https://www.reddit.com/r/... (optional)"
              />
            </label>
          </>
        )}

        <button
          type="submit"
          disabled={
            (projectType === 'script' && (!title.trim() || !script.trim())) ||
            (projectType === 'ai' && !aiTopic.trim()) ||
            (projectType === 'spoken' && !recordingBlob && !pickedAudioFile)
          }
        >
          Create project
        </button>
      </form>

      <ul className="project-list">
        {projects.map((p) => (
          <li key={p.id} className="project-list-item">
            <Link to={`/app/project/${p.id}`}>
              <strong>{p.title}</strong>
              <span className={`badge ${p.status}`}>{p.status}</span>
              {p.thumbnail_path ? <span className="pill">thumb</span> : null}
              {p.duration_seconds != null && (
                <span className="meta">{p.duration_seconds.toFixed(1)}s</span>
              )}
            </Link>
            <button
              type="button"
              className="project-delete-btn danger-outline"
              disabled={deletingId === p.id}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                void deleteProject(p.id, p.title);
              }}
            >
              {deletingId === p.id ? 'Deleting…' : armedDeleteId === p.id ? 'Confirm delete' : 'Delete'}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
