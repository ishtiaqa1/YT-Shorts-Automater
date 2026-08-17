import { DateTime } from 'luxon';

/** New accounts are throttled for this many days after signup. */
export const NEW_ACCOUNT_WINDOW_DAYS = 14;
/** Max videos a brand-new account may publish per day during the window. */
export const NEW_ACCOUNT_DAILY_CAP = 1;
/** Max videos an established account may publish per day. */
export const ESTABLISHED_DAILY_CAP = 3;

/** Rows in these states do not count against (or block) the daily cap. */
const INACTIVE_UPLOAD_STATES = ['failed', 'canceled', 'cancelled'];

/**
 * Resolve the per-day upload cap for an account based on its age.
 * Accounts younger than {@link NEW_ACCOUNT_WINDOW_DAYS} may publish {@link NEW_ACCOUNT_DAILY_CAP}
 * video per day; older accounts may publish {@link ESTABLISHED_DAILY_CAP}.
 */
export async function getDailyUploadCap(db, userId) {
  const { rows } = await db.query(
    `SELECT (created_at <= NOW() - ($2 || ' days')::interval) AS established
     FROM users WHERE id = $1`,
    [userId, String(NEW_ACCOUNT_WINDOW_DAYS)]
  );
  const established = rows[0]?.established === true;
  return {
    cap: established ? ESTABLISHED_DAILY_CAP : NEW_ACCOUNT_DAILY_CAP,
    isNewAccount: !established,
  };
}

/**
 * Count how many distinct videos a user already has queued/published per local calendar day.
 * A single video published to multiple platforms (same project + same scheduled time) counts once.
 * Returns a Map keyed by ISO date string (`YYYY-MM-DD`) in the user's timezone.
 */
export async function countScheduledVideosByLocalDay(db, userId, tz) {
  const { rows } = await db.query(
    `SELECT (scheduled_at AT TIME ZONE $2::text)::date::text AS day,
            COUNT(DISTINCT (project_id, scheduled_at))::int AS n
     FROM scheduled_uploads
     WHERE user_id = $1
       AND status <> ALL($3::text[])
     GROUP BY 1`,
    [userId, tz, INACTIVE_UPLOAD_STATES]
  );
  const byDay = new Map();
  for (const row of rows) byDay.set(row.day, Number(row.n));
  return byDay;
}

/** Local calendar day (`YYYY-MM-DD`) for a UTC instant in the given timezone. */
export function localDayKey(whenUtc, tz) {
  const millis = whenUtc instanceof Date ? whenUtc.getTime() : new Date(whenUtc).getTime();
  return DateTime.fromMillis(millis, { zone: 'utc' }).setZone(tz).toISODate();
}
