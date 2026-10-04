import { useRef } from 'react';

// Delegated horizontal-swipe detection. Spread `bind` on a list container; when a
// pointer travels past `threshold` horizontally (and more than it travels
// vertically) `resolve({ direction })` fires with 'left' or 'right'. Rows should
// call `consumeClick()` in their click handler to swallow the click that follows.
export default function useSwipe({ resolve, threshold = 70, enabled = true }) {
  const start = useRef(null);
  const fired = useRef(false);

  function onPointerDown(event) {
    if (!enabled) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    start.current = { x: event.clientX, y: event.clientY, target: event.target };
    fired.current = false;
  }

  function onPointerUp(event) {
    const s = start.current;
    start.current = null;
    if (!s) return;
    const dx = event.clientX - s.x;
    const dy = event.clientY - s.y;
    if (Math.abs(dx) < threshold || Math.abs(dx) < Math.abs(dy)) return;
    fired.current = true;
    resolve({ direction: dx < 0 ? 'left' : 'right', dx, dy, target: s.target });
  }

  function reset() { start.current = null; }

  function consumeClick() {
    const value = fired.current;
    fired.current = false;
    return value;
  }

  return { bind: { onPointerDown, onPointerUp, onPointerCancel: reset, onPointerLeave: reset }, consumeClick };
}
