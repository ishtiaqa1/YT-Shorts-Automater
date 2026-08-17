import { createReadStream, statSync } from 'fs';
import { open } from 'fs/promises';

const TIKTOK_AUTH = 'https://www.tiktok.com/v2/auth/authorize/';
const TIKTOK_TOKEN = 'https://open.tiktokapis.com/v2/oauth/token/';
const CREATOR_INFO = 'https://open.tiktokapis.com/v2/post/publish/creator_info/query/';
const VIDEO_INIT = 'https://open.tiktokapis.com/v2/post/publish/video/init/';
const STATUS_FETCH = 'https://open.tiktokapis.com/v2/post/publish/status/fetch/';

const DEFAULT_SCOPES = 'user.info.basic,video.publish';

export function tiktokOAuthEnv() {
  const clientKey = (process.env.TIKTOK_CLIENT_KEY || process.env.TIKTOK_CLIENT_ID || '').trim();
  const clientSecret = (process.env.TIKTOK_CLIENT_SECRET || '').trim();
  const redirectUri = (process.env.TIKTOK_REDIRECT_URI || '').trim();
  return { clientKey, clientSecret, redirectUri };
}

/**
 * @param {string} state
 * @returns {string}
 */
export function tiktokAuthUrl(state) {
  const { clientKey, redirectUri } = tiktokOAuthEnv();
  if (!clientKey || !redirectUri) {
    throw new Error('TIKTOK_CLIENT_KEY and TIKTOK_REDIRECT_URI must be set for TikTok OAuth');
  }
  const u = new URL(TIKTOK_AUTH);
  u.searchParams.set('client_key', clientKey);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', (process.env.TIKTOK_SCOPES || DEFAULT_SCOPES).trim());
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('state', state);
  u.searchParams.set('disable_auto_auth', '0');
  return u.toString();
}

async function postForm(url, params) {
  const body = new URLSearchParams(params).toString();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cache-Control': 'no-cache',
    },
    body,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`TikTok token HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  if (!res.ok) {
    const msg = json.error_description || json.error || json.message || text.slice(0, 400);
    throw new Error(`TikTok token HTTP ${res.status}: ${msg}`);
  }
  return json;
}

/**
 * @param {string} code
 */
export async function exchangeTiktokOAuthCode(code) {
  const { clientKey, clientSecret, redirectUri } = tiktokOAuthEnv();
  if (!clientSecret) throw new Error('TIKTOK_CLIENT_SECRET is not set');
  const json = await postForm(TIKTOK_TOKEN, {
    client_key: clientKey,
    client_secret: clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });
  const access = json.access_token || json.data?.access_token;
  const refresh = json.refresh_token || json.data?.refresh_token;
  const openId = json.open_id || json.data?.open_id;
  if (!access || !refresh || !openId) {
    throw new Error('TikTok token response missing access_token, refresh_token, or open_id');
  }
  return {
    access_token: access,
    refresh_token: refresh,
    open_id: String(openId),
    expires_in: Number(json.expires_in ?? json.data?.expires_in ?? 86400),
    refresh_expires_in: Number(json.refresh_expires_in ?? json.data?.refresh_expires_in ?? 0),
  };
}

/**
 * @param {string} refreshToken
 */
export async function refreshTiktokAccessToken(refreshToken) {
  const { clientKey, clientSecret } = tiktokOAuthEnv();
  if (!clientSecret) throw new Error('TIKTOK_CLIENT_SECRET is not set');
  const json = await postForm(TIKTOK_TOKEN, {
    client_key: clientKey,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const access = json.access_token || json.data?.access_token;
  const refresh = json.refresh_token || json.data?.refresh_token || refreshToken;
  const openId = json.open_id || json.data?.open_id;
  if (!access || !openId) {
    throw new Error('TikTok refresh response missing access_token or open_id');
  }
  return {
    access_token: access,
    refresh_token: refresh,
    open_id: String(openId),
    expires_in: Number(json.expires_in ?? json.data?.expires_in ?? 86400),
  };
}

async function postJson(url, accessToken, bodyObj) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify(bodyObj ?? {}),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`TikTok API ${url} HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  const errCode = json.error?.code ?? json.error_code;
  if (errCode && String(errCode).toLowerCase() !== 'ok') {
    throw new Error(json.error?.message || String(errCode));
  }
  if (!res.ok) {
    throw new Error(json.error?.message || `TikTok API HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  return json;
}

/**
 * @param {string} accessToken
 */
export async function queryCreatorInfo(accessToken) {
  const json = await postJson(CREATOR_INFO, accessToken, {});
  const d = json.data || json;
  const opts = Array.isArray(d.privacy_level_options) ? d.privacy_level_options : [];
  return {
    creator_username: d.creator_username || null,
    creator_nickname: d.creator_nickname || null,
    privacy_level_options: opts,
    max_video_post_duration_sec: Number(d.max_video_post_duration_sec ?? 600),
  };
}

/**
 * @param {string[]} options
 * @param {string} [youtubePrivacy] private | public | unlisted
 */
export function pickTiktokPrivacyLevel(options, youtubePrivacy) {
  const o = new Set(options.map((x) => String(x)));
  const priv = String(youtubePrivacy || 'private').toLowerCase();
  if (priv === 'private' && o.has('SELF_ONLY')) return 'SELF_ONLY';
  if (o.has('PUBLIC_TO_EVERYONE')) return 'PUBLIC_TO_EVERYONE';
  if (o.has('MUTUAL_FOLLOW_FRIENDS')) return 'MUTUAL_FOLLOW_FRIENDS';
  if (o.has('FOLLOWER_OF_CREATOR')) return 'FOLLOWER_OF_CREATOR';
  if (o.has('SELF_ONLY')) return 'SELF_ONLY';
  const first = options[0];
  if (first) return String(first);
  return 'SELF_ONLY';
}

/** TikTok caption limit (UTF-16 runes) — we approximate by JS string length. */
export function clipTiktokCaption(text, max = 2100) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  return s.slice(0, max).trimEnd();
}

/**
 * @param {number} size
 */
export function planTiktokFileChunks(size) {
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error('Invalid video size for TikTok upload');
  }
  const MAX = 64 * 1024 * 1024;
  const totalChunkCount = Math.max(1, Math.ceil(size / MAX));
  const chunkSize = Math.ceil(size / totalChunkCount);
  return { chunkSize, totalChunkCount, size };
}

/**
 * @param {string} uploadUrl
 * @param {string} filePath
 * @param {{ chunkSize: number; totalChunkCount: number; size: number }} plan
 */
export async function putVideoFileToTiktokUploadUrl(uploadUrl, filePath, plan) {
  const { chunkSize, totalChunkCount, size } = plan;
  const fh = await open(filePath, 'r');
  try {
    let offset = 0;
    for (let i = 0; i < totalChunkCount; i += 1) {
      const len = Math.min(chunkSize, size - offset);
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, offset);
      if (bytesRead !== len) {
        throw new Error(`Short read at offset ${offset} (expected ${len}, got ${bytesRead})`);
      }
      const start = offset;
      const end = offset + len - 1;
      offset += len;
      const res = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Length': String(len),
          'Content-Range': `bytes ${start}-${end}/${size}`,
        },
        body: buf,
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`TikTok chunk upload HTTP ${res.status}: ${t.slice(0, 400)}`);
      }
    }
  } finally {
    await fh.close().catch(() => {});
  }
}

/** Stream-based fallback for very large files (avoids huge Buffer.allocs). */
export async function putVideoFileToTiktokUploadUrlStream(uploadUrl, filePath, plan) {
  const { chunkSize, totalChunkCount, size } = plan;
  let offset = 0;
  for (let i = 0; i < totalChunkCount; i += 1) {
    const len = Math.min(chunkSize, size - offset);
    const start = offset;
    const end = offset + len - 1;
    offset += len;
    const stream = createReadStream(filePath, { start, end });
    const chunks = [];
    for await (const ch of stream) {
      chunks.push(ch);
    }
    const buf = Buffer.concat(chunks);
    if (buf.length !== len) {
      throw new Error(`Stream read size mismatch at bytes ${start}-${end}`);
    }
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': String(len),
        'Content-Range': `bytes ${start}-${end}/${size}`,
      },
      body: buf,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`TikTok chunk upload HTTP ${res.status}: ${t.slice(0, 400)}`);
    }
  }
}

/**
 * @param {object} opts
 * @param {string} opts.accessToken
 * @param {string} opts.filePath
 * @param {string} opts.title
 * @param {string} opts.privacyLevel
 * @param {boolean} [opts.markAiGenerated]
 */
export async function directPostVideoFile(opts) {
  const { accessToken, filePath, title, privacyLevel, markAiGenerated } = opts;
  const st = statSync(filePath);
  const size = st.size;
  const plan = planTiktokFileChunks(size);
  const initBody = {
    post_info: {
      title: clipTiktokCaption(title),
      privacy_level: privacyLevel,
      disable_duet: false,
      disable_stitch: false,
      disable_comment: false,
      ...(markAiGenerated ? { is_aigc: true } : {}),
    },
    source_info: {
      source: 'FILE_UPLOAD',
      video_size: size,
      chunk_size: plan.chunkSize,
      total_chunk_count: plan.totalChunkCount,
    },
  };
  const initJson = await postJson(VIDEO_INIT, accessToken, initBody);
  const data = initJson.data || initJson;
  const publishId = data.publish_id;
  const uploadUrl = data.upload_url;
  if (!publishId || !uploadUrl) {
    throw new Error('TikTok init did not return publish_id and upload_url');
  }
  if (size <= 48 * 1024 * 1024) {
    await putVideoFileToTiktokUploadUrl(uploadUrl, filePath, plan);
  } else {
    await putVideoFileToTiktokUploadUrlStream(uploadUrl, filePath, plan);
  }
  return { publish_id: String(publishId) };
}

/**
 * @param {string} accessToken
 * @param {string} publishId
 */
export async function fetchTiktokPublishStatus(accessToken, publishId) {
  const json = await postJson(STATUS_FETCH, accessToken, { publish_id: publishId });
  const d = json.data || json;
  return {
    status: String(d.status || ''),
    fail_reason: d.fail_reason ? String(d.fail_reason) : null,
    public_post_ids: Array.isArray(d.publicaly_available_post_id)
      ? d.publicaly_available_post_id.map(String)
      : [],
  };
}

/**
 * Poll until terminal state or timeout.
 * @param {string} accessToken
 * @param {string} publishId
 */
export async function waitForTiktokPublish(accessToken, publishId, options = {}) {
  const maxMs = options.maxMs ?? 6 * 60 * 1000;
  const stepMs = options.stepMs ?? 2500;
  const start = Date.now();
  let last = '';
  while (Date.now() - start < maxMs) {
    const s = await fetchTiktokPublishStatus(accessToken, publishId);
    last = s.status;
    if (s.status === 'PUBLISH_COMPLETE') {
      const pid = s.public_post_ids[0] || null;
      return { status: 'PUBLISH_COMPLETE', post_id: pid };
    }
    if (s.status === 'FAILED') {
      const err = new Error(s.fail_reason || 'TikTok publish FAILED');
      err.tiktokFailReason = s.fail_reason;
      throw err;
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(`TikTok publish timed out after ${maxMs}ms (last status: ${last || 'unknown'})`);
}

export function isTiktokRateLimitError(err) {
  const msg = String(err?.message || err);
  return /rate_limit|429|too many requests/i.test(msg) || err?.tiktokRateLimited === true;
}

export function tiktokPublicVideoUrl(postId) {
  if (!postId) return '';
  return `https://www.tiktok.com/video/${encodeURIComponent(postId)}`;
}
