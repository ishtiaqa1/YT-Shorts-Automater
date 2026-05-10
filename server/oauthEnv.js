/**
 * Normalize Google OAuth client strings from process.env / .env files.
 * Fixes common issues: UTF-8 BOM, stray CR, wrapping quotes, trailing spaces.
 */
export function cleanGoogleOAuthString(s) {
  if (s == null) return '';
  let t = String(s);
  t = t.replace(/^\uFEFF/, '');
  t = t.replace(/\r/g, '').trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1).trim();
  }
  return t;
}

export function googleOAuthEnvFromProcess() {
  return {
    clientId: cleanGoogleOAuthString(process.env.GOOGLE_CLIENT_ID),
    clientSecret: cleanGoogleOAuthString(process.env.GOOGLE_CLIENT_SECRET),
    redirectUri: cleanGoogleOAuthString(process.env.YOUTUBE_REDIRECT_URI),
  };
}
