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

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.metadata?.user_id || session.client_reference_id;
    const customerId = session.customer;
    if (userId && customerId) {
      await pool.query(`UPDATE users SET plan = 'pro', stripe_customer_id = $2 WHERE id = $1`, [
        userId,
        customerId,
      ]);
    }
  }

  res.json({ received: true });
}

export default r;
