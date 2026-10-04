import { useEffect, useRef } from 'react';

const TYPING = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

// Global single-key shortcuts for the mailbox. `map` is keyed by `KeyboardEvent.key`
// (e.g. 'j', 'Enter', '#', '?', 'Escape'). Shortcuts are ignored while the user is
// typing in a field or when a modifier key is held, so they never hijack input.
export default function useMailKeyboard(map, enabled = true) {
  const ref = useRef(map);
  ref.current = map;

  useEffect(() => {
    if (!enabled) return undefined;
    function onKey(event) {
      const el = event.target;
      if (el && (TYPING.has(el.tagName) || el.isContentEditable)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const fn = ref.current[event.key];
      if (!fn) return;
      event.preventDefault();
      fn(event);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
