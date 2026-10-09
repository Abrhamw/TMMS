export function createDebouncer(fn, delay) {
  let timer = null;
  let lastArgs = null;

  const schedule = (...args) => {
    lastArgs = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...lastArgs);
    }, delay);
  };

  schedule.flush = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    fn(...lastArgs);
  };

  schedule.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  schedule.pending = () => timer !== null;

  return schedule;
}
