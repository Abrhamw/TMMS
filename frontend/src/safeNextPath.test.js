import { describe, it, expect } from 'vitest';
import { safeNextPath } from './safeNextPath';

describe('safeNextPath', () => {
  it('accepts an internal path with a query string', () => {
    expect(safeNextPath('/infrastructure?tab=line&line=1')).toBe('/infrastructure?tab=line&line=1');
  });

  it('rejects protocol-relative and absolute URLs', () => {
    expect(safeNextPath('//evil.example')).toBeNull();
    expect(safeNextPath('https://evil.example')).toBeNull();
    expect(safeNextPath('http://evil.example/x')).toBeNull();
  });

  it('rejects missing, blank, and backslash paths', () => {
    expect(safeNextPath(null)).toBeNull();
    expect(safeNextPath('')).toBeNull();
    expect(safeNextPath('/ok\\nope')).toBeNull();
    expect(safeNextPath('tasks/1')).toBeNull();
  });
});
