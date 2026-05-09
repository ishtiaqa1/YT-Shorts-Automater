import { google } from 'googleapis';
import { createReadStream } from 'fs';
import { basename } from 'path';

export function getOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.YOUTUBE_REDIRECT_URI;
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
    scope: ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'],
    state,
  });
}

export async function exchangeCode(code) {
  const oauth2 = getOAuthClient();
  const { tokens } = await oauth2.getToken(code);
  oauth2.setCredentials(tokens);
  const youtube = google.youtube({ version: 'v3', auth: oauth2 });
  const ch = await youtube.channels.list({ part: ['snippet'], mine: true });
  const item = ch.data.items?.[0];
  return {
    refresh_token: tokens.refresh_token || null,
    channel_id: item?.id || null,
    channel_title: item?.snippet?.title || null,
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
