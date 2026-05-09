import { Link } from 'react-router-dom';

export default function Home() {
  return (
    <div className="home">
      <h1>Shorts Studio</h1>
      <p className="lead">
        Build faceless Shorts: paste a script, add TTS and burned-in captions, loop your own gameplay
        background, connect YouTube, and schedule publishes. Monetize with subscriptions when you are
        ready.
      </p>
      <div className="home-actions">
        <Link to="/login" className="btn primary">
          Open app
        </Link>
      </div>
      <section className="note">
        <h2>What you need</h2>
        <ul>
          <li>
            <strong>FFmpeg</strong> on the machine running the API (for render). PostgreSQL (
            <code>docker compose up -d</code> in this folder).
          </li>
          <li>
            <strong>Background clips</strong>: use videos you have rights to (screen recordings, licensed
            packs). The app does not ship third-party game footage.
          </li>
          <li>
            <strong>YouTube</strong>: Google Cloud OAuth client + YouTube Data API v3, redirect URI
            matching <code>.env</code>.
          </li>
          <li>
            <strong>TTS</strong>: optional <code>GOOGLE_TTS_API_KEY</code> (Google Cloud Text-to-Speech); on
            Windows the API falls back to system speech without it.
          </li>
        </ul>
      </section>
    </div>
  );
}
