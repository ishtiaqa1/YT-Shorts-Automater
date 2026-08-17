import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';

const COMMON_TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Toronto',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Dubai',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Australia/Sydney',
];

type YtConn = {
  id: string;
  channel_id: string;
  channel_title: string | null;
  google_account_email: string | null;
  is_default: boolean;
  updated_at: string;
};

type TtConn = {
  id: string;
  open_id: string;
  creator_username: string | null;
  creator_nickname: string | null;
  is_default: boolean;
  updated_at: string;
};

const YOUTUBE_OAUTH_ERROR_HELP: Record<string, string> = {
  access_denied: 'Google sign-in was canceled or blocked. Try again and choose an account; if you use a Workspace org, an admin may need to allow this app.',
  google_oauth: 'Google returned an error during sign-in. Check the Google Cloud OAuth consent screen and authorized domains.',
  missing_params: 'The callback URL was missing authorization data. Try Connect again; if it keeps happening, confirm YOUTUBE_REDIRECT_URI in .env exactly matches the URI in Google Cloud (including http vs https and port).',
  bad_state: 'The sign-in session expired or the server JWT_SECRET changed. Go back to Settings and start Connect again while logged into Shorts Studio.',
  invalid_grant: 'The authorization code was invalid or already used. Start Connect again from Settings (do not refresh the Google callback tab).',
  redirect_mismatch: 'Redirect URI mismatch: in Google Cloud → Credentials → your OAuth client, the authorized redirect URI must exactly match YOUTUBE_REDIRECT_URI in your API .env (e.g. http://localhost:8787/api/youtube/oauth/callback).',
  invalid_client:
    'Google rejected the OAuth client (often “client secret is invalid”). Use an OAuth client of type Web application (not Desktop). Copy Client ID and Client secret from that same client’s detail page into .env — put the secret on its own line with no inline # comment after it (dotenv can truncate the value). Restart the API and confirm the startup line shows the expected redirect_uri (http://localhost:8787/api/youtube/oauth/callback for local). If lengths look right but it still fails, create a new Web client in the same project, paste the new pair into .env, and add the same redirect URI to the new client.',
  youtube_api_disabled:
    'YouTube Data API v3 is off (or not yet visible) for the same Google Cloud project as your OAuth client. In that project: APIs & Services → Library → search “YouTube Data API v3” → Enable. If you just enabled it, wait 2–5 minutes, restart nothing required, then use Connect with Google again. The API error in your server log includes a direct “overview” link with the correct project id.',
  youtube_api_quota: 'YouTube/Google returned a quota or rate limit error. Wait a bit, ensure billing/quota is OK on the GCP project, then try again.',
  insufficient_scope: 'The granted scopes were not enough for YouTube. Disconnect, revoke the app under Google Account → Security, then connect again from Settings.',
  no_channel: 'This Google account does not have a YouTube channel (or none was returned). Open YouTube once and create a channel, or pick the Google account that owns the channel.',
  no_refresh_token:
    'Google did not return a refresh token. Disconnect this channel in Shorts Studio if it appears broken, or in Google Account → Security → Third-party access revoke “YT-Shorts” / your app, then connect again.',
  token_exchange:
    'Google token or YouTube API call failed after sign-in. On the machine running the API, look for a log line starting with [youtube oauth] exchangeCode — it usually names the real issue (redirect URI, disabled API, wrong client secret).',
  database: 'Saving the connection to Postgres failed (schema mismatch, constraint, or DB down). Check DATABASE_URL, run the API so migrations apply, and read the [youtube oauth] database log line.',
  unexpected: 'An unexpected error occurred after Google returned a code. Restart the API and try again; check server logs for [youtube oauth].',
  legacy_no_reason:
    'The error link did not include a reason code (often an older API build or a truncated URL). Restart the Node API so the latest YouTube route is running, then use Connect with Google again. If it still fails, copy the full address from the browser bar after returning from Google.',
  unknown: 'Something went wrong. Check the machine running the API logs when you click Connect and return from Google.',
};

type ReferralStats = {
  my_code: string | null;
  referred_users: { id: string; email: string; plan: string; created_at: string }[];
};

export default function Settings() {
  const { user, refreshUser } = useAuth();
  const [params] = useSearchParams();
  const yt = params.get('youtube');
  const tik = params.get('tiktok');
  const rawReason = params.get('reason');
  const ytReason =
    rawReason && rawReason !== 'undefined' && rawReason !== 'null' ? rawReason : '';
  const [connections, setConnections] = useState<YtConn[]>([]);
  const [tiktokConnections, setTiktokConnections] = useState<TtConn[]>([]);
  const [tz, setTz] = useState(user?.timezone || 'UTC');
  const [tzMsg, setTzMsg] = useState('');
  const [ytErr, setYtErr] = useState('');
  const [tiktokErr, setTiktokErr] = useState('');
  const [refStats, setRefStats] = useState<ReferralStats | null>(null);
  const [refErr, setRefErr] = useState('');

  async function loadYoutube() {
    try {
      const d = await api<{ connections: YtConn[]; connected: boolean }>('/api/youtube/status');
      setConnections(d.connections || []);
      setYtErr('');
    } catch {
      setConnections([]);
      setYtErr('Could not load YouTube status');
    }
  }

  async function loadTiktok() {
    try {
      const d = await api<{ connections: TtConn[]; connected: boolean }>('/api/tiktok/status');
      setTiktokConnections(d.connections || []);
      setTiktokErr('');
    } catch {
      setTiktokConnections([]);
      setTiktokErr('Could not load TikTok status');
    }
  }

  useEffect(() => {
    void loadYoutube();
    void loadTiktok();
  }, []);

  useEffect(() => {
    setRefErr('');
    api<ReferralStats>('/api/referrals/stats')
      .then((d) => setRefStats(d))
      .catch(() => setRefErr('Could not load referral stats'));
  }, []);

  useEffect(() => {
    if (yt === 'connected' || yt === 'error') {
      void loadYoutube();
      void refreshUser();
    }
  }, [yt, refreshUser]);

  useEffect(() => {
    if (tik === 'connected' || tik === 'error') {
      void loadTiktok();
      void refreshUser();
    }
  }, [tik, refreshUser]);

  useEffect(() => {
    setTz(user?.timezone || 'UTC');
  }, [user?.timezone]);

  async function connect() {
    setYtErr('');
    try {
      const { url } = await api<{ url: string }>('/api/youtube/auth-url');
      window.location.href = url;
    } catch (e) {
      setYtErr(e instanceof Error ? e.message : 'Could not start OAuth');
    }
  }

  async function setDefault(connId: string) {
    setYtErr('');
    try {
      const d = await api<{ connections: YtConn[] }>(`/api/youtube/connections/${connId}/default`, {
        method: 'POST',
      });
      setConnections(d.connections);
    } catch (e) {
      setYtErr(e instanceof Error ? e.message : 'Failed');
    }
  }

  async function disconnect(connId: string) {
    setYtErr('');
    try {
      await api(`/api/youtube/connections/${connId}`, { method: 'DELETE' });
      await loadYoutube();
    } catch (e) {
      setYtErr(e instanceof Error ? e.message : 'Failed');
    }
  }

  async function connectTiktok() {
    setTiktokErr('');
    try {
      const { url } = await api<{ url: string }>('/api/tiktok/auth-url');
      window.location.href = url;
    } catch (e) {
      setTiktokErr(e instanceof Error ? e.message : 'Could not start TikTok OAuth');
    }
  }

  async function setTiktokDefault(connId: string) {
    setTiktokErr('');
    try {
      const d = await api<{ connections: TtConn[] }>(`/api/tiktok/connections/${connId}/default`, {
        method: 'POST',
      });
      setTiktokConnections(d.connections);
    } catch (e) {
      setTiktokErr(e instanceof Error ? e.message : 'Failed');
    }
  }

  async function disconnectTiktok(connId: string) {
    setTiktokErr('');
    try {
      await api(`/api/tiktok/connections/${connId}`, { method: 'DELETE' });
      await loadTiktok();
    } catch (e) {
      setTiktokErr(e instanceof Error ? e.message : 'Failed');
    }
  }

  async function saveTimezone() {
    setTzMsg('');
    try {
      await api('/api/auth/me', { method: 'PATCH', body: JSON.stringify({ timezone: tz }) });
      await refreshUser();
      try {
        localStorage.setItem('shorts_tz_bump', String(Date.now()));
      } catch {
        /* private mode */
      }
      setTzMsg(
        'Timezone saved. Calendar, editor schedule labels, and diagnostics use this zone after refresh — other browser tabs pick it up automatically.'
      );
    } catch (e) {
      setTzMsg(e instanceof Error ? e.message : 'Save failed');
    }
  }

  return (
    <div className="page">
      <header className="topbar">
        <h1>Settings</h1>
        <Link to="/app">← App</Link>
      </header>

      <section className="card">
        <h2>Account</h2>
        <p>
          Signed in as <strong>{user?.email}</strong>
          {user?.display_name ? (
            <>
              {' '}
              ({user.display_name})
            </>
          ) : null}
        </p>
      </section>

      <section className="card">
        <h2>Referrals</h2>
        <p className="hint">
          Share your signup link. When someone creates an account with your code, we store the relationship for your
          records.
        </p>
        {refErr && <p className="error">{refErr}</p>}
        {refStats?.my_code ? (
          <>
            <p>
              Your code: <code>{refStats.my_code}</code>
            </p>
            <p className="hint mono">
              {typeof window !== 'undefined'
                ? `${window.location.origin}/login?ref=${encodeURIComponent(refStats.my_code)}`
                : null}
            </p>
            <button
              type="button"
              className="secondary-btn"
              onClick={() => {
                const link = `${window.location.origin}/login?ref=${encodeURIComponent(refStats.my_code || '')}`;
                void navigator.clipboard.writeText(link).catch(() => {});
              }}
            >
              Copy invite link
            </button>
            <h3 className="admin-subhead">Referred accounts</h3>
            {refStats.referred_users?.length ? (
              <ul>
                {refStats.referred_users.map((u) => (
                  <li key={u.id}>
                    {u.email} · <span className="badge">{u.plan}</span> · joined {new Date(u.created_at).toLocaleDateString()}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="hint">No referred signups yet.</p>
            )}
          </>
        ) : (
          <p className="hint">No referral code on file yet — open the app again after registration.</p>
        )}
      </section>

      <section className="card">
        <h2>Timezone</h2>
        <p className="hint">
          Used to label scheduled publish times. Pick the zone you think in when planning uploads (IANA names, e.g.{' '}
          <code>America/New_York</code>).
        </p>
        <label>
          Region
          <select
            value={COMMON_TIMEZONES.includes(tz) ? tz : '__custom__'}
            onChange={(e) => {
              const v = e.target.value;
              if (v === '__custom__') return;
              setTz(v);
            }}
          >
            {COMMON_TIMEZONES.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
            <option value="__custom__">Custom…</option>
          </select>
        </label>
        <label>
          Custom IANA timezone (if not in list)
          <input
            value={COMMON_TIMEZONES.includes(tz) ? '' : tz}
            placeholder="America/Vancouver"
            onChange={(e) => setTz(e.target.value.trim() || 'UTC')}
          />
        </label>
        <button type="button" onClick={() => void saveTimezone()}>
          Save timezone
        </button>
        {tzMsg && <p className={tzMsg.includes('failed') || tzMsg.includes('must') ? 'error' : 'success'}>{tzMsg}</p>}
      </section>

      <section className="card">
        <h2>YouTube channels</h2>
        <p className="hint">
          Connect multiple Google accounts. The <strong>default</strong> channel is used for uploads unless you pick
          another when scheduling a video.
        </p>

        {yt === 'connected' && <p className="success">YouTube linked — refresh if the list below is empty.</p>}
        {yt === 'error' && (
          <div className="error" role="alert">
            <p>
              <strong>YouTube connection failed.</strong>{' '}
              {(ytReason && YOUTUBE_OAUTH_ERROR_HELP[ytReason]) ||
                (!ytReason ? YOUTUBE_OAUTH_ERROR_HELP.legacy_no_reason : YOUTUBE_OAUTH_ERROR_HELP.unknown)}
            </p>
            {ytReason && !YOUTUBE_OAUTH_ERROR_HELP[ytReason] ? (
              <p className="hint">Reason code: {ytReason}</p>
            ) : null}
          </div>
        )}
        {ytErr && <p className="error">{ytErr}</p>}

        {connections.length === 0 ? (
          <p>No channels connected yet.</p>
        ) : (
          <ul className="yt-conn-list">
            {connections.map((c) => (
              <li key={c.id} className="yt-conn-item">
                <div>
                  <strong>{c.channel_title || 'Channel'}</strong>
                  {c.is_default && <span className="pill">default</span>}
                  <div className="hint">
                    {c.google_account_email || c.channel_id}
                    {c.google_account_email && c.channel_id ? ` · ${c.channel_id}` : null}
                  </div>
                </div>
                <div className="yt-conn-actions">
                  {!c.is_default && (
                    <button type="button" className="linkish" onClick={() => void setDefault(c.id)}>
                      Set default
                    </button>
                  )}
                  <button type="button" className="linkish" onClick={() => void disconnect(c.id)}>
                    Disconnect
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <button type="button" onClick={() => void connect()}>
          {connections.length ? 'Connect another Google account' : 'Connect with Google'}
        </button>
      </section>

      <section className="card">
        <h2>TikTok accounts</h2>
        <p className="hint">
          Uses TikTok&apos;s Content Posting API (direct post). Register an app at{' '}
          <a href="https://developers.tiktok.com/" target="_blank" rel="noreferrer">
            developers.tiktok.com
          </a>
          , add Login Kit + Content Posting, and set <code>TIKTOK_REDIRECT_URI</code> to an <strong>https</strong> URL
          (TikTok rejects plain http) — e.g. <code>https://your-api.example.com/api/tiktok/oauth/callback</code>. Unaudited
          apps may only post privately until TikTok completes app review.
        </p>
        {tik === 'connected' && <p className="success">TikTok linked — refresh if the list below is empty.</p>}
        {tik === 'error' && (
          <div className="error" role="alert">
            <p>
              <strong>TikTok connection failed.</strong> Check server logs for <code>[tiktok oauth]</code>, verify{' '}
              <code>TIKTOK_CLIENT_KEY</code>, <code>TIKTOK_CLIENT_SECRET</code>, and redirect URI match the TikTok
              portal, and that scopes include <code>video.publish</code>.
            </p>
            {rawReason ? <p className="hint">Reason code: {rawReason}</p> : null}
          </div>
        )}
        {tiktokErr && <p className="error">{tiktokErr}</p>}
        {tiktokConnections.length === 0 ? (
          <p>No TikTok accounts connected yet.</p>
        ) : (
          <ul className="yt-conn-list">
            {tiktokConnections.map((c) => (
              <li key={c.id} className="yt-conn-item">
                <div>
                  <strong>{c.creator_nickname || c.creator_username || 'TikTok account'}</strong>
                  {c.is_default && <span className="pill">default</span>}
                  <div className="hint mono">{c.open_id}</div>
                </div>
                <div className="yt-conn-actions">
                  {!c.is_default && (
                    <button type="button" className="linkish" onClick={() => void setTiktokDefault(c.id)}>
                      Set default
                    </button>
                  )}
                  <button type="button" className="linkish" onClick={() => void disconnectTiktok(c.id)}>
                    Disconnect
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <button type="button" onClick={() => void connectTiktok()}>
          {tiktokConnections.length ? 'Connect another TikTok account' : 'Connect TikTok'}
        </button>
      </section>
    </div>
  );
}
