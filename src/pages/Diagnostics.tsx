import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';

type Row = {
  id: string;
  metric: string;
  value_json: unknown;
  recorded_at: string;
  youtube_video_id?: string | null;
  upload_status?: string | null;
  scheduled_at?: string | null;
};

export default function Diagnostics() {
  const [events, setEvents] = useState<Row[]>([]);
  const [summary, setSummary] = useState<{ status: string; n: number }[]>([]);

  useEffect(() => {
    api<{ events: Row[]; upload_summary: { status: string; n: number }[] }>('/api/diagnostics').then(
      (d) => {
        setEvents(d.events);
        setSummary(d.upload_summary);
      }
    );
  }, []);

  return (
    <div className="page">
      <header className="topbar">
        <h1>Diagnostics</h1>
        <Link to="/app">← App</Link>
      </header>
      <section className="card">
        <h2>Upload pipeline</h2>
        <ul>
          {summary.map((s) => (
            <li key={s.status}>
              {s.status}: {s.n}
            </li>
          ))}
        </ul>
      </section>
      <section className="card">
        <h2>Recent events</h2>
        <table className="data-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Metric</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <td>{new Date(e.recorded_at).toLocaleString()}</td>
                <td>{e.metric}</td>
                <td>
                  <code>{JSON.stringify(e.value_json)}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
