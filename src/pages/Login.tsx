import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth';

export default function Login() {
  const { login, register, token, loading } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const refCode = useMemo(() => params.get('ref'), [params]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!loading && token) nav('/app', { replace: true });
  }, [loading, token, nav]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr('');
    try {
      if (mode === 'login') await login(email, password);
      else await register(email, password, name || undefined, refCode || undefined);
      nav('/app');
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Failed');
    }
  }

  return (
    <div className="auth-page">
      <h1>Shorts Studio</h1>
      <p className="lead">
        Text → voiceover · captions · gameplay background · YouTube
        {refCode ? (
          <span className="hint">
            {' '}
            Referral applied: <code>{refCode}</code>
          </span>
        ) : null}
      </p>
      <form onSubmit={submit} className="card">
        {mode === 'register' && (
          <label>
            Display name
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
        )}
        <label>
          Email
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
        </label>
        <label>
          Password
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          />
        </label>
        {err && <p className="error">{err}</p>}
        <button type="submit">{mode === 'login' ? 'Sign in' : 'Create account'}</button>
        <button
          type="button"
          className="linkish"
          onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
        >
          {mode === 'login' ? 'Need an account? Register' : 'Have an account? Sign in'}
        </button>
      </form>
      <Link to="/">← Back</Link>
    </div>
  );
}
