export interface ChecklistItem {
  id: number;
  template_id: number;
  sequence: number;
  section?: string | null;
  instruction: string;
  response_type: string;
  required: number | boolean;
  pass_criteria?: unknown;
  critical_step?: number | boolean;
  test_equipment?: string | null;
}

export interface ChecklistDraftItem {
  template_item_id: number | null;
  sequence: number | null;
  response_value: unknown;
  comment?: string | null;
}

export interface ChecklistTemplate {
  id: number;
  code?: string | null;
  name?: string | null;
  estimated_minutes?: number | null;
  is_mandatory?: number | boolean;
  items: ChecklistItem[];
  last_execution?: { id: number; result?: string | null } | null;
  draft?: {
    id: number;
    notes?: string | null;
    updated_at?: string;
    items: ChecklistDraftItem[];
  } | null;
}

export interface ChecklistResponse {
  task: { id: number; task_number?: string; status?: string };
  template: ChecklistTemplate | null;
  templates: ChecklistTemplate[];
}

export interface GpsPoint {
  lat: number;
  lng: number;
  accuracy_m: number | null;
}

export interface ChecklistSubmitItem {
  template_item_id: number;
  sequence: number;
  response_value: unknown;
  comment: string | null;
}

export function isRequired(item: ChecklistItem): boolean {
  return item.required === true || item.required === 1;
}

export function isCritical(item: ChecklistItem): boolean {
  return item.critical_step === true || item.critical_step === 1;
}
