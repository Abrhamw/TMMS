export interface SessionUser {
  id: number;
  username: string;
  role: string;
  region_id: number | null;
  person_id: number | null;
  active?: number;
  created_at?: string;
  first_name?: string | null;
  last_name?: string | null;
  title?: string | null;
  email?: string | null;
  crew_id?: number | null;
  crew_ids?: number[];
  region?: unknown;
}

export interface LoginResponse {
  token: string;
  user: SessionUser;
}

export interface MeResponse {
  user: SessionUser;
}

export interface HealthResponse {
  status: string;
  service: string;
  time: string;
}

export function displayName(user: SessionUser | null): string {
  if (!user) return '';
  const first = user.first_name ?? '';
  const last = user.last_name ?? '';
  const full = `${first} ${last}`.trim();
  return full || user.username;
}
