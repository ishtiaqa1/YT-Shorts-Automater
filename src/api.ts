const rawBase = String(import.meta.env.VITE_API_URL ?? '')
  .trim()
  .replace(/^['"]|['"]$/g, '');

/** Base origin only (no trailing `/api`). Paths in this app are always `/api/...`. */
export function resolveApiOrigin(): string {
  let b = rawBase.replace(/\/+$/, '');
  if (/^https?:\/\//i.test(b) && /\/api$/i.test(b)) {
    b = b.replace(/\/api$/i, '').replace(/\/+$/, '');
  }

  /**
   * Default dev: always hit same-origin `/api` (Vite proxy → `server/index.js`).
   * If `.env` sets `VITE_API_URL` to another host (staging, LAN IP, etc.), unchanged code *looks*
   * broken because the browser never talks to your local API.
   *
   * Opt out: `VITE_DEV_USE_CONFIGURED_ORIGIN=1` restores use of `VITE_API_URL`.
   */
  const devUseConfigured =
    import.meta.env.DEV && String(import.meta.env.VITE_DEV_USE_CONFIGURED_ORIGIN ?? '').trim() === '1';

  if (import.meta.env.DEV && typeof window !== 'undefined' && !devUseConfigured) {
    return '';
  }

  /**
   * Optional: when both SPA and API URLs are loopback, prefer proxy to avoid cross-origin quirks
   * (e.g. localhost vs 127.0.0.1) while `VITE_DEV_USE_CONFIGURED_ORIGIN=1`.
   */
  if (import.meta.env.DEV && typeof window !== 'undefined' && devUseConfigured && b) {
    try {
      const loc = window.location;
      const spaLocal = loc.hostname === 'localhost' || loc.hostname === '127.0.0.1';
      const u = new URL(b);
      const apiLocal = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
      if (spaLocal && apiLocal) return '';
    } catch {
      /* bad VITE_API_URL — fall through */
    }
  }

  return b;
}

export function getToken() {
  return localStorage.getItem('token');
}

export class ApiHttpError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;

  constructor(message: string, status: number, body: Record<string, unknown>) {
    super(message);
    this.name = 'ApiHttpError';
    this.status = status;
    this.body = body;
  }
}

export async function api<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  const token = getToken();
  const base = resolveApiOrigin();
  const headers = new Headers(opts.headers);
  if (opts.body && !(opts.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  if (token) headers.set('Authorization', `Bearer ${token}`);
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      ...opts,
      headers,
      /** Avoid stale GET responses overwriting in-flight UI after PATCH (caption_settings etc.). */
      cache: opts.cache ?? 'no-store',
    });
  } catch (e) {
    const devHint =
      import.meta.env.DEV && !base ? ' Start the API (e.g. npm run dev:server) so Vite can proxy /api.' : '';
    const msg =
      e instanceof TypeError
        ? `${e.message.includes('fetch') ? 'Cannot reach API' : (e.message || 'Network error')}.${devHint}`
        : String(e);
    throw new Error(msg, { cause: e });
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    let msg =
      (err as { error?: string }).error || `${res.status} ${res.statusText || 'request failed'}`;
    const m = msg.trim();
    /** Some routes use 502 for transient upstream/API failures — not always a dead local API process. */
    const looksLikeDeadProxy =
      !m ||
      /^502(\s|$)/i.test(m) ||
      m.toLowerCase().includes('bad gateway') ||
      m.toLowerCase().includes('econnrefused');
    if (import.meta.env.DEV && base === '' && res.status === 502 && looksLikeDeadProxy) {
      msg = `${m}. If the API really exited, check the dev:server terminal (often database / initDb).`;
    }
    throw new ApiHttpError(msg.trim(), res.status, err as Record<string, unknown>);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/**
 * Robust project delete across DELETE / POST fallbacks — some proxies and preflight stacks are picky.
 */
export async function apiDeleteProject(projectId: string): Promise<void> {
  const raw = projectId.trim();
  if (!raw) throw new Error('Project id required');
  const enc = encodeURIComponent(raw);
  const errors: string[] = [];

  const tryReq = async (label: string, fn: () => Promise<unknown>): Promise<boolean> => {
    try {
      await fn();
      return true;
    } catch (e) {
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  };

  if (await tryReq('DELETE', () => api(`/api/projects/${enc}`, { method: 'DELETE' }))) return;
  if (await tryReq('POST /:id/delete', () => api(`/api/projects/${enc}/delete`, { method: 'POST' }))) return;
  if (
    await tryReq('POST /delete', () =>
      api('/api/projects/delete', {
        method: 'POST',
        body: JSON.stringify({ project_id: raw }),
      })
    )
  )
    return;
  throw new Error(errors.join(' · ') || 'Could not delete project');
}

function isScheduleAlreadyGoneError(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /\b404\b/i.test(m) || /schedule not found/i.test(m);
}

/**
 * Remove a calendar schedule — POST body first (most reliable), then DELETE, then path POST.
 * Duplicate clicks / races: **404 = already removed** → treated as success (idempotent).
 */
export async function apiDeleteSchedule(scheduleId: string): Promise<void> {
  const raw = scheduleId.trim();
  if (!raw) throw new Error('Schedule id required');
  const enc = encodeURIComponent(raw);
  const errors: string[] = [];
  const tryReq = async (label: string, fn: () => Promise<unknown>): Promise<boolean> => {
    try {
      await fn();
      return true;
    } catch (e) {
      if (isScheduleAlreadyGoneError(e)) return true;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  };
  if (
    await tryReq('POST /delete', () =>
      api('/api/calendar/delete', {
        method: 'POST',
        body: JSON.stringify({ schedule_id: raw }),
      })
    )
  )
    return;
  if (await tryReq('DELETE', () => api(`/api/calendar/schedules/${enc}`, { method: 'DELETE' }))) return;
  if (await tryReq('POST /schedules/:id/delete', () => api(`/api/calendar/schedules/${enc}/delete`, { method: 'POST' }))) return;
  throw new Error(errors.join(' · ') || 'Could not remove schedule');
}

export async function fetchAuthorizedBlob(path: string): Promise<Blob> {
  const token = getToken();
  const base = resolveApiOrigin();
  const res = await fetch(`${base}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error('Failed to load file');
  return res.blob();
}
