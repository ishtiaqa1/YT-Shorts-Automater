import { google } from 'googleapis';
import { createReadStream } from 'fs';
import { basename } from 'path';
import { googleOAuthEnvFromProcess } from '../oauthEnv.js';

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

export async function uploadVideo({
  refreshToken,
  filePath,
  title,
  description,
  tags = [],
  privacyStatus = 'private',
  publishAt,
}) {
  const oauth2 = getOAuthClient();
  oauth2.setCredentials({ refresh_token: refreshToken });
  const youtube = google.youtube({ version: 'v3', auth: oauth2 });

  const body = {
    snippet: {
      title: title || basename(filePath),
      description: description || '',
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
    const minFuture = Date.now() + 10 * 60 * 1000;
    if (t > minFuture) {
      body.status.publishAt = new Date(publishAt).toISOString();
      body.status.privacyStatus = 'private';
    }
  }

  const res = await youtube.videos.insert(
    {
      part: ['snippet', 'status'],
      requestBody: body,
      media: {
        mimeType: 'video/mp4',
        body: createReadStream(filePath),
      },
    },
    {
      onUploadProgress: () => {},
    }
  );

  return { id: res.data.id, snippet: res.data.snippet, status: res.data.status };
}
