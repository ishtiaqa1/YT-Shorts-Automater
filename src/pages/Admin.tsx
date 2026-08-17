import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';

type Stats = {
  total_users?: number;
  users_by_plan?: { plan: string; n: number }[];
  videos_rendered_this_week?: number;
  videos_uploaded_this_week?: number;
  revenue_estimate_cents_last_7d?: number;
  note?: string;
};

export default function Admin() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    setErr('');
    api<{ total_users?: number } & Stats>('/api/admin/stats')
      .then((s) => setStats(s))
      .catch(() => setErr('Forbidden or not configured (set ADMIN_EMAIL to your login email).'));
  }, []);

  return (
    <div className="page">
      <header className="topbar">
        <h1>Admin</h1>
        <Link to="/app">← App</Link>
      </header>

      {err && <p className="error">{err}</p>}

      {!err && stats && (
        <section className="card">
          <h2>Rough platform stats</h2>
          {stats.note && <p className="hint">{stats.note}</p>}
          <p>
            Users: <strong>{stats.total_users ?? '—'}</strong>
          </p>
          <h3 className="admin-subhead">Plans</h3>
          <ul>
            {(stats.users_by_plan || []).map((r) => (
              <li key={r.plan || 'unknown'}>
                <code>{r.plan || '?'}</code> — {r.n}
              </li>
            ))}
          </ul>
          <p>
            Renders finished (7d): <strong>{stats.videos_rendered_this_week ?? '—'}</strong>
          </p>
          <p>
            YouTube uploads (7d): <strong>{stats.videos_uploaded_this_week ?? '—'}</strong>
          </p>
          <p>
            Revenue estimate (paid invoices diagnostic, cents, 7d):{' '}
            <strong>{stats.revenue_estimate_cents_last_7d ?? 0}</strong>
          </p>
        </section>
      )}
    </div>
  );
}
