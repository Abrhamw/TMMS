import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Loading } from '../components';
import { KpiTile, BarRow } from '../components/InfraVisuals';
import { SectionCard, Tabs } from '../components/viz';
import Tasks from './Tasks';
import Schedules from './Schedules';
import Checklists from './Checklists';
import Crews from './Crews';
import Certifications from './Certifications';

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'schedules', label: 'Schedules' },
  { key: 'checklists', label: 'Checklists' },
  { key: 'crews', label: 'Crews' },
  { key: 'certifications', label: 'Certifications' },
];

function WorkSummary() {
  const [summary, setSummary] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    api.get('/work/summary')
      .then((res) => { if (alive) setSummary(res); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, []);

  if (failed) return null;
  if (!summary) return <Loading />;

  const tasks = summary.tasks || {};
  const workforce = summary.workforce || {};
  const schedules = summary.schedules || {};
  const byStatus = tasks.by_status || {};
  const open = (byStatus.DRAFT || 0) + (byStatus.SCHEDULED || 0) + (byStatus.ASSIGNED || 0)
    + (byStatus.IN_PROGRESS || 0) + (byStatus.ON_HOLD || 0) + (byStatus.PENDING_VERIFICATION || 0);
  const overdue = summary.recommendations?.find((r) => r.id === 'overdue-work')?.metric?.value || 0;
  const certReadiness = workforce.certifications
    ? Math.round((workforce.valid_certifications || 0) / workforce.certifications * 100)
    : 0;

  return (
    <div className="mt">
      <div className="executive-kpis">
        <KpiTile label="Open tasks" value={open} sub={`${tasks.total || 0} total`} />
        <KpiTile label="Overdue" value={overdue} tone={overdue ? 'warn' : 'ok'} />
        <KpiTile label="Schedules" value={schedules.total || 0} />
        <KpiTile label="Active crews" value={`${workforce.active_crews || 0}/${workforce.crews || 0}`} />
        <KpiTile label="Certification readiness" value={`${certReadiness}%`} tone={certReadiness < 60 ? 'warn' : 'ok'} />
      </div>
      <div className="executive-grid mt">
        <SectionCard title="Tasks by status">
          {Object.entries(byStatus).length ? Object.entries(byStatus).map(([status, count]) => (
            <BarRow key={status} label={status.replace(/_/g, ' ')} value={count} max={tasks.total || 1} />
          )) : <div className="muted">No tasks in scope.</div>}
        </SectionCard>
        <SectionCard title="Schedule frequency">
          {Object.entries(schedules.by_frequency || {}).length ? Object.entries(schedules.by_frequency).map(([frequency, count]) => (
            <BarRow key={frequency} label={frequency.replace(/_/g, ' ')} value={count} max={schedules.total || 1} />
          )) : <div className="muted">No schedules recorded.</div>}
        </SectionCard>
      </div>
    </div>
  );
}

export default function WorkHub() {
  const [searchParams] = useSearchParams();
  const initial = useMemo(() => {
    const area = searchParams.get('area');
    return TABS.some((t) => t.key === area) ? area : 'overview';
  }, []);
  const [area, setArea] = useState(initial);

  return (
    <>
      <div className="hub-tabs-bar">
        <Tabs tabs={TABS} active={area} onChange={setArea} />
      </div>
      {area === 'overview' && <WorkSummary />}
      {area === 'tasks' && <Tasks />}
      {area === 'schedules' && <Schedules />}
      {area === 'checklists' && <Checklists />}
      {area === 'crews' && <Crews />}
      {area === 'certifications' && <Certifications />}
    </>
  );
}
