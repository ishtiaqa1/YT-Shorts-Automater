import { Router } from 'express';
import Stripe from 'stripe';
import { appPublicOrigin } from '../appPublicUrl.js';
import { pool } from '../db.js';
import { authRequired } from '../middleware/auth.js';

const r = Router();

function stripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return new Stripe(key);
}

r.post('/portal', authRequired, async (req, res) => {
  const s = stripe();
  const origin = appPublicOrigin();
  if (!s || !origin) {
    res.status(503).json({ error: 'Stripe or PUBLIC_APP_URL not configured' });
    return;
  }
  const { rows } = await pool.query(`SELECT stripe_customer_id FROM users WHERE id = $1`, [req.user.sub]);
  const customerId = rows[0]?.stripe_customer_id;
  if (!customerId) {
    res.status(400).json({ error: 'No Stripe customer yet — complete checkout first' });
    return;
  }
  const session = await s.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${origin}/app/billing`,
  });
  res.json({ url: session.url });
});

r.post('/checkout', authRequired, async (req, res) => {
  const s = stripe();
  const price = process.env.STRIPE_PRICE_PRO;
  if (!s || !price) {
    res.status(503).json({ error: 'Stripe not configured (STRIPE_SECRET_KEY, STRIPE_PRICE_PRO)' });
    return;
  }
  const origin = appPublicOrigin();
  const session = await s.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price, quantity: 1 }],
    success_url: `${origin}/app/billing?success=1`,
    cancel_url: `${origin}/app/billing?canceled=1`,
    customer_email: req.user.email,
    client_reference_id: req.user.sub,
    metadata: { user_id: req.user.sub },
  });
  res.json({ url: session.url });
});

async function stripeUserIdFromCustomer(customerId) {
  if (!customerId) return null;
  const { rows } = await pool.query(`SELECT id FROM users WHERE stripe_customer_id = $1 LIMIT 1`, [customerId]);
  return rows[0]?.id ?? null;
}

async function stripeUserIdFromSubscription(sub) {
  let userId = sub.metadata?.user_id || null;
  if (userId) return userId;
  const customerId =
    typeof sub.customer === 'string' ? sub.customer : sub.customer && typeof sub.customer === 'object'
      ? sub.customer.id
      : null;
  return stripeUserIdFromCustomer(customerId);
}

export async function stripeWebhook(req, res) {
  const s = stripe();
  const whSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!s || !whSecret) {
    res.status(503).send('Stripe not configured');
    return;
  }
  let event;
  try {
    event = s.webhooks.constructEvent(req.body, req.headers['stripe-signature'], whSecret);
  } catch (err) {
    console.error(err);
    res.status(400).send('Webhook Error');
    return;
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = session.metadata?.user_id || session.client_reference_id;
      const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
      if (userId && customerId) {
        await pool.query(
          `UPDATE users SET plan = 'pro', stripe_customer_id = $2, subscription_ends_at = NULL WHERE id = $1`,
          [userId, customerId]
        );
      }
    }

    if (event.type === 'customer.subscription.updated') {
      const sub = event.data.object;
      const userId = await stripeUserIdFromSubscription(sub);
      if (userId) {
        const status = sub.status || '';
        const endsUnix =
          sub.cancel_at_period_end === true && typeof sub.current_period_end === 'number'
            ? sub.current_period_end
            : null;
        if (status === 'active' || status === 'trialing') {
          await pool.query(
            `UPDATE users SET plan = 'pro',
              subscription_ends_at = CASE WHEN $2 IS NOT NULL THEN to_timestamp($2) ELSE NULL END
             WHERE id = $1`,
            [userId, endsUnix]
          );
        } else if (status === 'canceled' || status === 'unpaid' || status === 'incomplete_expired') {
          await pool.query(`UPDATE users SET plan = 'free', subscription_ends_at = NULL WHERE id = $1`, [userId]);
        }
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const userId = await stripeUserIdFromSubscription(sub);
      if (userId) {
        await pool.query(`UPDATE users SET plan = 'free', subscription_ends_at = NULL WHERE id = $1`, [userId]);
      }
    }

    if (event.type === 'invoice.payment_succeeded') {
      const inv = event.data.object;
      const customerId = typeof inv.customer === 'string' ? inv.customer : inv.customer?.id;
      const userId = customerId ? await stripeUserIdFromCustomer(customerId) : null;
      const cents = typeof inv.amount_paid === 'number' ? inv.amount_paid : null;
      if (userId && cents != null && cents >= 0) {
        await pool.query(
          `INSERT INTO upload_diagnostics (scheduled_upload_id, user_id, metric, value_json)
           VALUES (NULL, $1, 'stripe_revenue_est', $2::jsonb)`,
          [userId, JSON.stringify({ invoice_id: inv.id, amount_cents: cents, currency: inv.currency || 'usd' })]
        );
      }
    }
  } catch (e) {
    console.error('[stripe webhook]', event.type, e);
  }

  res.json({ received: true });
}

export default r;
