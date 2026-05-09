import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';

export default function Settings() {
  const [params] = useSearchParams();
  const yt = params.get('youtube');
  const [status, setStatus] = useState<{ connected: boolean; connection: unknown } | null>(null);

  useEffect(() => {
    api<{ connected: boolean; connection: unknown }>('/api/youtube/status')
      .then(setStatus)
      .catch(() => setStatus({ connected: false, connection: null }));
  }, []);

  async function connect() {
    const { url } = await api<{ url: string }>('/api/youtube/auth-url');
    window.location.href = url;
  }

  return (
    <div className="page">
      <header className="topbar">
        <h1>Settings</h1>
        <Link to="/app">← App</Link>
      </header>

      {yt === 'connected' && <p className="success">YouTube channel linked.</p>}
      {yt === 'error' && <p className="error">YouTube connection failed. Check API credentials.</p>}

      <section className="card">
        <h2>YouTube channel</h2>
        {status?.connected ? (
          <p>
            Connected
            <pre>{JSON.stringify(status.connection, null, 2)}</pre>
          </p>
        ) : (
          <p>Not connected — uploads will stay queued until OAuth succeeds.</p>
        )}
        <button type="button" onClick={() => connect()}>
          Connect with Google
        </button>
      </section>
    </div>
  );
}
