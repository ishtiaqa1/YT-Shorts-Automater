import { google } from 'googleapis';
import { createReadStream, existsSync } from 'fs';
import { basename } from 'path';
import { googleOAuthEnvFromProcess } from '../oauthEnv.js';
import { probeVideoDurationSeconds, probePrimaryVideoStreamSize, YOUTUBE_SHORT_STRICT_MAX_SEC } from './splitVideoForShorts.js';

/** YouTube rejects `publishAt` if it is too soon; keep a comfortable margin (see Data API docs / community reports). */
export const YOUTUBE_PUBLISH_AT_MIN_LEAD_MS = 20 * 60 * 1000;

/** `videos.insert` / `videos.update` `snippet.title` must be non-empty and at most this length or YouTube returns invalidTitle. */
export const YOUTUBE_SNIPPET_TITLE_MAX_LEN = 100;

/**
 * @param {string | null | undefined} raw
 * @param {string} [fallback] used when raw is empty after trim (default Short)
 */
export function clipYoutubeVideoTitle(raw, fallback = 'Short') {
  const strip = (s) => String(s ?? '').replace(/\u0000/g, '').trim();
  const t = strip(raw);
  if (t) {
    return t.length <= YOUTUBE_SNIPPET_TITLE_MAX_LEN ? t : t.slice(0, YOUTUBE_SNIPPET_TITLE_MAX_LEN);
  }
  const fb = strip(fallback);
  const out = fb.slice(0, YOUTUBE_SNIPPET_TITLE_MAX_LEN);
  return out || 'Short';
}

/** Trailing multipart markers from {@link youtubeShortsMultipartTitle} or legacy `(1/2)` titles. */
const MULTIPART_TITLE_SUFFIX_RE = /\s*[\u2014\u2013\-]\s*Part\s+\d+\s+of\s+\d+\s*$/i;
const LEGACY_SLASH_PART_SUFFIX_RE = /\s*\(\d+\s*\/\s*\d+\)\s*$/;

/**
 * @param {string | null | undefined} title
 * @returns {string}
 */
export function stripYoutubeMultipartTitleSuffix(title) {
  const strip = (s) => String(s ?? '').replace(/\u0000/g, '').trim();
  let t = strip(title);
  for (let i = 0; i < 4; i += 1) {
    const next = t.replace(MULTIPART_TITLE_SUFFIX_RE, '').replace(LEGACY_SLASH_PART_SUFFIX_RE, '').trim();
    if (next === t) break;
    t = next;
  }
  return t;
}

/**
 * Reads `Part X of Y` from scheduled description (set when splitting long Shorts).
 *
 * @param {string | null | undefined} scheduledDescription
 * @returns {{ index: number; total: number } | null}
 */
export function parseMultipartPartMetaFromDescription(scheduledDescription) {
  const m = String(scheduledDescription ?? '').match(/\bPart\s+(\d+)\s+of\s+(\d+)\b/i);
  if (!m) return null;
  const index = Number(m[1]);
  const total = Number(m[2]);
  if (!Number.isFinite(index) || !Number.isFinite(total) || index < 1 || total < 2 || index > total) return null;
  return { index, total };
}

/**
 * Clip `baseTitle` so that `baseTitle + suffix` fits YouTube’s title max — **suffix is never truncated**.
 *
 * @param {string | null | undefined} baseTitle
 * @param {string} suffix non-empty suffix (e.g. ` — Part 2 of 5`)
 * @param {string} [fallback]
 */
export function clipYoutubeVideoTitleWithSuffix(baseTitle, suffix, fallback = 'Short') {
  const strip = (s) => String(s ?? '').replace(/\u0000/g, '').trim();
  const suf = strip(suffix);
  const max = YOUTUBE_SNIPPET_TITLE_MAX_LEN;
  if (!suf) return clipYoutubeVideoTitle(baseTitle, fallback);
  if (suf.length > max) return suf.slice(0, max);

  const maxBase = max - suf.length;
  let base = strip(baseTitle);
  if (!base) base = strip(fallback) || 'Short';
  if (base.length > maxBase) {
    base = base.slice(0, maxBase).replace(/\s+$/u, '').trim();
    if (!base) base = (strip(fallback) || 'Short').slice(0, maxBase).trim() || 'Short';
  }
  const out = (base + suf).slice(0, max);
  return out || 'Short';
}

/**
 * YouTube Shorts title for one part of a split export (`total` &gt; 1 appends ` — Part i of n`, clipping base only).
 *
 * @param {string | null | undefined} baseTitle
 * @param {number} partIndex 1-based
 * @param {number} partTotal
 * @param {string} [fallback]
 */
export function youtubeShortsMultipartTitle(baseTitle, partIndex, partTotal, fallback = 'Short') {
  const t = Number(partTotal);
  const i = Number(partIndex);
  if (!Number.isFinite(t) || !Number.isFinite(i) || t < 2) return clipYoutubeVideoTitle(baseTitle, fallback);
  const suffix = ` — Part ${i} of ${t}`;
  return clipYoutubeVideoTitleWithSuffix(baseTitle, suffix, fallback);
}

/** Re-export: uploads must be strictly &lt; this many seconds to count as Shorts. */
export { YOUTUBE_SHORT_STRICT_MAX_SEC as YOUTUBE_SHORTS_MAX_UPLOAD_DURATION_SEC } from './splitVideoForShorts.js';

const YOUTUBE_SNIPPET_DESC_MAX_LEN = 4900;

/** @param {unknown} e */
function isYoutubeShortsPrecheckError(e) {
  const m = String(e?.message || e);
  return /Shorts must be|strictly under|wider than tall|portrait or square|Re-render vertical|Split or shorten the export/i.test(m);
}

/**
 * Lead with `#Shorts` so API uploads get the same signal as manual Shorts posts (footer hashtags may be far down).
 * @param {string | null | undefined} description
 */
export function ensureShortsDescriptionLead(description) {
  const raw = String(description ?? '').trim();
  if (/^#\s*shorts\b/im.test(raw)) return raw.length > YOUTUBE_SNIPPET_DESC_MAX_LEN ? raw.slice(0, YOUTUBE_SNIPPET_DESC_MAX_LEN) : raw;
  const combined = `#Shorts\n\n${raw}`.trimEnd();
  return combined.length > YOUTUBE_SNIPPET_DESC_MAX_LEN ? combined.slice(0, YOUTUBE_SNIPPET_DESC_MAX_LEN).trimEnd() : combined;
}

/**
 * Many API-uploaded vertical videos are classified as long-form unless the title signals Shorts.
 * Appends ` #Shorts` when missing (clipped to {@link YOUTUBE_SNIPPET_TITLE_MAX_LEN}).
 * Opt out: `YOUTUBE_SKIP_SHORTS_TITLE_TAG=1`.
 */
export function ensureShortsTitleForUpload(rawTitle, fallback = 'Short') {
  if (String(process.env.YOUTUBE_SKIP_SHORTS_TITLE_TAG ?? '').trim() === '1') {
    return clipYoutubeVideoTitle(rawTitle, fallback);
  }
  const t = String(rawTitle ?? '').trim();
  const base = t || String(fallback ?? '').trim() || 'Short';
  if (/(?:^|\s)#?shorts\s*$/i.test(base)) return clipYoutubeVideoTitle(base, fallback);
  return clipYoutubeVideoTitleWithSuffix(base, ' #Shorts', fallback);
}

export function formatYoutubeDataApiError(err) {
  const list = err?.response?.data?.error?.errors;
  if (Array.isArray(list) && list.length) {
    return list
      .map((x) => [x?.reason, x?.message].filter(Boolean).join(': '))
      .filter(Boolean)
      .join('; ');
  }
  return err?.response?.data?.error?.message || err?.message || String(err);
}

/**
 * True when YouTube/Google indicates quota, rate limit, or channel upload caps — worth deferring and retrying later.
 * @param {unknown} err googleapis error or any thrown value
 */
export function isYouTubeQuotaOrRateLimitError(err) {
  const status = err?.response?.status;
  if (status === 429) return true;
  const apiCode = err?.response?.data?.error?.code;
  if (apiCode === 429) return true;
  const list = err?.response?.data?.error?.errors;
  if (Array.isArray(list)) {
    for (const x of list) {
      const r = String(x?.reason || '')
        .toLowerCase()
        .trim();
      if (
        ['quotaexceeded', 'ratelimitexceeded', 'userratelimitexceeded', 'backenderror'].includes(r) ||
        r.includes('quota') ||
        r.includes('rate')
      ) {
        return true;
      }
    }
  }
  const msg = formatYoutubeDataApiError(err).toLowerCase();
  if (
    /\b429\b/.test(msg) ||
    /rate.?limit|too many requests|quota exceeded|user rate|upload.?limit|daily.?limit|exceeded the number|maximum number of uploads|resource.?exhausted|backend error/i.test(
      msg
    )
  ) {
    return true;
  }
  return false;
}

export function getOAuthClient() {
  const { clientId, clientSecret, redirectUri } = googleOAuthEnvFromProcess();
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('YouTube OAuth env vars missing (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, YOUTUBE_REDIRECT_URI)');
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export function authUrl(state) {
  const oauth2 = getOAuthClient();
  return oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/youtube.upload',
      'https://www.googleapis.com/auth/youtube.readonly',
      'https://www.googleapis.com/auth/yt-analytics.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ],
    state,
  });
}

export async function exchangeCode(code) {
  const oauth2 = getOAuthClient();
  const { tokens } = await oauth2.getToken(code);
  oauth2.setCredentials(tokens);
  let google_account_email = null;
  try {
    const oauth2User = google.oauth2({ version: 'v2', auth: oauth2 });
    const { data } = await oauth2User.userinfo.get();
    google_account_email = data.email || null;
  } catch {
    /* optional if scopes missing */
  }
  const youtube = google.youtube({ version: 'v3', auth: oauth2 });
  const ch = await youtube.channels.list({ part: ['snippet'], mine: true });
  const item = ch.data.items?.[0];
  return {
    refresh_token: tokens.refresh_token || null,
    channel_id: item?.id || null,
    channel_title: item?.snippet?.title || null,
    google_account_email,
  };
}

export async function setYoutubeVideoThumbnail(refreshToken, videoId, imagePath) {
  const oauth2 = getOAuthClient();
  oauth2.setCredentials({ refresh_token: refreshToken });
  const youtube = google.youtube({ version: 'v3', auth: oauth2 });
  await youtube.thumbnails.set({
    videoId,
    media: {
      mimeType: imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg',
      body: createReadStream(imagePath),
    },
  });
}

/** Default cap for resumable `videos.insert` (large files / slow uplink). Override with `YOUTUBE_UPLOAD_TIMEOUT_MS`. */
const DEFAULT_VIDEO_INSERT_TIMEOUT_MS = 150 * 60 * 1000;

export async function uploadVideo({
  refreshToken,
  filePath,
  title,
  description,
  tags = [],
  privacyStatus = 'private',
  publishAt,
  thumbnailPath,
}) {
  const oauth2 = getOAuthClient();
  oauth2.setCredentials({ refresh_token: refreshToken });
  const youtube = google.youtube({ version: 'v3', auth: oauth2 });

  const fileBase = basename(filePath);
  if (existsSync(filePath)) {
    try {
      const [dur, { width, height }] = await Promise.all([
        probeVideoDurationSeconds(filePath),
        probePrimaryVideoStreamSize(filePath),
      ]);
      if (dur >= YOUTUBE_SHORT_STRICT_MAX_SEC) {
        throw new Error(
          `This file is about ${dur.toFixed(2)}s — Shorts must be **strictly under** 3:00 (less than ${YOUTUBE_SHORT_STRICT_MAX_SEC}s). Split or shorten the export, then schedule again.`
        );
      }
      if (width > height) {
        throw new Error(
          `Video is ${width}×${height} (wider than tall). YouTube Shorts need portrait or square — export 9:16 (height ≥ width), then schedule again.`
        );
      }
    } catch (e) {
      if (isYoutubeShortsPrecheckError(e)) throw e;
      console.warn('[youtube upload] Shorts pre-upload probe skipped', e?.message || e);
    }
  }

  const body = {
    snippet: {
      /** Title carries only the story title (+ “Part i of n”); the Shorts signal lives in the description/tags. */
      title: clipYoutubeVideoTitle(title || fileBase, fileBase),
      description: ensureShortsDescriptionLead(description || ''),
      tags: tags.length ? tags : undefined,
      categoryId: '22',
    },
    status: {
      privacyStatus,
      selfDeclaredMadeForKids: false,
    },
  };

  if (publishAt) {
    const t = new Date(publishAt).getTime();
    const minFuture = Date.now() + YOUTUBE_PUBLISH_AT_MIN_LEAD_MS;
    if (t > minFuture) {
      body.status.publishAt = new Date(publishAt).toISOString();
      body.status.privacyStatus = 'private';
    }
  }

  const insertTimeoutMs = Math.max(
    120_000,
    Number(process.env.YOUTUBE_UPLOAD_TIMEOUT_MS) || DEFAULT_VIDEO_INSERT_TIMEOUT_MS
  );
  let lastProgressLog = 0;
  let res;
  try {
    res = await youtube.videos.insert(
      {
        part: ['snippet', 'status'],
        requestBody: body,
        media: {
          mimeType: 'video/mp4',
          body: createReadStream(filePath),
        },
      },
      {
        onUploadProgress: () => {
          const now = Date.now();
          if (now - lastProgressLog < 45_000) return;
          lastProgressLog = now;
          console.log('[youtube upload] still sending', basename(filePath));
        },
        timeout: insertTimeoutMs,
      }
    );
  } catch (e) {
    const base = formatYoutubeDataApiError(e);
    if (/timeout|ETIMEDOUT|ECONNRESET/i.test(String(e?.message || e) + base)) {
      throw new Error(
        `${base} (If this is a timeout, set YOUTUBE_UPLOAD_TIMEOUT_MS in .env or try a smaller export / faster connection.)`
      );
    }
    const err = new Error(base);
    if (isYouTubeQuotaOrRateLimitError(e)) {
      err.youtubeRateLimited = true;
    }
    throw err;
  }

  const id = res.data.id;
  const skipThumb = String(process.env.YOUTUBE_SKIP_CUSTOM_THUMBNAIL_ON_UPLOAD || '').trim() === '1';
  if (id && thumbnailPath && !skipThumb) {
    try {
      await setYoutubeVideoThumbnail(refreshToken, id, thumbnailPath);
    } catch (e) {
      console.warn('[youtube upload] thumbnail set failed', e?.message || e);
    }
  }

  return { id, snippet: res.data.snippet, status: res.data.status };
}
