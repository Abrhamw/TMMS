import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { login } from '../auth';
import { t } from '../i18n';

const DEMO = [
  ['admin', 'Admin@123', 'ADMIN', 'other'],
  ['ceo', 'Executive@123', 'EXECUTIVE', 'executive'],
  ['exec.tbu', 'Executive@123', 'EXECUTIVE', 'executive'],
  ['exec.tso', 'Executive@123', 'EXECUTIVE', 'executive'],
  ['dir.rc', 'Executive@123', 'EXECUTIVE', 'executive'],
  ['dir.c1', 'Region@123', 'REGION_DIRECTOR', 'director'],
  ['dir.ot', 'Executive@123', 'OT_MANAGER', 'executive'],
  ['mgr.ot.prot', 'Manager@123', 'OT_MANAGER', 'director'],
  ['mgr.ot.scada', 'Manager@123', 'OT_MANAGER', 'director'],
  ['mgr.ot.tel', 'Manager@123', 'OT_MANAGER', 'director'],
  ['mgr.c1.som', 'Manager@123', 'SUBSTATION_MANAGER', 'director'],
  ['mgr.c1.tlom', 'Manager@123', 'TRANSMISSION_MANAGER', 'director'],
  ['mgr.c1.rs', 'Manager@123', 'RELAY_SCADA_MANAGER', 'director'],
  ['crew.c1', 'Crew@123', 'CREW_LEAD', 'crew'],
  ['crew.otrly.lead', 'Crew@123', 'CREW_LEAD', 'crew'],
  ['crew.c1special.lead', 'Crew@123', 'CREW_LEAD', 'crew'],
  ['crew.c1tlom.lead', 'Crew@123', 'CREW_LEAD', 'crew'],
  ['crew.c1som.m3', 'Member@123', 'CREW_MEMBER', 'crew'],
  ['crew.c1tlom.m4', 'Member@123', 'CREW_MEMBER', 'crew'],
];

const PERSONA_LABEL = {
  crew: 'Field Crew',
  director: 'Director / Manager',
  executive: 'Executive',
  planner: 'Planner / Dispatcher',
  auditor: 'Auditor',
  other: 'General sign-in',
};

export default function Login() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const persona = params.get('persona') || 'other';
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const demos = DEMO.filter(([, , , p]) => p === persona);

  async function doLogin(u, p) {
    setError('');
    setBusy(true);
    try {
      await login(u, p);
      nav('/home', { replace: true });
    } catch (err) {
      setError(t('loginFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function submit(e) {
    e.preventDefault();
    await doLogin(username.trim(), password);
  }

  function fill(u, p) {
    setUsername(u);
    setPassword(p);
    setError('');
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-brand">
          <div className="logo lg"><em>T</em></div>
          <h1>TMMS</h1>
          <p>{t('tagline')}</p>
        </div>
        <div className="login-persona">
          <b>{PERSONA_LABEL[persona] || 'Sign in'}</b>
          <button className="btn btn-sm btn-ghost" type="button" onClick={() => nav('/')}>← Change role</button>
        </div>
        <h2>{t('signInPrompt')}</h2>
        {error && <div className="alert alert-error">{error}</div>}
        <form onSubmit={submit}>
          <label>{t('username')}</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus />
          <label>{t('password')}</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          <button className="btn btn-primary btn-block" disabled={busy}>{busy ? t('loading') : t('login')}</button>
        </form>
        <div className="demo-box">
          <div className="demo-title">{t('demoAccounts')}</div>
          <div className="demo-grid">
            {demos.map(([u, p, r]) => (
              <button key={u} className="demo-chip" type="button" onClick={() => fill(u, p)}>
                <b>{u}</b> <span>{r}</span>
              </button>
            ))}
          </div>
          {demos.length === 0 && (
            <button className="demo-chip" type="button" onClick={() => fill('admin', 'Admin@123')}>
              <b>admin</b> <span>ADMIN</span>
            </button>
          )}
          <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            Pick a demo to fill the form, then sign in. Or use the quick sign-in below.
          </p>
          {demos.slice(0, 2).map(([u, p, r]) => (
            <button key={`q-${u}`} className="btn btn-sm btn-primary" style={{ marginTop: 6, marginRight: 6 }} type="button" onClick={() => doLogin(u, p)}>
              Quick sign-in as {r}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
