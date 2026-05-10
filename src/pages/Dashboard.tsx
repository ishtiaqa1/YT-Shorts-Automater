import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';

type Project = {
  id: string;
  title: string;
  status: string;
  duration_seconds: number | null;
  updated_at: string;
};

export default function Dashboard() {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [title, setTitle] = useState('');
  const [script, setScript] = useState('');
  const [err, setErr] = useState('');

  async function load() {
    const data = await api<{ projects: Project[] }>('/api/projects');
    setProjects(data.projects);
  }

  useEffect(() => {
    load().catch(() => setErr('Could not load projects'));
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    try {
      const { project } = await api<{ project: { id: string } }>('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ title, script_text: script }),
      });
      setTitle('');
      setScript('');
      await load();
      navigate(`/app/project/${project.id}`);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Error');
    }
  }

  return (
    <div className="dashboard">
      <header className="topbar">
        <h1>Projects</h1>
        <nav>
          <Link to="/app/settings">YouTube & account</Link>
          <Link to="/app/billing">Billing</Link>
          <Link to="/app/diagnostics">Diagnostics</Link>
          <button type="button" className="linkish" onClick={() => logout()}>
            Sign out
          </button>
        </nav>
      </header>

      <form className="card" onSubmit={create}>
        <h2>New Short</h2>
        <label>
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} required />
        </label>
        <label>
          Script ( spoken + captions )
          <textarea
            value={script}
            onChange={(e) => setScript(e.target.value)}
            required
            rows={6}
            placeholder="Your Short script..."
          />
        </label>
        {err && <p className="error">{err}</p>}
        <button type="submit">Create project</button>
      </form>

      <ul className="project-list">
        {projects.map((p) => (
          <li key={p.id}>
            <Link to={`/app/project/${p.id}`}>
              <strong>{p.title}</strong>
              <span className={`badge ${p.status}`}>{p.status}</span>
              {p.duration_seconds != null && (
                <span className="meta">{p.duration_seconds.toFixed(1)}s</span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
