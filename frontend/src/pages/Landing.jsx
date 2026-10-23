import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { getStoredToken } from '../auth';
import { t } from '../i18n';

const PERSONAS = [
  { key: 'crew', ico: '🔧', title: 'Field Crew', subtitle: 'My assigned maintenance jobs', desc: 'See your task queue, run checklists, capture GPS on site.' },
  { key: 'director', ico: '🗂', title: 'Director / Manager', subtitle: 'My region\u2019s health: tasks, violations, schedules, certs', desc: 'Region overview, GPS violations, upcoming work, expiring certifications.' },
  { key: 'executive', ico: '🏛', title: 'Executive', subtitle: 'Whole-of-company overview & governance', desc: 'Company-wide activity across all directorates and divisions.' },
  { key: 'planner', ico: '🗓', title: 'Planner / Dispatcher', subtitle: 'Create and schedule work', desc: 'Draft and schedule tasks, assign crews, manage the calendar.' },
  { key: 'auditor', ico: '🔍', title: 'Auditor', subtitle: 'Review evidence and compliance', desc: 'Audit trail, pending verifications, GPS and certification compliance.' },
  { key: 'other', ico: '👤', title: 'Other / Sign in', subtitle: 'I have an account', desc: 'Administrators and everyone else sign in here.' },
];

export default function Landing() {
  const nav = useNavigate();
  useEffect(() => {
    if (getStoredToken()) nav('/home', { replace: true });
  }, [nav]);
  return (
    <div className="landing">
      <div className="landing-hero">
        <div className="landing-logo"><em>T</em></div>
        <h1>{t('appName')}</h1>
        <p>{t('tagline')}</p>
        <div className="landing-hint">Who are you? Choose your role to get the view you deserve.</div>
      </div>
      <div className="landing-grid">
        {PERSONAS.map((p) => (
          <button key={p.key} className="landing-card" onClick={() => nav(`/login?persona=${p.key}`)}>
            <div className="landing-ico">{p.ico}</div>
            <div className="landing-title">{p.title}</div>
            <div className="landing-sub">{p.subtitle}</div>
            <div className="landing-desc">{p.desc}</div>
            <div className="landing-go">Continue →</div>
          </button>
        ))}
      </div>
      <div className="landing-footer">Ethiopian Electric Power · Transmission Maintenance Management System</div>
    </div>
  );
}
