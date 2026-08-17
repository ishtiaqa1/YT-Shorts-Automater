import { DateTime } from 'luxon';

/** Same rules as auth PATCH — safe to pass through to Postgres `AT TIME ZONE`. */
export function isValidTimezone(tz) {
  const s = String(tz || '').trim();
  if (s === 'UTC') return true;
  if (s.length < 5 || s.length > 64 || !s.includes('/')) return false;
  return /^[A-Za-z][A-Za-z0-9_]*(\/[A-Za-z0-9_+\-]+)+$/.test(s);
}

/** Returns an IANA id Luxon + Postgres accept; falls back to UTC. */
export async function getUserTimezone(pool, userId) {
  const { rows } = await pool.query(`SELECT timezone FROM users WHERE id = $1`, [userId]);
  let tz = String(rows[0]?.timezone || 'UTC').trim();
  if (!isValidTimezone(tz)) tz = 'UTC';
  const probe = DateTime.now().setZone(tz);
  if (!probe.isValid) tz = 'UTC';
  return tz;
}
