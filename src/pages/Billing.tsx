import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';

export default function Billing() {
  const [params] = useSearchParams();
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (params.get('success')) setMsg('Checkout completed — webhook should upgrade your plan shortly.');
    if (params.get('canceled')) setMsg('Checkout canceled.');
  }, [params]);

  async function checkout() {
    try {
      const { url } = await api<{ url: string }>('/api/billing/checkout', { method: 'POST' });
      if (url) window.location.href = url;
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Stripe not configured');
    }
  }

  return (
    <div className="page">
      <header className="topbar">
        <h1>Billing</h1>
        <Link to="/app">← App</Link>
      </header>
      <section className="card">
        <h2>Pro plan</h2>
        <p>
          Checkout uses your backend (<code>POST /api/billing/checkout</code>). Set env vars, then use the button below.
        </p>
        <ol className="billing-steps">
          <li>
            <strong>STRIPE_SECRET_KEY</strong> — Stripe Dashboard → Developers → API keys → Secret key (test mode for
            dev).
          </li>
          <li>
            <strong>STRIPE_PRICE_PRO</strong> — Products → add a subscription product → copy the <strong>Price</strong>{' '}
            id (<code>price_…</code>), not the product id.
          </li>
          <li>
            <strong>PUBLIC_APP_URL</strong> — SPA origin only, e.g. <code>http://localhost:5173</code> (no{' '}
            <code>/app</code> path). Must match the address bar (including <code>localhost</code> vs{' '}
            <code>127.0.0.1</code>) so redirects land with your session.
          </li>
          <li>
            <strong>STRIPE_WEBHOOK_SECRET</strong> — Developers → Webhooks → add endpoint{' '}
            <code>https://your-api/api/billing/webhook</code>, event <code>checkout.session.completed</code>, copy signing
            secret. For local dev: install{' '}
            <a href="https://stripe.com/docs/stripe-cli" target="_blank" rel="noreferrer">
              Stripe CLI
            </a>{' '}
            and run{' '}
            <code>
              stripe listen --forward-to localhost:8787/api/billing/webhook
            </code>{' '}
            — paste the CLI webhook signing secret into <code>.env</code>.
          </li>
        </ol>
        <p className="hint">
          Restart the API after changing <code>.env</code>. Successful Checkout triggers the webhook which sets{' '}
          <code>plan = pro</code> on your user.
        </p>
        {msg && <p className="success">{msg}</p>}
        <button type="button" onClick={() => checkout()}>
          Upgrade with Stripe
        </button>
      </section>
    </div>
  );
}
