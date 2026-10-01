export interface NamedRef {
  id?: number;
  name?: string | null;
}

export interface TaskTarget {
  asset?: NamedRef | null;
  substation?: NamedRef | null;
  line?: NamedRef | null;
  tower?: NamedRef | null;
}

export interface Readiness {
  eligible?: boolean;
  missing_skills?: string[];
  missing_certs?: string[];
  equipment_to_secure?: string[];
  equipment_checks?: unknown[];
  warnings?: string[];
}

export interface ChecklistTemplateBrief {
  id: number;
  name?: string | null;
  code?: string | null;
  estimated_minutes?: number | null;
  is_mandatory?: number | boolean | null;
}

export interface TaskDetail {
  id: number;
  task_number?: string | null;
  title?: string | null;
  description?: string | null;
  status?: string | null;
  priority?: string | null;
  due_date?: string | null;
  scheduled_start?: string | null;
  scheduled_end?: string | null;
  actual_start?: string | null;
  actual_end?: string | null;
  region?: NamedRef | null;
  line?: NamedRef | null;
  crew?: NamedRef | null;
  target?: TaskTarget | null;
  readiness?: Readiness | null;
  checklist_templates?: ChecklistTemplateBrief[] | null;
  findings?: unknown[] | null;
  attachments?: unknown[] | null;
  executions?: unknown[] | null;
  gps_validations?: unknown[] | null;
}

export function targetLabel(target?: TaskTarget | null, line?: NamedRef | null): string {
  if (!target) return line?.name ?? '—';
  const parts = [
    target.line?.name,
    target.substation?.name,
    target.tower?.name,
    target.asset?.name,
  ].filter(Boolean);
  if (parts.length > 0) return parts.join('  ·  ');
  return line?.name ?? '—';
}
