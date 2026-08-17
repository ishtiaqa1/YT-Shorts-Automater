import express from 'express';
import cors from 'cors';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { initDb, pool } from './db.js';
import authRoutes from './routes/auth.js';
import projectsRoutes from './routes/projects.js';
import youtubeRoutes from './routes/youtube.js';
import tiktokRoutes from './routes/tiktok.js';
import diagnosticsRoutes from './routes/diagnostics.js';
import billingRoutes, { stripeWebhook } from './routes/billing.js';
import adminRoutes from './routes/admin.js';
import referralsRoutes from './routes/referrals.js';
import templatesRoutes from './routes/templates.js';
import calendarRoutes from './routes/calendar.js';
import generateRoutes from './routes/generate.js';
import { startUploadScheduler } from './services/scheduler.js';
import { startYoutubeAnalyticsCron, startWeeklySummaryCron } from './services/cronExtras.js';
import { globalApiLimiter } from './middleware/apiGuards.js';
import { googleOAuthEnvFromProcess } from './oauthEnv.js';
import { ensureBackgroundThemeDirectories } from './services/bundledBackgrounds.js';

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
mkdirSync(join(process.cwd(), 'assets', 'music'), { recursive: true });
ensureBackgroundThemeDirectories();

/** Rate-limit JSON API routes — webhook bypasses this (handled above with raw body). */
app.use((req, res, next) => {
  if ((req.originalUrl || '').startsWith('/api')) {
    return globalApiLimiter(req, res, next);
  }
  next();
});

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
app.use('/api/tiktok', tiktokRoutes);
app.use('/api/diagnostics', diagnosticsRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/referrals', referralsRoutes);
app.use('/api/templates', templatesRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/generate', generateRoutes);

function logYouTubeOAuthEnvHint() {
  const { clientId: id, clientSecret: secret, redirectUri } = googleOAuthEnvFromProcess();
  if (!id) return;
  const suffix = id.length > 28 ? `…${id.slice(-28)}` : id;
  const redir = redirectUri ? `redirect_uri=${redirectUri}` : 'redirect_uri=(missing)';
  console.log(
    `[YouTube OAuth env] client_id ends with ${suffix} · client_secret length=${secret?.length ?? 0} · ${redir} · ` +
      `values use the same cleaning as token exchange (BOM/CR/quotes stripped). ` +
      `Do not put inline # comments after secrets on the same line in .env.`
  );
}

async function main() {
  if (!process.env.JWT_SECRET) {
    console.warn('WARNING: JWT_SECRET is not set');
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL missing');
    process.exit(1);
  }
  logYouTubeOAuthEnvHint();
  console.log(
    `[env] GEMINI_API_KEY: ${process.env.GEMINI_API_KEY?.trim() ? 'loaded' : 'missing (AI script / Gemini transcription need it in project .env)'}`
  );
  await initDb();
  startUploadScheduler();
  startYoutubeAnalyticsCron();
  startWeeklySummaryCron();
  app.listen(port, () => {
    console.log(`API http://localhost:${port}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
