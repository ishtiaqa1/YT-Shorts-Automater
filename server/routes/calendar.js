import { Router } from 'express';
import { DateTime } from 'luxon';
import { pool } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { getUserTimezone } from '../timezone.js';
import { YOUTUBE_SHORT_STRICT_MAX_SEC } from '../services/splitVideoForShorts.js';
import {
  countActiveUploadQueueForProject,
  sameOutputRevisionAlreadyQueued,
} from '../services/uploadScheduleGuards.js';
import { getDailyUploadCap, countScheduledVideosByLocalDay } from '../services/uploadDailyCap.js';

const r = Router();
r.use(authRequired);

function isScheduleIdParam(s) {
  const raw = String(s || '').trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(raw)) return null;
  return raw;
}

/** Delete a schedule row owned by the user (including `uploading`). */
async function deleteScheduleOwned(poolConn, scheduleId, userId) {
  const sid = String(scheduleId ?? '').trim();
  const uid = String(userId ?? '').trim();
  if (!sid || !uid) return null;
  const { rows } = await poolConn.query(
    `DELETE FROM scheduled_uploads
     WHERE id = $1::uuid AND user_id = $2::uuid
     RETURNING id`,
    [sid, uid]
  );
  return rows[0]?.id || null;
}

async function handleDeleteSchedule(req, res) {
  try {
    const id = isScheduleIdParam(req.params.id);
    if (!id) {
      res.status(400).json({ error: 'Invalid schedule id' });
      return;
    }
    const deleted = await deleteScheduleOwned(pool, id, String(req.user?.sub ?? ''));
    if (!deleted) {
      res.status(404).json({ error: 'Schedule not found' });
      return;
    }
    res.json({ ok: true, id: deleted });
  } catch (e) {
    console.error('[calendar] DELETE schedule', e);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Could not remove schedule', detail: String(e?.message || e) });
    }
  }
}

/**
 * JSON body delete — most reliable when DELETE or path-based POST is blocked (same idea as `POST /api/projects/delete`).
 * Body: `{ "schedule_id": "<uuid>" }`
 */
r.post('/delete', async (req, res) => {
  try {
    const raw = String(req.body?.schedule_id ?? req.body?.id ?? '').trim();
    const id = isScheduleIdParam(raw);
    if (!id) {
      res.status(400).json({ error: 'JSON body must include schedule_id (UUID)' });
      return;
    }
    const deleted = await deleteScheduleOwned(pool, id, String(req.user?.sub ?? ''));
    if (!deleted) {
      res.status(404).json({ error: 'Schedule not found' });
      return;
    }
    res.json({ ok: true, id: deleted });
  } catch (e) {
    console.error('[calendar] POST /delete', e);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Could not remove schedule', detail: String(e?.message || e) });
    }
  }
});

/** Month grid: days with scheduled upload counts + items for a day — all in the user's account timezone. */
r.get('/month', async (req, res) => {
  const y = Number(req.query.year);
  const m = Number(req.query.month);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) {
    res.status(400).json({ error: 'year and month (1-12) required' });
    return;
  }

  const tz = await getUserTimezone(pool, req.user.sub);

  const monthStart = [req.user.sub, tz, y, m];
  const [byDayRes, monthItemsRes] = await Promise.all([
    pool.query(
      `SELECT (scheduled_at AT TIME ZONE $2::text)::date AS d, COUNT(*)::int AS n
       FROM scheduled_uploads
       WHERE user_id = $1
         AND (scheduled_at AT TIME ZONE $2::text)::date >= make_date($3::int, $4::int, 1)
         AND (scheduled_at AT TIME ZONE $2::text)::date < (make_date($3::int, $4::int, 1) + interval '1 month')::date
       GROUP BY 1 ORDER BY 1`,
      monthStart
    ),
    pool.query(
      `SELECT su.id, su.scheduled_at, su.status, COALESCE(su.platform, 'youtube') AS platform,
              COALESCE(NULLIF(trim(su.title), ''), NULLIF(trim(p.title), ''), 'Untitled') AS title
       FROM scheduled_uploads su
       JOIN projects p ON p.id = su.project_id
       WHERE su.user_id = $1
         AND (su.scheduled_at AT TIME ZONE $2::text)::date >= make_date($3::int, $4::int, 1)
         AND (su.scheduled_at AT TIME ZONE $2::text)::date < (make_date($3::int, $4::int, 1) + interval '1 month')::date
       ORDER BY su.scheduled_at`,
      monthStart
    ),
  ]);

  const byDay = byDayRes.rows;
  const month_items = monthItemsRes.rows;

  const day = req.query.day;
  if (typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
    const { rows: items } = await pool.query(
      `SELECT su.*, p.title AS project_title, p.status AS project_status
       FROM scheduled_uploads su
       JOIN projects p ON p.id = su.project_id
       WHERE su.user_id = $1
         AND (su.scheduled_at AT TIME ZONE $2::text)::date = $3::date
       ORDER BY su.scheduled_at`,
      [req.user.sub, tz, day]
    );
    return res.json({ year: y, month: m, timezone: tz, by_day: byDay, month_items, day_items: items });
  }

  res.json({ year: y, month: m, timezone: tz, by_day: byDay, month_items });
});

/**
 * Bulk schedule ready projects across weekdays.
 * body: { project_ids, weekdays: 0=Sun..6=Sat, hour, minute, weeks } — hour/minute are **account timezone** wall clock.
 */
r.post('/bulk-schedule', async (req, res) => {
  const b = req.body || {};
  const ids = Array.isArray(b.project_ids) ? b.project_ids.map(String) : [];
  const weekdays = Array.isArray(b.weekdays) ? b.weekdays.map(Number).filter((n) => n >= 0 && n <= 6) : [];
  const hour = Number(b.hour);
  const minute = Number(b.minute ?? 0);
  const weeks = Math.min(8, Math.max(1, Number(b.weeks ?? 2)));
  if (!ids.length || !weekdays.length || !Number.isFinite(hour)) {
    res.status(400).json({ error: 'project_ids, weekdays, hour required' });
    return;
  }
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    res.status(400).json({ error: 'hour must be 0–23 and minute 0–59' });
    return;
  }

  const tz = await getUserTimezone(pool, req.user.sub);

  const { rows: projects } = await pool.query(
    `SELECT id, title, status, duration_seconds, output_revision, last_queued_output_revision,
            upload_dest_youtube, upload_dest_tiktok, youtube_connection_id, tiktok_connection_id
     FROM projects WHERE user_id = $1 AND id = ANY($2::uuid[])`,
    [req.user.sub, ids]
  );
  const ready = projects.filter((p) => p.status === 'ready');
  if (!ready.length) {
    res.status(400).json({ error: 'No ready projects in selection' });
    return;
  }

  const { rows: pendRows } = await pool.query(
    `SELECT project_id, COUNT(*)::int AS c FROM scheduled_uploads
     WHERE user_id = $1 AND project_id = ANY($2::uuid[]) AND status IN ('pending', 'uploading')
     GROUP BY project_id`,
    [req.user.sub, ready.map((p) => p.id)]
  );
  const pendMap = new Map(pendRows.map((r) => [String(r.project_id), Number(r.c)]));

  let ytConnId = b.youtube_connection_id || null;
  if (ytConnId) {
    const { rows: yc } = await pool.query(
      `SELECT id FROM youtube_connections WHERE id = $1 AND user_id = $2`,
      [ytConnId, req.user.sub]
    );
    if (!yc[0]) ytConnId = null;
  }

  let ttConnId = b.tiktok_connection_id || null;
  if (ttConnId) {
    const { rows: tc } = await pool.query(
      `SELECT id FROM tiktok_connections WHERE id = $1 AND user_id = $2`,
      [ttConnId, req.user.sub]
    );
    if (!tc[0]) ttConnId = null;
  }

  const { rows: defaultYRows } = await pool.query(
    `SELECT id FROM youtube_connections WHERE user_id = $1 ORDER BY is_default DESC, updated_at DESC LIMIT 1`,
    [req.user.sub]
  );
  const { rows: defaultTRows } = await pool.query(
    `SELECT id FROM tiktok_connections WHERE user_id = $1 ORDER BY is_default DESC, updated_at DESC LIMIT 1`,
    [req.user.sub]
  );
  const defaultYtConn = defaultYRows[0]?.id || null;
  const defaultTtConn = defaultTRows[0]?.id || null;

  const now = DateTime.now().setZone(tz);

  /** @type {{ project_id: string; title: string; reason: string }[]} */
  const skippedPreBulk = [];
  /** @type {typeof ready} */
  const schedulable = [];
  for (const p of ready) {
    const pend = pendMap.get(String(p.id)) ?? 0;
    if (pend > 0) {
      skippedPreBulk.push({ project_id: String(p.id), title: String(p.title || ''), reason: 'in_queue' });
      continue;
    }
    if (sameOutputRevisionAlreadyQueued(p, false)) {
      skippedPreBulk.push({
        project_id: String(p.id),
        title: String(p.title || ''),
        reason: 'same_output_already_queued',
      });
      continue;
    }
    const wantYt = p.upload_dest_youtube !== false;
    const wantTt = p.upload_dest_tiktok === true;
    if (!wantYt && !wantTt) {
      skippedPreBulk.push({
        project_id: String(p.id),
        title: String(p.title || ''),
        reason: 'no_publish_destination',
      });
      continue;
    }
    const yOk = !wantYt || ytConnId || p.youtube_connection_id || defaultYtConn;
    const tOk = !wantTt || ttConnId || p.tiktok_connection_id || defaultTtConn;
    if (!yOk || !tOk) {
      skippedPreBulk.push({
        project_id: String(p.id),
        title: String(p.title || ''),
        reason: 'missing_youtube_or_tiktok_connection',
      });
      continue;
    }
    schedulable.push(p);
  }

  const tooLong = schedulable.filter((p) => Number(p.duration_seconds) >= YOUTUBE_SHORT_STRICT_MAX_SEC);
  if (tooLong.length) {
    res.status(400).json({
      error:
        'Bulk calendar scheduling does not split videos that are 3 minutes or longer (Shorts must be strictly under 3:00). Open each long project and use Schedule in the editor — uploads are split into parts and spaced 24 hours apart (one part per day).',
      long_project_titles: tooLong.map((p) => p.title),
    });
    return;
  }

  const startDay = now.startOf('day');
  /** Luxon weekday Mon=1..Sun=7 → JS getDay Sun=0..Sat=6 */
  const luxonToJsDow = (wd) => (wd === 7 ? 0 : wd);

  const slots = [];
  const maxDays = Math.min(7 * weeks + 21, 120);
  for (let offset = 0; offset < maxDays && slots.length < schedulable.length + 32; offset += 1) {
    const day = startDay.plus({ days: offset });
    const dow = luxonToJsDow(day.weekday);
    if (!weekdays.includes(dow)) continue;
    const slot = day.set({ hour, minute, second: 0, millisecond: 0 });
    /** Leave enough lead time for YouTube `publishAt` (see `YOUTUBE_PUBLISH_AT_MIN_LEAD_MS` on server). */
    if (slot <= now.plus({ minutes: 22 })) continue;
    slots.push(slot);
  }
  slots.sort((a, b) => a.toMillis() - b.toMillis());

  /** Respect the per-account daily upload cap (new accounts: 1/day for 2 weeks, then 3/day). */
  const { cap: dailyCap } = await getDailyUploadCap(pool, req.user.sub);
  const dayUsage = await countScheduledVideosByLocalDay(pool, req.user.sub, tz);
  const capacitySlots = [];
  for (const slot of slots) {
    const day = slot.toISODate();
    const used = dayUsage.get(day) || 0;
    if (used >= dailyCap) continue;
    dayUsage.set(day, used + 1);
    capacitySlots.push(slot);
  }

  /** @type {unknown[]} */
  const created = [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < schedulable.length && i < capacitySlots.length; i += 1) {
      const p = schedulable[i];
      const { rows: lkRows } = await client.query(
        `SELECT output_revision, last_queued_output_revision, title,
                upload_dest_youtube, upload_dest_tiktok, youtube_connection_id, tiktok_connection_id
         FROM projects
         WHERE id = $1::uuid AND user_id = $2::uuid FOR UPDATE`,
        [p.id, req.user.sub]
      );
      const lk = lkRows[0];
      if (!lk) continue;
      if (sameOutputRevisionAlreadyQueued(lk, false)) continue;
      const pend2 = await countActiveUploadQueueForProject(client, p.id);
      if (pend2 > 0) continue;
      const when = capacitySlots[i].toUTC().toISO();
      const wantYt = lk.upload_dest_youtube !== false;
      const wantTt = lk.upload_dest_tiktok === true;
      if (!wantYt && !wantTt) continue;

      let yC = ytConnId || lk.youtube_connection_id || defaultYtConn || null;
      let tC = ttConnId || lk.tiktok_connection_id || defaultTtConn || null;
      if (wantYt && !yC) continue;
      if (wantTt && !tC) continue;

      const insertOne = async (platform) => {
        const { rows: insR } = await client.query(
          `INSERT INTO scheduled_uploads
            (project_id, user_id, platform, youtube_connection_id, tiktok_connection_id, scheduled_at, title, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
           RETURNING id, project_id, scheduled_at`,
          [p.id, req.user.sub, platform, platform === 'youtube' ? yC : null, platform === 'tiktok' ? tC : null, when, p.title]
        );
        created.push(insR[0]);
      };
      if (wantYt) await insertOne('youtube');
      if (wantTt) await insertOne('tiktok');
      await client.query(
        `UPDATE projects SET last_queued_output_revision = output_revision, updated_at = NOW()
         WHERE id = $1::uuid AND user_id = $2::uuid`,
        [p.id, req.user.sub]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[calendar] bulk-schedule', e);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Bulk schedule failed', detail: String(e?.message || e) });
    }
    return;
  } finally {
    client.release();
  }

  const slotShortfall = Math.max(0, schedulable.length - capacitySlots.length);
  res.json({
    scheduled: created,
    skipped: slotShortfall,
    skipped_pre_bulk: skippedPreBulk,
    timezone: tz,
  });
});

r.delete('/schedules/:id', handleDeleteSchedule);

/** Same as DELETE — some proxies / networks block DELETE with auth; SPA falls back here. */
r.post('/schedules/:id/delete', handleDeleteSchedule);

export default r;
