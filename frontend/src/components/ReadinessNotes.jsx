import { useEffect, useState } from 'react';
import { api } from '../api';

// Compact, non-blocking dispatch readiness note for the guided run surface.
// Hidden when the task has no checklist or the resolved crew fully covers it.
export default function ReadinessNotes({ taskId }) {
  const [audit, setAudit] = useState(null);

  useEffect(() => {
    let alive = true;
    api.get(`/tasks/${taskId}/readiness`).then((r) => { if (alive) setAudit(r); }).catch(() => {});
    return () => { alive = false; };
  }, [taskId]);

  if (!audit || !audit.requirements) return null;
  const gaps = [
    ...(audit.missing_skills || []).length ? [`Missing skills: ${audit.missing_skills.join(', ')}`] : [],
    ...(audit.missing_certs || []).length ? [`Missing required certs: ${audit.missing_certs.join(', ')}`] : [],
    ...(audit.team_shortfall > 0 ? [`Team short by ${audit.team_shortfall}`] : []),
    ...(audit.equipment_to_secure || []).length ? [`Missed equipment: ${audit.equipment_to_secure.join(', ')}`] : [],
  ];
  if (!gaps.length) return null;
  return (
    <div className="box mt" style={{ background: '#fffbeb', borderColor: '#fde68a', fontSize: 12 }}>
      <b>{audit.template?.name || 'Dispatch readiness'}</b>
      {gaps.map((g, i) => <div key={i}>{g}</div>)}
    </div>
  );
}
