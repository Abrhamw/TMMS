export function safeNextPath(value) {
  if (typeof value !== 'string') return null;
  const next = value.trim();
  if (!next.startsWith('/') || next.startsWith('//')) return null;
  if (next.includes('://') || next.includes('\\')) return null;
  return next;
}
