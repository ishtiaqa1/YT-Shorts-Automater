import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { DateTime } from 'luxon';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, apiDeleteProject, ApiHttpError, fetchAuthorizedBlob } from '../api';
import { useAuth } from '../auth';
import { CaptionLivePreview } from '../components/CaptionLivePreview';
import { combineTitleBeforeStory } from '../lib/spokenScript';
import { cssHex } from '../captionColor';

/** Same per-part ceiling as `YOUTUBE_SHORT_SEGMENT_TARGET_SEC` in server/services/splitVideoForShorts.js */
const YT_SHORT_PART_CHUNK_SEC = 3 * 60 - 6;

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

const CAPTION_STYLE_OPTIONS = [
  { value: 'bold_pop', label: 'Bold pop' },
  { value: 'clean_minimal', label: 'Clean minimal' },
  { value: 'neon_glow', label: 'Neon glow' },
  { value: 'outlined', label: 'Outlined' },
  { value: 'typewriter', label: 'Typewriter' },
] as const;

const DEFAULT_CAPTIONS: CaptionSettings = {
  fontSize: 14,
  marginV: 0,
  marginLR: 0,
  outline: 4,
  primaryColor: 'ffffff',
  outlineColor: '000000',
  shadow: 2,
  maxWordsPerLine: 5,
  maxWordsPerCue: 12,
};

type YtConn = {
  id: string;
  channel_id: string;
  channel_title: string | null;
  google_account_email: string | null;
  is_default: boolean;
};

type TtConn = {
  id: string;
  open_id: string;
  creator_username: string | null;
  creator_nickname: string | null;
  is_default: boolean;
};

type BgThemeRow = {
  id: string;
  label: string;
  clip_count: number;
};

function isUserUploadedBackgroundPath(path: string | null | undefined): boolean {
  if (!path || typeof path !== 'string') return false;
  return /[/\\]user_bg[/\\]/.test(path);
}

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
  background_theme?: string | null;
  thumbnail_path?: string | null;
  reddit_permalink?: string | null;
  source_type?: string | null;
  music_track?: string | null;
  music_volume?: number | null;
  voice_source?: 'ai' | 'uploaded' | null;
  voice_asset_path?: string | null;
  youtube_connection_id?: string | null;
  tiktok_connection_id?: string | null;
  upload_dest_youtube?: boolean | null;
  upload_dest_tiktok?: boolean | null;
  render_progress?: number | null;
  render_phase?: string | null;
  caption_style?: string | null;
  caption_settings?: Partial<CaptionSettings> | null;
  /** Server row version — used to sync caption form only when saved data actually changed (avoids polling reset). */
  updated_at?: string | null;
  /** Bumped on each successful render; used with `last_queued_output_revision` to avoid duplicate queue runs. */
  output_revision?: number | null;
  /** Last `output_revision` that was committed to the upload calendar for this project. */
  last_queued_output_revision?: number | null;
  /** When false, render skips burned-in subtitles (voice + video only). */
  burn_captions?: boolean | null;
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

/** Fingerprint normalized caption UI state so JSON key reorder from Postgres never looks like an update. */
function stableCaptionSettingsSignature(raw: Project['caption_settings'] | null | undefined): string {
  const merged = captionFromProject({ caption_settings: raw ?? null } as Project);
  const keys = (Object.keys(merged) as (keyof CaptionSettings)[]).sort();
  return JSON.stringify(Object.fromEntries(keys.map((k) => [k, merged[k]])));
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

/** IANA zone for `<input type="date|time">` values (matches browser “local” wall clock). */
function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function defaultScheduleAhead(minutesAhead: number) {
  const d = new Date(Date.now() + minutesAhead * 60 * 1000);
  return { date: localDateStr(d), time: localTimeStr(d) };
}

export default function Editor() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [scriptDraft, setScriptDraft] = useState('');
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [scheduleDate, setScheduleDate] = useState('');
  const [scheduleTime, setScheduleTime] = useState('');
  const [uploadTitle, setUploadTitle] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [bgThemes, setBgThemes] = useState<BgThemeRow[]>([]);
  const [bgUploadBusy, setBgUploadBusy] = useState(false);
  const bgFileRef = useRef<HTMLInputElement>(null);
  /** Wall time when `render_progress` first reached the FFmpeg encode band (70–99); used for ETA only. */
  const encodePhaseEnteredAtRef = useRef<number | null>(null);
  const [captions, setCaptions] = useState<CaptionSettings>(DEFAULT_CAPTIONS);
  const [ytConnections, setYtConnections] = useState<YtConn[]>([]);
  const [ttConnections, setTtConnections] = useState<TtConn[]>([]);
  const [scheduleYtConnId, setScheduleYtConnId] = useState('');
  const [scheduleTtConnId, setScheduleTtConnId] = useState('');
  const [captionWordsDraft, setCaptionWordsDraft] = useState('');
  /** Optional override for live preview only; empty = follow script / caption wording drafts */
  const [previewSample, setPreviewSample] = useState('');
  /** singleBeat = one timed cue like the MP4; fullScript = all cues stacked (differs from video) */
  const [captionPreviewMode, setCaptionPreviewMode] = useState<'singleBeat' | 'fullScript'>('singleBeat');
  const [captionStyle, setCaptionStyle] = useState<string>('bold_pop');
  const [musicTracks, setMusicTracks] = useState<string[]>([]);
  const [musicDraft, setMusicDraft] = useState<string>('');
  const [musicVolDraft, setMusicVolDraft] = useState<number>(0.15);
  const [voiceSourceDraft, setVoiceSourceDraft] = useState<'ai' | 'uploaded'>('ai');
  const [redditDraft, setRedditDraft] = useState('');
  const [aiTopic, setAiTopic] = useState('');
  const [thumbObjectUrl, setThumbObjectUrl] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [scheduleBusy, setScheduleBusy] = useState(false);
  /** Override server guard when queueing the same rendered file again (same `output_revision` as last queue). */
  const [allowRepeatOutputUpload, setAllowRepeatOutputUpload] = useState(false);
  const [burnCaptionsDraft, setBurnCaptionsDraft] = useState(true);
  const [uploadDestYt, setUploadDestYt] = useState(true);
  const [uploadDestTt, setUploadDestTt] = useState(false);

  const refresh = useCallback(async (): Promise<Project | undefined> => {
    if (!id) return undefined;
    const data = await api<{ project: Project }>(`/api/projects/${id}`);
    setProject(data.project);
    setUploadTitle((t) => t || data.project.title);
    setScriptDraft(data.project.script_text);
    return data.project;
  }, [id]);

  const projectId = project?.id;
  const projectStatus = project?.status;
  const musicTrack = project?.music_track ?? null;
  const musicVolume = project?.music_volume ?? null;
  const voiceSource = project?.voice_source ?? 'ai';
  const voiceAssetPath = project?.voice_asset_path ?? null;
  const redditPermalink = project?.reddit_permalink ?? null;
  const youtubeConnectionId = project?.youtube_connection_id ?? null;
  const tiktokConnectionId = project?.tiktok_connection_id ?? null;
  const thumbnailPath = project?.thumbnail_path ?? null;
  const captionText = project?.caption_text ?? null;
  const scriptText = project?.script_text ?? '';
  const captionStyleRemote = project?.caption_style ?? null;

  useEffect(() => {
    api<{ themes?: unknown[] }>('/api/projects/background-meta')
      .then((d) => {
        const raw = Array.isArray(d.themes) ? d.themes : [];
        setBgThemes(
          raw.map((t) => {
            const row = t as { id?: string; label?: string; clip_count?: number; presets?: string[] };
            const n =
              typeof row.clip_count === 'number'
                ? row.clip_count
                : Array.isArray(row.presets)
                  ? row.presets.length
                  : 0;
            return { id: String(row.id ?? 'gameplay'), label: String(row.label ?? row.id ?? 'Theme'), clip_count: n };
          })
        );
      })
      .catch(() => setBgThemes([]));
    api<{ tracks: string[] }>('/api/projects/music-tracks')
      .then((d) => setMusicTracks(d.tracks || []))
      .catch(() => setMusicTracks([]));
    api<{ connections: YtConn[] }>('/api/youtube/status')
      .then((d) => setYtConnections(d.connections || []))
      .catch(() => setYtConnections([]));
    api<{ connections: TtConn[] }>('/api/tiktok/status')
      .then((d) => setTtConnections(d.connections || []))
      .catch(() => setTtConnections([]));
  }, []);

  useEffect(() => {
    if (projectId == null) return;
    setMusicDraft(musicTrack ?? '');
    setMusicVolDraft(
      typeof musicVolume === 'number' && Number.isFinite(musicVolume) ? musicVolume : 0.15
    );
    setVoiceSourceDraft(voiceSource === 'uploaded' ? 'uploaded' : 'ai');
    setRedditDraft(redditPermalink ?? '');
  }, [projectId, musicTrack, musicVolume, voiceSource, redditPermalink]);

  useEffect(() => {
    if (projectId == null) return;
    setScheduleYtConnId(youtubeConnectionId || '');
  }, [projectId, youtubeConnectionId]);

  useEffect(() => {
    if (projectId == null) return;
    setScheduleTtConnId(tiktokConnectionId || '');
  }, [projectId, tiktokConnectionId]);

  useEffect(() => {
    if (projectId == null) return;
    setUploadDestYt(project?.upload_dest_youtube !== false);
    setUploadDestTt(project?.upload_dest_tiktok === true);
  }, [projectId, project?.upload_dest_youtube, project?.upload_dest_tiktok]);

  useEffect(() => {
    if (projectId == null) return;
    setBurnCaptionsDraft(project?.burn_captions !== false);
  }, [projectId, project?.burn_captions]);

  useEffect(() => {
    if (!id || !thumbnailPath || projectStatus !== 'ready') {
      setThumbObjectUrl(null);
      return undefined;
    }
    let objectUrl: string | null = null;
    let cancelled = false;
    fetchAuthorizedBlob(`/api/projects/${id}/thumbnail`)
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        if (!cancelled) setThumbObjectUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setThumbObjectUrl(null);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, thumbnailPath, projectStatus]);

  useEffect(() => {
    if (!id) return;
    refresh().catch((e) => setErr(String(e)));
    const pollMs = projectStatus === 'rendering' ? 1200 : 4000;
    const t = setInterval(() => {
      refresh().catch(() => {});
    }, pollMs);
    return () => clearInterval(t);
  }, [id, projectStatus, refresh]);

  useEffect(() => {
    if (projectStatus !== 'rendering') {
      encodePhaseEnteredAtRef.current = null;
      return;
    }
    const rp = Math.min(100, Math.max(0, project?.render_progress ?? 0));
    if (rp >= 70 && encodePhaseEnteredAtRef.current == null) {
      encodePhaseEnteredAtRef.current = Date.now();
    }
  }, [projectStatus, project?.render_progress]);

  const projectRef = useRef<Project | null>(null);
  useLayoutEffect(() => {
    projectRef.current = project;
  }, [project]);
  /** Omit `updated_at`: unrelated PATCHes (music, Reddit, renders) must not wipe unsaved caption slider edits in the UI. */
  const captionSyncToken = `${projectId ?? ''}|${stableCaptionSettingsSignature(project?.caption_settings)}|${String(project?.caption_style ?? '')}`;
  useEffect(() => {
    if (projectId == null) return;
    setCaptions(captionFromProject(projectRef.current));
  }, [captionSyncToken, projectId]);

  useEffect(() => {
    if (projectId == null || captionText == null) return;
    setCaptionWordsDraft(captionText);
  }, [projectId, captionText]);

  useEffect(() => {
    if (projectId == null || captionText != null) return;
    setCaptionWordsDraft(scriptText);
  }, [projectId, captionText, scriptText]);

  useEffect(() => {
    if (projectId == null) return;
    const s = captionStyleRemote;
    setCaptionStyle(typeof s === 'string' && s ? s : 'bold_pop');
  }, [projectId, captionStyleRemote]);

  useEffect(() => {
    if (!id) return;
    const { date, time } = defaultScheduleAhead(60);
    setScheduleDate(date);
    setScheduleTime(time);
  }, [id]);

  useEffect(() => {
    if (!id || projectStatus !== 'ready') {
      setVideoUrl(null);
      return undefined;
    }
    let objectUrl: string | null = null;
    let cancelled = false;
    fetchAuthorizedBlob(`/api/projects/${id}/file`)
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        if (!cancelled) setVideoUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setVideoUrl(null);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, projectStatus]);

  async function saveBackgroundTheme(nextTheme: string) {
    if (!id) return;
    setErr('');
    try {
      const { project: updated } = await api<{ project: Project }>(`/api/projects/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ background_theme: nextTheme }),
      });
      setProject(updated);
      setMsg(
        'Theme saved. Each render picks a random clip from this pack (we cleared any library clip from another pack). Your own upload is unchanged until you replace it.'
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save theme');
    }
  }

  async function clearBackgroundSelection() {
    if (!id) return;
    setErr('');
    try {
      const { project: updated } = await api<{ project: Project }>(`/api/projects/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ background_asset_path: null }),
      });
      setProject(updated);
      setMsg('Back to our library — the next render will pick a random clip from your selected theme pack.');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Clear failed');
    }
  }

  function isUserBackgroundFilename(name: string) {
    return /\.(mp4|webm|mov|m4v|mkv)$/i.test(String(name || '').trim());
  }

  async function uploadTemporaryBackground(file: File | undefined) {
    if (!id) {
      setErr('Open a project first, then upload a background.');
      return;
    }
    if (!file?.size) {
      setErr('Choose a video file (.mp4, .webm, .mov, .m4v, or .mkv).');
      return;
    }
    if (!isUserBackgroundFilename(file.name)) {
      setErr('Use .mp4, .webm, .mov, .m4v, or .mkv — phone recordings are often .mov.');
      return;
    }
    setErr('');
    setBgUploadBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const data = await api<{ project?: Project; hint?: string }>(`/api/projects/${id}/background`, {
        method: 'POST',
        body: fd,
      });
      if (data.project) setProject(data.project);
      const extra = typeof data.hint === 'string' ? ` ${data.hint}` : '';
      setMsg(`Temporary clip saved for the next burn-in.${extra} Re-render to apply.`);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBgUploadBusy(false);
      if (bgFileRef.current) bgFileRef.current.value = '';
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
  if (project?.status === 'rendering') {
    if (pct < 70) {
      etaLabel = 'Preparing voice & captions — time estimate appears when encoding starts';
    } else if (pct < 100) {
      const t0 = encodePhaseEnteredAtRef.current;
      const ratioThroughEncode = Math.max(0.04, (pct - 70) / 29);
      if (t0 == null) {
        etaLabel = 'Encoding…';
      } else {
        const encEl = (Date.now() - t0) / 1000;
        if (encEl < 2) {
          etaLabel = 'Encoder ramping up…';
        } else {
          const encTotal = encEl / ratioThroughEncode;
          const left = Math.max(0, encTotal - encEl);
          if (Number.isFinite(left) && left < 7200) {
            etaLabel =
              left < 90
                ? `~${Math.max(8, Math.round(left))}s left (encode)`
                : `~${Math.ceil(left / 60)} min left (encode)`;
          }
        }
      }
    }
  }

  const durationSecondsNum = Number(project?.duration_seconds);
  const schedulePartGuess =
    Number.isFinite(durationSecondsNum) && durationSecondsNum > 0
      ? Math.ceil(durationSecondsNum / YT_SHORT_PART_CHUNK_SEC)
      : 1;

  const outRev = Number(project?.output_revision ?? 0);
  const lastQRaw = project?.last_queued_output_revision;
  const lastQNum = lastQRaw == null || String(lastQRaw).trim() === '' ? null : Number(lastQRaw);
  const duplicateSameOutputQueued =
    project?.status === 'ready' &&
    lastQNum != null &&
    Number.isFinite(lastQNum) &&
    lastQNum === outRev;
  const newerRenderSinceLastQueue =
    project?.status === 'ready' &&
    lastQNum != null &&
    Number.isFinite(lastQNum) &&
    Number.isFinite(outRev) &&
    outRev > lastQNum;

  useEffect(() => {
    if (!duplicateSameOutputQueued) setAllowRepeatOutputUpload(false);
  }, [duplicateSameOutputQueued]);

  async function saveCaptionSettings(next?: CaptionSettings) {
    if (!id) return;
    const payload = next ?? captions;
    setErr('');
    try {
      const { project: updated } = await api<{ project: Project }>(`/api/projects/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ caption_settings: payload, caption_style: captionStyle }),
      });
      /** Keep project in sync so caption sync updates from the saved row (polling won’t revert unsaved sliders). */
      setProject(updated);
      setCaptions(captionFromProject(updated));
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
          ? 'Script saved as draft. Re-render to refresh the video. On-screen captions still use the separate caption wording until you update that box or turn off custom captions.'
          : 'Script saved as draft. Re-render to refresh voiceover and captions.'
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

  async function persistDefaultChannel(connectionId: string) {
    if (!id) return;
    setErr('');
    try {
      await api(`/api/projects/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ youtube_connection_id: connectionId || null }),
      });
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save channel preference');
    }
  }

  async function persistTiktokConnection(connectionId: string) {
    if (!id) return;
    setErr('');
    try {
      await api(`/api/projects/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ tiktok_connection_id: connectionId || null }),
      });
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save TikTok account preference');
    }
  }

  async function persistUploadDestinations(patch: { upload_dest_youtube?: boolean; upload_dest_tiktok?: boolean }) {
    if (!id) return;
    setErr('');
    const body: Record<string, boolean> = {};
    if (patch.upload_dest_youtube !== undefined) body.upload_dest_youtube = patch.upload_dest_youtube;
    if (patch.upload_dest_tiktok !== undefined) body.upload_dest_tiktok = patch.upload_dest_tiktok;
    if (!Object.keys(body).length) return;
    try {
      await api(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
      await refresh();
      setMsg('Publish destinations saved.');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save publish destinations');
      await refresh().catch(() => {});
    }
  }

  async function saveAudioMix() {
    if (!id) return;
    setErr('');
    try {
      await api(`/api/projects/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          music_track: musicDraft || null,
          music_volume: musicVolDraft,
        }),
      });
      await refresh();
      setMsg('Background music saved. Re-render to bake it into the MP4.');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed');
    }
  }

  async function uploadMusic(file: File | null) {
    if (!file) return;
    setErr('');
    const fd = new FormData();
    fd.append('file', file);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch('/api/projects/music-upload', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error((body as { error?: string }).error || res.statusText);
      }
      const track = String((body as { track?: string }).track || '');
      if (!track) throw new Error('Upload failed');
      const list = await api<{ tracks: string[] }>('/api/projects/music-tracks');
      setMusicTracks(list.tracks || []);
      setMusicDraft(track);
      setMsg('Audio uploaded. Click Save audio mix to use it in renders.');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Music upload failed');
    }
  }

  async function uploadVoice(file: File | null) {
    if (!id || !file) return;
    setErr('');
    const fd = new FormData();
    fd.append('file', file);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`/api/projects/${id}/voice`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error((body as { error?: string }).error || res.statusText);
      }
      await refresh();
      setVoiceSourceDraft('uploaded');
      setMsg('Voice upload saved. Select "Uploaded voice" and save voice mode.');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Voice upload failed');
    }
  }

  async function saveVoiceMode() {
    if (!id) return;
    setErr('');
    try {
      await api(`/api/projects/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ voice_source: voiceSourceDraft }),
      });
      await refresh();
      setMsg(
        voiceSourceDraft === 'uploaded'
          ? 'Uploaded voice selected. Re-render to use your recording.'
          : 'AI voice selected. Re-render to synthesize voiceover from script.'
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save voice mode');
    }
  }

  async function persistBurnCaptions(next: boolean) {
    if (!id) return;
    setErr('');
    try {
      await api(`/api/projects/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ burn_captions: next }),
      });
      await refresh();
      setBurnCaptionsDraft(next);
      setMsg(
        next
          ? 'Captions will be burned into the next render.'
          : 'Next render will skip burned-in captions (voice and picture only). Re-render to apply.'
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save caption burn setting');
      await refresh().catch(() => {});
    }
  }

  async function saveRedditAttribution() {
    if (!id) return;
    setErr('');
    try {
      const link = redditDraft.trim();
      await api(`/api/projects/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          reddit_permalink: link || null,
          source_type: link ? 'reddit' : 'manual',
        }),
      });
      await refresh();
      setMsg(
        'Attribution saved. YouTube adds the link in the description when scheduled. Re-render to refresh the opening Reddit card in the video.'
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed');
    }
  }

  async function generateThumbnail(mode: 'canvas' | 'extract') {
    if (!id) return;
    setErr('');
    try {
      await api(`/api/projects/${id}/generate-thumbnail`, {
        method: 'POST',
        body: JSON.stringify({ mode }),
      });
      const refreshed = await refresh();
      const hasReddit = Boolean(refreshed?.reddit_permalink?.trim());
      setMsg(
        mode === 'extract'
          ? hasReddit
            ? 'Thumbnail saved: a frame from after the Reddit intro in your video (used as the YouTube poster — not the Reddit card).'
            : 'Thumbnail frame extracted from your render (used on YouTube when uploaded).'
          : 'Title-card thumbnail generated (used on YouTube when uploaded).'
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Thumbnail failed');
    }
  }

  async function aiDraftScript() {
    if (!id) return;
    const p = aiTopic.trim();
    if (!p) {
      setErr('Add a short topic for the AI draft.');
      return;
    }
    setErr('');
    try {
      const d = await api<{ script_text: string }>('/api/generate/ai', {
        method: 'POST',
        body: JSON.stringify({ prompt: p }),
      });
      setScriptDraft(d.script_text || '');
      setMsg('AI draft filled the script box — review, edit, then Save script.');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'AI draft failed');
    }
  }

  async function schedule() {
    if (!id) return;
    if (!scheduleDate || !scheduleTime) {
      setErr('Choose both a date and a time for the publish.');
      return;
    }
    const wantYt = project?.upload_dest_youtube !== false;
    const wantTt = project?.upload_dest_tiktok === true;
    if (!wantYt && !wantTt) {
      setErr('Turn on YouTube Shorts and/or TikTok under Publish destinations before scheduling.');
      return;
    }
    const wallZone = browserTimeZone();
    const [y, mo, da] = scheduleDate.split('-').map((n) => Number(n));
    const tp = scheduleTime.split(':').map((n) => Number(n));
    const dt = DateTime.fromObject(
      { year: y, month: mo, day: da, hour: tp[0] ?? 0, minute: tp[1] ?? 0, second: tp[2] ?? 0 },
      { zone: wallZone }
    );
    if (!dt.isValid) {
      setErr('That date and time could not be read. Check the date/time fields.');
      return;
    }
    /** Keep in sync with server `YOUTUBE_PUBLISH_AT_MIN_LEAD_MS` (+ small buffer). */
    const minPublish = Date.now() + 21 * 60 * 1000;
    if (dt.toMillis() < minPublish) {
      setErr('YouTube needs the publish time at least ~20 minutes in the future. Pick a later time.');
      return;
    }
    setErr('');
    if (schedulePartGuess >= 2) {
      setMsg(
        `Preparing ${schedulePartGuess} parts — re-encoding each segment for Shorts often takes a few minutes per part. Keep this page open until the success message appears.`
      );
    } else if (Number.isFinite(durationSecondsNum) && durationSecondsNum >= 150) {
      setMsg('Checking your file before upload — may take a minute…');
    } else {
      setMsg('');
    }
    setScheduleBusy(true);
    try {
      const d = await api<{ scheduled?: unknown[]; part_count?: number }>(`/api/projects/${id}/schedule`, {
        method: 'POST',
        body: JSON.stringify({
          scheduled_at: dt.toUTC().toISO(),
          title: uploadTitle || project?.title,
          ...(scheduleYtConnId ? { youtube_connection_id: scheduleYtConnId } : {}),
          ...(scheduleTtConnId ? { tiktok_connection_id: scheduleTtConnId } : {}),
          ...(allowRepeatOutputUpload ? { allow_repeat_output_upload: true } : {}),
        }),
      });
      const n = typeof d.part_count === 'number' ? d.part_count : Array.isArray(d.scheduled) ? d.scheduled.length : 1;
      setAllowRepeatOutputUpload(false);
      const destBits = [wantYt ? 'YouTube' : null, wantTt ? 'TikTok' : null].filter(Boolean).join(' + ');
      setMsg(
        n > 1
          ? `Queued ${n} upload job(s) (${destBits}) — each part is under 3:00; first at your chosen time, then one part every 24 hours. See the calendar for each row.`
          : `Queued scheduled upload (${destBits}). The worker starts transfers up to about an hour before your publish time.`
      );
    } catch (e) {
      if (e instanceof ApiHttpError && e.status === 409) {
        const code = typeof e.body.code === 'string' ? e.body.code : '';
        const extra =
          code === 'DUPLICATE_OUTPUT_REVISION'
            ? ' Turn on “Allow uploading this same render again” below only if you intend to queue the same file twice.'
            : '';
        setErr((e.message || 'Schedule conflict') + extra);
      } else {
        setErr(e instanceof Error ? e.message : 'Schedule failed');
      }
    } finally {
      setScheduleBusy(false);
    }
  }

  async function deleteThisProject() {
    if (!id) {
      setErr('Missing project id in URL — reload the page and try again.');
      return;
    }
    if (!project) return;
    if (!deleteArmed) {
      setDeleteArmed(true);
      setErr(`Click Delete project again to confirm deleting "${project.title}".`);
      return;
    }
    setDeleteArmed(false);
    setDeleting(true);
    setErr('Deleting project...');
    try {
      await apiDeleteProject(id);
      setErr('');
      navigate('/app');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setDeleting(false);
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
  const wallZone = browserTimeZone();
  let schedulePreview = '';
  if (scheduleDate && scheduleTime) {
    const [y, mo, da] = scheduleDate.split('-').map((n) => Number(n));
    const tp = scheduleTime.split(':').map((n) => Number(n));
    const prev = DateTime.fromObject(
      { year: y, month: mo, day: da, hour: tp[0] ?? 0, minute: tp[1] ?? 0, second: tp[2] ?? 0 },
      { zone: wallZone }
    );
    if (prev.isValid) {
      const acctTz = String(scheduleTz).trim() || 'UTC';
      const wallStr = `${prev.toLocaleString(DateTime.DATETIME_MED)} (${wallZone})`;
      schedulePreview =
        acctTz !== wallZone
          ? `${wallStr} — ${prev.setZone(acctTz).toLocaleString(DateTime.DATETIME_MED)} (${acctTz} in Settings)`
          : wallStr;
    }
  }

  const bgThemeStoredRaw =
    typeof project.background_theme === 'string' && project.background_theme.trim()
      ? project.background_theme.trim().toLowerCase()
      : 'gameplay';
  const bgThemeStored = bgThemes.some((t) => t.id === bgThemeStoredRaw) ? bgThemeStoredRaw : 'gameplay';
  const clipsInSelectedTheme = bgThemes.find((t) => t.id === bgThemeStored)?.clip_count ?? 0;
  const usingUserUpload = isUserUploadedBackgroundPath(project.background_asset_path);

  const todayLocal = localDateStr(new Date());

  const hasCaptionOverride = project?.caption_text != null;
  const isRedditProject = String(project?.source_type || '').toLowerCase() === 'reddit';
  const previewBody = hasCaptionOverride ? captionWordsDraft : scriptDraft;
  const livePreviewSource =
    previewSample.trim() ||
    (voiceSourceDraft === 'ai' ? combineTitleBeforeStory(project?.title, previewBody) : previewBody) ||
    'Caption preview';

  const scriptDirty = scriptDraft.trim() !== String(project.script_text || '').trim();

  return (
    <div className="editor">
      <header className="topbar">
        <Link to="/app">← Projects</Link>
        <h1 style={{ flex: 1, margin: 0, textAlign: 'center' }}>{project.title}</h1>
        <button
          type="button"
          className="danger-outline"
          disabled={deleting}
          onClick={() => void deleteThisProject()}
        >
          {deleting ? 'Deleting…' : deleteArmed ? 'Confirm delete' : 'Delete project'}
        </button>
      </header>

      {scriptDirty && (
        <p className="banner-soft">
          You have unsaved script edits — click <strong>Save script</strong> to persist them and mark the project as
          draft.
        </p>
      )}
      {project.status === 'draft' &&
        project.duration_seconds != null &&
        !scriptDirty && (
          <p className="banner-warn">
            <strong>Script or project saved as draft</strong> — generate video again so the exported MP4 matches what
            you saved.
          </p>
        )}

      <div className="grid-2">
        <section className="card">
          <h2>Script</h2>
          <p className="hint">
            This text drives <strong>voiceover</strong>. Save, then use <strong>Generate video</strong>. With{' '}
            <strong>AI voice</strong>, the <strong>project title</strong> is spoken first, then this script (unless the
            script already opens with the same title). By default, on-screen captions follow the same spoken flow — use
            the <strong>Caption wording</strong> section below if subtitles should say something different.
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
          <h3 style={{ marginTop: '1.25rem' }}>AI script draft</h3>
          <p className="hint">
            Uses <code>GEMINI_API_KEY</code> on the API. Pastes into the script box — you should still edit and fact-check.
          </p>
          <label>
            Topic / angle
            <input
              value={aiTopic}
              onChange={(e) => setAiTopic(e.target.value)}
              placeholder="e.g. 3 habits that compound for beginners"
            />
          </label>
          <button type="button" className="secondary-btn" onClick={() => void aiDraftScript()}>
            Draft with AI
          </button>
        </section>

        <section className="card">
          <h2>Background video</h2>
          <p className="hint">
            Use our rotating library (mood pack + random clip each render) <strong>or</strong> upload your own portrait
            video. Formats: <strong>.mp4</strong>, <strong>.webm</strong>, <strong>.mov</strong>, <strong>.m4v</strong>,{' '}
            <strong>.mkv</strong>. Uploads are deleted after a successful render.
          </p>

          <div className="bg-source-block">
            <h3 className="bg-source-title">Our library</h3>
            <p className="hint">
              Choose a mood pack. <strong>Generate video</strong> picks a <strong>random</strong> clip from that pack
              each time — you do not choose individual files from us.
            </p>
            <label>
              Theme pack
              <select
                value={bgThemeStored}
                onChange={(e) => void saveBackgroundTheme(e.target.value)}
              >
                {(bgThemes.length > 0 ? bgThemes : [{ id: 'gameplay', label: 'Gameplay', clip_count: 0 }]).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                    {t.clip_count > 0 ? ` (${t.clip_count} clip${t.clip_count === 1 ? '' : 's'})` : ''}
                  </option>
                ))}
              </select>
            </label>
            {clipsInSelectedTheme === 0 ? (
              <p className="hint mono">
                No clips in this pack yet — add <strong>.mp4</strong> or <strong>.webm</strong> under{' '}
                <code>{bgThemeStored === 'gameplay' ? 'assets/gameplay/' : `assets/background_themes/${bgThemeStored}/`}</code>{' '}
                on the server (safe filenames: letters, numbers, <code>.</code>, <code>_</code>, <code>-</code> only).
              </p>
            ) : (
              <p className="hint">
                This pack has <strong>{clipsInSelectedTheme}</strong> clip{clipsInSelectedTheme === 1 ? '' : 's'} — each
                render uses one at random (and a random segment when the file is long enough).
              </p>
            )}
          </div>

          <div className="bg-source-block">
            <h3 className="bg-source-title">Your own background</h3>
            <p className="hint">
              Upload overrides the library for the next burn-in only. After a successful render the file is removed and
              the project falls back to a random library clip from your selected pack (unless you upload again).
            </p>
            <input
              ref={bgFileRef}
              type="file"
              accept="video/mp4,video/webm,video/quicktime,video/x-matroska,.mp4,.webm,.mov,.m4v,.mkv"
              style={{ display: 'none' }}
              onChange={(e) => void uploadTemporaryBackground(e.target.files?.[0])}
            />
            <p>
              <button
                type="button"
                className="secondary-btn"
                disabled={bgUploadBusy}
                onClick={() => bgFileRef.current?.click()}
              >
                {bgUploadBusy ? 'Uploading…' : 'Upload background video'}
              </button>{' '}
              <button type="button" onClick={() => void clearBackgroundSelection()}>
                Use library instead
              </button>
            </p>
          </div>

          <p className="hint" style={{ marginTop: '0.75rem' }}>
            {usingUserUpload ? (
              <>
                <strong>Next render:</strong> your uploaded clip.{' '}
                <button type="button" className="linkish" onClick={() => void clearBackgroundSelection()}>
                  Switch to library
                </button>
              </>
            ) : project.background_asset_path ? (
              <>
                <strong>Next render:</strong> a library clip from the <strong>{bgThemeStored}</strong> pack (already
                assigned or will be chosen when encoding starts).
              </>
            ) : (
              <>
                <strong>Next render:</strong> a random clip from the <strong>{bgThemeStored}</strong> pack (when that
                folder has videos).
              </>
            )}
          </p>

          {!isRedditProject && (
            <>
              <h3 style={{ marginTop: '1.25rem' }}>Audio — background music</h3>
              <p className="hint">
                Upload your own music/sound, then pick it below. It is mixed under voiceover at the selected volume.
              </p>
              <input type="file" accept=".mp3,.m4a,.aac,.wav,audio/*" onChange={(e) => void uploadMusic(e.target.files?.[0] || null)} />
              <label>
                Track
                <select value={musicDraft} onChange={(e) => setMusicDraft(e.target.value)}>
                  <option value="">None (voice only)</option>
                  {musicTracks.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Bed volume ({Math.round(musicVolDraft * 100)}%){' '}
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={musicVolDraft}
                  onChange={(e) => setMusicVolDraft(Number(e.target.value))}
                />
              </label>
              <button type="button" className="secondary-btn" onClick={() => void saveAudioMix()}>
                Save audio mix
              </button>

              <h3 style={{ marginTop: '1.25rem' }}>Voice mode</h3>
              <p className="hint">
                Choose AI voice generation from your script, or upload your own recorded voice and render with that audio.
              </p>
              <label>
                Voice source
                <select value={voiceSourceDraft} onChange={(e) => setVoiceSourceDraft(e.target.value as 'ai' | 'uploaded')}>
                  <option value="ai">AI voice (TTS from script)</option>
                  <option value="uploaded">Uploaded voice recording</option>
                </select>
              </label>
              <input type="file" accept=".mp3,.m4a,.aac,.wav,.ogg,.webm,audio/*" onChange={(e) => void uploadVoice(e.target.files?.[0] || null)} />
              <p className="hint">
                {voiceAssetPath ? 'Voice file is uploaded and ready.' : 'No uploaded voice file yet.'}
              </p>
              <button type="button" className="secondary-btn" onClick={() => void saveVoiceMode()}>
                Save voice mode
              </button>
            </>
          )}
        </section>
      </div>

      <section className="card caption-words-card">
        <h2>Caption wording (on-screen)</h2>
        <p className="hint">
          Burned-in subtitles are generated from your wording and timed to the voiceover length. Leave this matching the
          script, or write shorter/cleaner lines for the screen only — with <strong>AI voice</strong>, speech is still{' '}
          <strong>title</strong> then <strong>Script</strong> above; custom caption wording gets the same title prefix
          so timing lines up.
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
        <label>
          Caption preset (exported fonts & colours; word timings follow your wording)
          <select
            className="caption-style-select"
            value={captionStyle}
            onChange={(e) => setCaptionStyle(e.target.value)}
          >
            {CAPTION_STYLE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

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
              max={72}
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

      <section className="card generate-card">
        <h2>Generate video</h2>
        <p className="hint">
          When your script, background, audio, and captions above are ready, render the Short. The exported MP4 bakes in
          the voiceover and (optionally) burned-in captions — re-generate any time you change settings.
        </p>
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
              {pct}% complete{etaLabel ? ` · ${etaLabel}` : ''}
            </p>
          </div>
        )}
        {project.error_message && <p className="error">{project.error_message}</p>}
        <label className="caption-toggle">
          <input
            type="checkbox"
            checked={burnCaptionsDraft}
            onChange={(e) => void persistBurnCaptions(e.target.checked)}
          />
          <span>
            Burn captions into the exported video. Turn off for a clean image (voiceover unchanged). Multi-part Shorts
            (over ~3:00) add a spoken “Subscribe for the next part” at the end of each segment when using AI voice, and
            part 2+ start with your title again.
          </span>
        </label>
        <button type="button" className="generate-btn" onClick={() => renderNow()} disabled={project.status === 'rendering'}>
          {project.status === 'rendering' ? 'Rendering…' : 'Generate video'}
        </button>
      </section>

      {videoUrl && (
        <section className="card preview">
          <h2>Exported video preview</h2>
          <p className="hint">
            This file is the <strong>last render</strong> (voiceover + captions baked in). It will not change until you
            click Generate video again. Tune captions in <strong>Caption look — edit in the preview</strong> first,
            then re-export when it looks right.
          </p>
          <div className="preview-toolbar thumb-row">
            <button type="button" onClick={() => void downloadVideo()}>
              Download MP4
            </button>
            <div className="thumb-title-wrap">
              <button
                type="button"
                className="secondary-btn thumb-title-btn-full"
                onClick={() => void generateThumbnail('canvas')}
                title="Generates the title-card thumbnail from this project’s title (shown in full)."
              >
                {project.title?.trim() ? project.title.trim() : 'Generate title thumbnail'}
              </button>
            </div>
            <button type="button" className="secondary-btn" onClick={() => void generateThumbnail('extract')}>
              Thumbnail from video frame
            </button>
          </div>
          {(project.source_type === 'reddit' || project.reddit_permalink?.trim()) && (
            <p className="hint">
              With a saved <strong>permalink</strong>, each <strong>render</strong> opens with a full-screen Reddit
              post card for a few seconds, then your gameplay and captions. The YouTube thumbnail uses a frame{' '}
              <em>after</em> that intro (generate again after re-rendering if the clip changed).
            </p>
          )}
          {thumbObjectUrl ? (
            <p className="hint">
              YouTube thumbnail (uploaded automatically with scheduled publishes):{' '}
              <img src={thumbObjectUrl} alt="Thumbnail preview" className="thumb-preview" />
            </p>
          ) : (
            <p className="hint">
              Tip: generate a thumbnail so scheduled uploads attach a poster frame automatically.
            </p>
          )}
          <video src={videoUrl} controls playsInline className="short-preview" />
        </section>
      )}

      <section className="card">
        <h2>Reddit attribution (optional)</h2>
        <p className="hint">
          If this script comes from Reddit, paste the thread permalink. When the upload job runs we append it to the
          YouTube description (before the caps limit trim).
        </p>
        <label>
          Permalink URL
          <input
            type="url"
            value={redditDraft}
            onChange={(e) => setRedditDraft(e.target.value)}
            placeholder="https://reddit.com/r/..."
          />
        </label>
        <button type="button" className="secondary-btn" onClick={() => void saveRedditAttribution()}>
          Save attribution
        </button>
      </section>

      <section className="card">
        <h2>Schedule publish</h2>
        <p className="hint">
          Connect accounts under <Link to="/app/settings">Settings</Link>. Choose whether each scheduled run should go
          to <strong>YouTube Shorts</strong>, <strong>TikTok</strong>, or both (two queue rows per part). The date and
          time use <strong>this browser’s timezone</strong> ({wallZone}) for YouTube; TikTok posts when processing
          finishes (no native timed publish). Preview also shows your account timezone ({scheduleTz}) when they differ.
        </p>
        <div className="hint" style={{ marginBottom: '0.75rem' }}>
          <strong>Publish destinations</strong>
          <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.35rem' }}>
            <input
              type="checkbox"
              checked={uploadDestYt}
              onChange={(e) => {
                const v = e.target.checked;
                if (!v && !uploadDestTt) {
                  setErr('Keep at least one destination: YouTube Shorts and/or TikTok.');
                  return;
                }
                setUploadDestYt(v);
                void persistUploadDestinations({ upload_dest_youtube: v });
              }}
            />
            <span>YouTube Shorts</span>
          </label>
          <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.35rem' }}>
            <input
              type="checkbox"
              checked={uploadDestTt}
              onChange={(e) => {
                const v = e.target.checked;
                if (!v && !uploadDestYt) {
                  setErr('Keep at least one destination: YouTube Shorts and/or TikTok.');
                  return;
                }
                setUploadDestTt(v);
                void persistUploadDestinations({ upload_dest_tiktok: v });
              }}
            />
            <span>TikTok (direct post via TikTok Login / Content Posting API)</span>
          </label>
        </div>
        {ytConnections.length === 0 && uploadDestYt ? (
          <p className="hint">
            No YouTube channels linked. <Link to="/app/settings">Open Settings</Link> to connect Google.
          </p>
        ) : uploadDestYt ? (
          <label>
            YouTube channel
            <select
              value={scheduleYtConnId}
              onChange={(e) => {
                const v = e.target.value;
                setScheduleYtConnId(v);
                void persistDefaultChannel(v);
              }}
            >
              <option value="">Default channel (see Settings)</option>
              {ytConnections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.channel_title || 'Channel'} {c.google_account_email ? `(${c.google_account_email})` : ''}
                  {c.is_default ? ' — default' : ''}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {ttConnections.length === 0 && uploadDestTt ? (
          <p className="hint" style={{ marginTop: '0.75rem' }}>
            No TikTok accounts linked. <Link to="/app/settings">Open Settings</Link> to connect TikTok (HTTPS redirect
            required in the TikTok developer portal).
          </p>
        ) : uploadDestTt ? (
          <label style={{ display: 'block', marginTop: '0.75rem' }}>
            TikTok account
            <select
              value={scheduleTtConnId}
              onChange={(e) => {
                const v = e.target.value;
                setScheduleTtConnId(v);
                void persistTiktokConnection(v);
              }}
            >
              <option value="">Default TikTok account (see Settings)</option>
              {ttConnections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.creator_nickname || c.creator_username || c.open_id}
                  {c.is_default ? ' — default' : ''}
                </option>
              ))}
            </select>
          </label>
        ) : null}
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
            Publish instant: <strong>{schedulePreview}</strong>
          </p>
        ) : (
          <p className="hint">
            Choose a date and time above. YouTube needs at least ~20 minutes of lead time for scheduled publishes. The app may
            start uploading your file up to about <strong>one hour before</strong> that time so the transfer finishes before go-live.
          </p>
        )}
        <label>
          Video title on YouTube
          <input value={uploadTitle} onChange={(e) => setUploadTitle(e.target.value)} />
        </label>
        <p className="hint">
          Anything <strong>3 minutes or longer</strong> is split so every upload is <strong>strictly under 3:00</strong>{' '}
          (YouTube Shorts); part 1 uses the time above, then each next part is scheduled <strong>24 hours</strong> later
          (one part per day). Use the calendar to see every part.
        </p>
        {newerRenderSinceLastQueue && (
          <p className="hint">
            This project has a <strong>new render</strong> since the last time it was queued — the next schedule will use
            the latest video file.
          </p>
        )}
        {duplicateSameOutputQueued && (
          <>
            <p className="hint">
              This <strong>same rendered file</strong> was already queued for upload. Re-render to publish a different cut,
              or confirm below if you removed calendar rows and need to queue this exact output again.
            </p>
            <label className="hint" style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
              <input
                type="checkbox"
                checked={allowRepeatOutputUpload}
                onChange={(e) => setAllowRepeatOutputUpload(e.target.checked)}
              />
              <span>Allow uploading this same render again (override duplicate guard)</span>
            </label>
          </>
        )}
        <button type="button" disabled={scheduleBusy} onClick={() => void schedule()}>
          {scheduleBusy
            ? schedulePartGuess >= 2
              ? `Preparing ${schedulePartGuess} parts (re-encode can take several minutes)…`
              : 'Queuing upload…'
            : 'Queue scheduled upload'}
        </button>
      </section>

      {msg && <p className="success">{msg}</p>}
      {err && <p className="error">{err}</p>}
    </div>
  );
}
