import { type FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';

type TemplateRow = {
  id: string;
  name: string;
  prompt_template: string | null;
  voice_name: string | null;
  caption_style: string | null;
  bg_category: string | null;
  created_at: string;
};

export default function Templates() {
  const [list, setList] = useState<TemplateRow[]>([]);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [capt, setCapt] = useState('');
  const [bg, setBg] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  async function load() {
    const d = await api<{ templates: TemplateRow[] }>('/api/templates');
    setList(d.templates || []);
  }

  useEffect(() => {
    load().catch(() => setErr('Could not load templates'));
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    setErr('');
    setMsg('');
    try {
      await api('/api/templates', {
        method: 'POST',
        body: JSON.stringify({
          name,
          prompt_template: prompt || null,
          caption_style: capt || null,
          bg_category: bg || null,
        }),
      });
      setName('');
      setPrompt('');
      setCapt('');
      setBg('');
      setMsg('Saved.');
      await load();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Failed');
    }
  }

  async function rm(id: string) {
    setErr('');
    try {
      await api(`/api/templates/${id}`, { method: 'DELETE' });
      await load();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Delete failed');
    }
  }

  return (
    <div className="page">
      <header className="topbar">
        <h1>Templates</h1>
        <Link to="/app">← App</Link>
      </header>

      <section className="card">
        <h2>New template</h2>
        <p className="hint">Starter presets per project tone (stored per account). Paste a prompt scaffold you reuse.</p>
        <form onSubmit={(e) => void save(e)}>
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label>
            Prompt template
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={5} placeholder="Tone, structure, niche…" />
          </label>
          <label>
            Caption style id (optional, e.g. bold_pop)
            <input value={capt} onChange={(e) => setCapt(e.target.value)} placeholder="bold_pop" />
          </label>
          <label>
            Background theme id (optional: gameplay · calm · hype)
            <input value={bg} onChange={(e) => setBg(e.target.value)} placeholder="gameplay" />
          </label>
          {err && <p className="error">{err}</p>}
          {msg && <p className="success">{msg}</p>}
          <button type="submit">Save template</button>
        </form>
      </section>

      <section className="card">
        <h2>Yours</h2>
        {list.length === 0 ? (
          <p className="hint">None yet.</p>
        ) : (
          <ul className="template-list">
            {list.map((t) => (
              <li key={t.id} className="template-item">
                <div>
                  <strong>{t.name}</strong>
                  <div className="hint mono">{new Date(t.created_at).toLocaleString()}</div>
                  {t.prompt_template ? <pre className="template-pre">{t.prompt_template}</pre> : null}
                  <div className="hint">
                    {t.caption_style ? <>Caption: {t.caption_style} · </> : null}
                    {t.bg_category ? <>BG: {t.bg_category}</> : null}
                  </div>
                </div>
                <button type="button" className="linkish" onClick={() => void rm(t.id)}>
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
