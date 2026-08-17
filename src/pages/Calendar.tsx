import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DateTime } from 'luxon';
import { Link } from 'react-router-dom';
import { api, apiDeleteSchedule } from '../api';
import { describeYoutubeUploadError } from '../youtubeUploadErrors';
import { useAuth } from '../auth';

type ByDayRow = { d: string; n: number };
type DayItem = {
  id: string;
  project_id: string;
  scheduled_at: string;
  status: string;
  title: string | null;
  youtube_video_id: string | null;
  tiktok_post_id?: string | null;
  platform?: string | null;
  project_title: string | null;
  last_error?: string | null;
};

/** Lightweight rows for the month grid (same timezone as `/api/calendar/month`). */
type MonthItem = {
  id: string;
  scheduled_at: string;
  status: string;
  title: string;
  platform?: string | null;
};

type Proj = {
  id: string;
  title: string;
  status: string;
};

export default function Calendar() {
  const { user } = useAuth();
  const accountTz = useMemo(() => {
    const raw = user?.timezone?.trim();
    if (!raw) return 'UTC';
    const z = DateTime.now().setZone(raw);
    return z.isValid ? raw : 'UTC';
  }, [user?.timezone]);

  const seededMonth = useRef(false);
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [month, setMonth] = useState(() => new Date().getMonth() + 1);
  const [dayDetail, setDayDetail] = useState<string | null>(null);
  const [byDay, setByDay] = useState<ByDayRow[]>([]);
  const [monthItems, setMonthItems] = useState<MonthItem[]>([]);
  const [items, setItems] = useState<DayItem[]>([]);
  const [deleteErr, setDeleteErr] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  /** Blocks double-clicks before React re-renders `disabled` (same id in flight → one network delete). */
  const removingIdsRef = useRef(new Set<string>());
  const gridScrollRef = useRef<HTMLDivElement>(null);
  /** Latest {year, month} for the (stable) wheel listener closure. */
  const ymRef = useRef({ year, month });
  ymRef.current = { year, month };
  const [projects, setProjects] = useState<Proj[]>([]);
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [bulkMsg, setBulkMsg] = useState('');
  const [bulkErr, setBulkErr] = useState('');
  const [weekbits, setWeekbits] = useState<number[]>([1, 2, 3, 4, 5]);
  const [bulkHour, setBulkHour] = useState(12);
  const [bulkMinute, setBulkMinute] = useState(0);
  const [bulkWeeks, setBulkWeeks] = useState(2);

  /** Single source of truth: auth user (refreshed after Settings save). Matches server DB used by `/api/calendar/month`. */
  const displayTz = accountTz;

  useEffect(() => {
    const el = gridScrollRef.current;
    if (!el) return;
    let lastAt = 0;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return; // let horizontal scroll move the grid
      // Let a day's own scrollable item list consume the wheel until it hits a boundary.
      const snips = (e.target as HTMLElement | null)?.closest('.cal-cell-snips') as HTMLElement | null;
      if (snips && snips.scrollHeight > snips.clientHeight + 1) {
        const atTop = snips.scrollTop <= 0;
        const atBottom = snips.scrollTop + snips.clientHeight >= snips.scrollHeight - 1;
        if ((e.deltaY < 0 && !atTop) || (e.deltaY > 0 && !atBottom)) return;
      }
      e.preventDefault();
      const now = Date.now();
      if (now - lastAt < 280) return;
      lastAt = now;
      const { year: y, month: m } = ymRef.current;
      const total = y * 12 + (m - 1) + (e.deltaY > 0 ? 1 : -1);
      setYear(Math.floor(total / 12));
      setMonth((total % 12) + 1);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    if (seededMonth.current || !user?.timezone) return;
    const z = DateTime.now().setZone(accountTz);
    if (!z.isValid) return;
    seededMonth.current = true;
    setYear(z.year);
    setMonth(z.month);
  }, [user?.timezone, accountTz]);

  const loadMonth = useCallback(async () => {
    const q = `/api/calendar/month?year=${year}&month=${month}${dayDetail ? `&day=${dayDetail}` : ''}`;
    const d = await api<{
      by_day: ByDayRow[];
      month_items?: MonthItem[];
      day_items?: DayItem[];
      timezone?: string;
    }>(q);
    setByDay(d.by_day || []);
    setMonthItems(Array.isArray(d.month_items) ? d.month_items : []);
    setItems(dayDetail ? d.day_items || [] : []);
  }, [year, month, dayDetail]);

  useEffect(() => {
    setDeleteErr('');
  }, [dayDetail]);

  useEffect(() => {
    loadMonth().catch(() => {});
  }, [loadMonth, accountTz]);

  useEffect(() => {
    api<{ projects: Proj[] }>('/api/projects')
      .then((d) =>
        setProjects((d.projects || []).filter((p) => p.status === 'ready' || p.status === 'draft'))
      )
      .catch(() => setProjects([]));
  }, []);

  const countByDate = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of byDay) m.set(r.d, r.n);
    return m;
  }, [byDay]);

  const itemsByDay = useMemo(() => {
    const m = new Map<string, MonthItem[]>();
    for (const it of monthItems) {
      const key = scheduleToLocalDateKey(it.scheduled_at, displayTz);
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(it);
    }
    for (const [, arr] of m) {
      arr.sort((a, b) => String(a.scheduled_at).localeCompare(String(b.scheduled_at)));
    }
    return m;
  }, [monthItems, displayTz]);

  const pad = useMemo(() => calendarPadAccountZone(year, month - 1, displayTz), [year, month, displayTz]);

  async function removeSchedule(id: string, titleHint: string, status?: string) {
    const sid = String(id);
    if (removingIdsRef.current.has(sid)) return;
    removingIdsRef.current.add(sid);

    const uploadNote =
      status === 'uploading'
        ? '\n\nIf an upload to YouTube is still in progress, a video can still appear on your channel even after this schedule row is removed.'
        : '';
    const st = String(status || '').toLowerCase();
    const skipConfirm = st === 'failed' || st === 'pending';
    if (
      !skipConfirm &&
      !window.confirm(
        `Remove this scheduled upload from the calendar?\n\n"${titleHint.slice(0, 120)}"\n\nThis does not delete the project. If the video is already on YouTube, it stays there.${uploadNote}`
      )
    ) {
      removingIdsRef.current.delete(sid);
      return;
    }
    setDeleteErr('');
    setDeletingId(sid);
    try {
      await apiDeleteSchedule(sid);
      await loadMonth();
    } catch (e) {
      setDeleteErr(e instanceof Error ? e.message : 'Could not remove schedule');
    } finally {
      removingIdsRef.current.delete(sid);
      setDeletingId(null);
    }
  }

  async function runBulk(e: FormEvent) {
    e.preventDefault();
    setBulkErr('');
    setBulkMsg('');
    const ids = Object.entries(sel).filter(([, v]) => v).map(([k]) => k);
    if (!ids.length) {
      setBulkErr('Pick at least one ready project.');
      return;
    }
    try {
      const d = await api<{
        scheduled: unknown[];
        skipped: number;
        skipped_pre_bulk?: { project_id: string; title: string; reason: string }[];
      }>('/api/calendar/bulk-schedule', {
        method: 'POST',
        body: JSON.stringify({
          project_ids: ids,
          weekdays: weekbits,
          hour: bulkHour,
          minute: bulkMinute,
          weeks: bulkWeeks,
        }),
      });
      const n = Array.isArray(d.scheduled) ? d.scheduled.length : 0;
      const slotSkip = typeof d.skipped === 'number' ? d.skipped : 0;
      const pre = Array.isArray(d.skipped_pre_bulk) ? d.skipped_pre_bulk : [];
      const preLines = pre.map((r) => {
        const why =
          r.reason === 'in_queue'
            ? 'already in upload queue'
            : r.reason === 'same_output_already_queued'
              ? 'same render already queued (re-render to schedule again)'
              : r.reason;
        return `“${String(r.title || '').slice(0, 48)}”: ${why}`;
      });
      setBulkMsg(
        `Created ${n} scheduled row(s). Skipped ${slotSkip} for lack of weekday slots.` +
          (pre.length
            ? ` Skipped ${pre.length} before scheduling: ${preLines.join('; ')}.`
            : '') +
          ` Times use ${displayTz}.`
      );
      await loadMonth();
      setSel({});
    } catch (ex) {
      setBulkErr(ex instanceof Error ? ex.message : 'Failed');
    }
  }

  function toggleWeekday(bit: number) {
    setWeekbits((prev) => (prev.includes(bit) ? prev.filter((x) => x !== bit) : [...prev, bit].sort((a, b) => a - b)));
  }

  function shiftMonth(delta: number) {
    const total = year * 12 + (month - 1) + delta;
    setYear(Math.floor(total / 12));
    setMonth((total % 12) + 1);
  }

  function goToCurrentMonth() {
    const now = DateTime.now().setZone(displayTz);
    if (!now.isValid) return;
    setYear(now.year);
    setMonth(now.month);
  }

  return (
    <div className="page">
      <header className="topbar">
        <h1>Publishing calendar</h1>
        <Link to="/app">← App</Link>
      </header>

      <section className="card calendar-nav">
        <p className="hint" style={{ margin: 0, flex: '1 1 100%' }}>
          Calendar uses your account timezone: <strong>{displayTz}</strong> (change in Settings).
        </p>
        <label>
          Year
          <input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} />
        </label>
        <label>
          Month
          <select value={month} onChange={(e) => setMonth(Number(e.target.value))}>
            {MONTH_LABELS.map((label, idx) => (
              <option key={label} value={idx + 1}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Drill into day ({displayTz} date)
          <input
            type="date"
            value={dayDetail || ''}
            onChange={(e) => setDayDetail(e.target.value || null)}
          />
        </label>
      </section>

      <section className="card">
        <div className="cal-overview-head">
          <button
            type="button"
            className="cal-nav-arrow"
            onClick={() => shiftMonth(-1)}
            aria-label="Previous month"
          >
            ‹
          </button>
          <h2 className="cal-overview-title">
            {MONTH_LABELS[month - 1]} {year}
          </h2>
          <button
            type="button"
            className="cal-nav-arrow"
            onClick={() => shiftMonth(1)}
            aria-label="Next month"
          >
            ›
          </button>
          <button type="button" className="cal-today-btn" onClick={() => goToCurrentMonth()}>
            Today
          </button>
        </div>
        <p className="hint">
          Each cell shows <strong>titles and times</strong> for that civil day in <strong>{displayTz}</strong> (up to a few
          lines; use the day list below for full detail). Click a day to drill in or remove a schedule. Use the arrows
          above or scroll over the grid to move between months.
        </p>
        <div className="cal-scroll" ref={gridScrollRef}>
          <div className="cal-grid-head">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
              <div key={d} className="cal-head">
                {d}
              </div>
            ))}
          </div>
          <div className="cal-grid">
            {pad.map((cell, idx) =>
              cell == null ? (
                <div key={`e-${idx}`} className="cal-cell muted" />
              ) : (
                <button
                  key={cell.iso}
                  type="button"
                  className={`cal-cell ${dayDetail === cell.iso ? 'active' : ''}`}
                  onClick={() => setDayDetail(cell.iso)}
                >
                  <span className="cal-d">{cell.day}</span>
                  {countByDate.get(cell.iso) ? (
                    <span className="cal-n">{countByDate.get(cell.iso)} upload(s)</span>
                  ) : (
                    <span className="cal-n muted">—</span>
                  )}
                  <div className="cal-cell-snips">
                    {(itemsByDay.get(cell.iso) ?? []).map((s) => (
                      <div key={s.id} className="cal-snippet" title={s.title}>
                        <span className="cal-snippet-time">
                          {formatScheduleTimeShort(s.scheduled_at, displayTz)}
                        </span>
                        <span className={`cal-snippet-status ${s.status}`}>{s.status.slice(0, 3)}</span>
                        <span className="cal-snippet-title">
                          {s.platform === 'tiktok' ? 'TT ' : 'YT '}
                          {truncateTitle(s.title, 32)}
                        </span>
                      </div>
                    ))}
                  </div>
                </button>
              )
            )}
          </div>
        </div>
      </section>

      {dayDetail && (
        <section className="card">
          <h2>
            Uploads on {dayDetail} <span className="hint">({displayTz})</span>
          </h2>
          {deleteErr ? <p className="error">{deleteErr}</p> : null}
          {items.length > 0 ? (
            <p className="hint" style={{ marginTop: deleteErr ? '0.5rem' : 0 }}>
              <strong>Failed</strong> and <strong>pending</strong> rows remove in one click (no confirm). Other statuses ask
              for confirmation first.
            </p>
          ) : null}
          {items.length === 0 ? (
            <p className="hint">None scheduled that day in your timezone.</p>
          ) : (
            <ul className="cal-day-list cal-day-list-detailed">
              {items.map((it) => (
                <li key={it.id} className="cal-day-row">
                  <div className="cal-day-main">
                    <strong>{it.title || it.project_title || 'Untitled'}</strong>{' '}
                    <span className="hint">({it.platform === 'tiktok' ? 'TikTok' : 'YouTube'})</span> ·{' '}
                    <span className={`badge ${it.status}`}>{it.status}</span> · publish at{' '}
                    <strong>{displayTz}</strong> {formatScheduledLocal(it.scheduled_at, displayTz)} ·{' '}
                    <Link to={`/app/project/${it.project_id}`}>Open project</Link>
                    {it.status === 'failed' && it.last_error ? (
                      <>
                        {' '}
                        · <span className="hint">Reason: {truncateErr(describeYoutubeUploadError(it.last_error))}</span>
                      </>
                    ) : null}
                    {it.youtube_video_id ? (
                      <>
                        {' '}
                        ·{' '}
                        <a
                          href={`https://www.youtube.com/watch?v=${encodeURIComponent(it.youtube_video_id)}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          YouTube
                        </a>
                      </>
                    ) : null}
                    {it.tiktok_post_id ? (
                      <>
                        {' '}
                        ·{' '}
                        <a
                          href={`https://www.tiktok.com/video/${encodeURIComponent(it.tiktok_post_id)}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          TikTok
                        </a>
                      </>
                    ) : null}
                  </div>
                  <div className="cal-remove-col">
                    {it.status === 'uploading' ? (
                      <span className="hint cal-remove-slot">Uploading — you can still cancel the row.</span>
                    ) : null}
                    <button
                      type="button"
                      className="secondary-btn cal-remove-btn"
                      disabled={deletingId === it.id}
                      onClick={() => void removeSchedule(it.id, it.title || it.project_title || 'Untitled', it.status)}
                    >
                      {deletingId === it.id ? 'Removing…' : 'Remove'}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="card">
        <h2>Bulk weekday schedule</h2>
        <p className="hint">
          Spreads selected projects across weekdays using the <strong>hour and minute in {displayTz}</strong> (same as
          Settings). Uses only <strong>ready</strong> renders; skips when there are not enough future weekday slots.
        </p>
        <form onSubmit={(e) => void runBulk(e)} className="bulk-form">
          <fieldset>
            <legend>Projects</legend>
            <div className="bulk-proj-scroll">
              {projects.map((p) => (
                <label key={p.id} className="bulk-row">
                  <input
                    type="checkbox"
                    checked={Boolean(sel[p.id])}
                    onChange={(e) => setSel((s) => ({ ...s, [p.id]: e.target.checked }))}
                    disabled={p.status !== 'ready'}
                  />
                  <span>
                    {p.title} · <span className={`badge ${p.status}`}>{p.status}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="weekday-pills">
            {[
              ['Sun', 0],
              ['Mon', 1],
              ['Tue', 2],
              ['Wed', 3],
              ['Thu', 4],
              ['Fri', 5],
              ['Sat', 6],
            ].map(([label, bit]) => (
              <button
                key={String(bit)}
                type="button"
                className={`filter-pill ${weekbits.includes(Number(bit)) ? 'active' : ''}`}
                onClick={() => toggleWeekday(Number(bit))}
              >
                {String(label)}
              </button>
            ))}
          </div>

          <div className="schedule-datetime">
            <label>
              Hour in {displayTz} (0–23)
              <input
                type="number"
                min={0}
                max={23}
                value={bulkHour}
                onChange={(e) => setBulkHour(Number(e.target.value))}
              />
            </label>
            <label>
              Minute in {displayTz}
              <input
                type="number"
                min={0}
                max={59}
                value={bulkMinute}
                onChange={(e) => setBulkMinute(Number(e.target.value))}
              />
            </label>
            <label>
              Weeks lookahead
              <input
                type="number"
                min={1}
                max={8}
                value={bulkWeeks}
                onChange={(e) => setBulkWeeks(Number(e.target.value))}
              />
            </label>
          </div>

          {bulkErr && <p className="error">{bulkErr}</p>}
          {bulkMsg && <p className="success">{bulkMsg}</p>}
          <button type="submit">Create scheduled uploads</button>
        </form>
      </section>
    </div>
  );
}

const MONTH_LABELS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

type CellIso = { day: number; iso: string };

/** Sunday-first columns; civil dates in `zone` (IANA or UTC). */
function calendarPadAccountZone(y: number, m0: number, zone: string): (CellIso | null)[] {
  const z = DateTime.fromObject({ year: y, month: m0 + 1, day: 1 }, { zone });
  if (!z.isValid) return [];
  const firstDow = z.weekday % 7;
  const daysInMonth = z.daysInMonth ?? 30;
  const pad: (CellIso | null)[] = [];
  for (let i = 0; i < firstDow; i += 1) pad.push(null);
  for (let d = 1; d <= daysInMonth; d += 1) {
    const local = z.set({ day: d });
    pad.push({ day: d, iso: local.toFormat('yyyy-MM-dd') });
  }
  return pad;
}

function formatScheduledLocal(iso: string, zone: string) {
  const t = DateTime.fromISO(iso, { zone: 'utc' }).setZone(zone);
  if (!t.isValid) return iso;
  return t.toFormat('LLL d, yyyy h:mm a');
}

function scheduleToLocalDateKey(iso: string, zone: string) {
  const t = DateTime.fromISO(iso, { zone: 'utc' }).setZone(zone);
  if (!t.isValid) return iso.slice(0, 10);
  return t.toFormat('yyyy-MM-dd');
}

function formatScheduleTimeShort(iso: string, zone: string) {
  const t = DateTime.fromISO(iso, { zone: 'utc' }).setZone(zone);
  if (!t.isValid) return '—';
  return t.toFormat('h:mm a');
}

function truncateTitle(s: string, max: number) {
  const t = (s || '').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}

function truncateErr(s: string, max = 220) {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}
