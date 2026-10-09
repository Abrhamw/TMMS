import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDebouncer } from './debounce';

describe('createDebouncer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs once with the latest arguments after the delay', () => {
    const fn = vi.fn();
    const d = createDebouncer(fn, 700);
    d('a');
    d('b');
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(699);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('b');
  });

  it('flush runs immediately and cancels the pending timer', () => {
    const fn = vi.fn();
    const d = createDebouncer(fn, 700);
    d('x');
    d.flush();
    expect(fn).toHaveBeenCalledWith('x');
    vi.advanceTimersByTime(700);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('flush is a no-op when nothing is pending', () => {
    const fn = vi.fn();
    const d = createDebouncer(fn, 700);
    d.flush();
    expect(fn).not.toHaveBeenCalled();
  });

  it('cancel drops pending work and pending() reports state', () => {
    const fn = vi.fn();
    const d = createDebouncer(fn, 700);
    d('z');
    expect(d.pending()).toBe(true);
    d.cancel();
    expect(d.pending()).toBe(false);
    vi.advanceTimersByTime(700);
    expect(fn).not.toHaveBeenCalled();
  });
});
