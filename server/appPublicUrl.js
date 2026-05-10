/**
 * Browser origin where the SPA is served: protocol + host + port only.
 * Strips any path (e.g. PUBLIC_APP_URL=http://localhost:5173/app would otherwise
 * produce broken redirects like /app/app/settings).
 *
 * Set PUBLIC_APP_URL to the exact origin you use in the address bar (including
 * localhost vs 127.0.0.1) so JWT in localStorage matches after OAuth redirects.
 */
export function appPublicOrigin() {
  const raw = (process.env.PUBLIC_APP_URL || 'http://localhost:5173').trim();
  if (!raw) return 'http://localhost:5173';
  try {
    const withProto = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(raw) ? raw : `http://${raw}`;
    const u = new URL(withProto);
    return `${u.protocol}//${u.host}`;
  } catch {
    console.warn('[PUBLIC_APP_URL] invalid, using http://localhost:5173');
    return 'http://localhost:5173';
  }
}
