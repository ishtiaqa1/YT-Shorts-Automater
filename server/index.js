import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { initDb, pool } from './db.js';
import authRoutes from './routes/auth.js';
import projectsRoutes from './routes/projects.js';
import youtubeRoutes from './routes/youtube.js';
import diagnosticsRoutes from './routes/diagnostics.js';
import billingRoutes, { stripeWebhook } from './routes/billing.js';
import { startUploadScheduler } from './services/scheduler.js';

const app = express();
const port = Number(process.env.PORT || 8787);

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), stripeWebhook);
app.use(express.json({ limit: '10mb' }));

mkdirSync(join(process.cwd(), 'uploads'), { recursive: true });
mkdirSync(join(process.cwd(), 'generated'), { recursive: true });
mkdirSync(join(process.cwd(), 'assets', 'gameplay'), { recursive: true });

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: true });
  } catch {
    res.status(503).json({ ok: false, db: false });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/projects', projectsRoutes);
app.use('/api/youtube', youtubeRoutes);
app.use('/api/diagnostics', diagnosticsRoutes);
app.use('/api/billing', billingRoutes);

async function main() {
  if (!process.env.JWT_SECRET) {
    console.warn('WARNING: JWT_SECRET is not set');
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL missing');
    process.exit(1);
  }
  await initDb();
  startUploadScheduler();
  app.listen(port, () => {
    console.log(`API http://localhost:${port}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
