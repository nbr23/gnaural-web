import { useCallback, useEffect, useRef } from 'react';

/**
 * How often an edit reaches the engine. A transition is already ~70 ms wide (`scheduleLookahead`'s
 * 50 ms floor plus `CLICK_FREE_RAMP`'s 20 ms), so calling faster than that would cancel each
 * update's ramp before it lands. 100 ms is the first round number clear of that window.
 */
export const ENGINE_UPDATE_INTERVAL_MS = 100;

/**
 * Rate-limit a value going somewhere expensive, delivering the first change at once and the last
 * change always — dropping the final change would leave the audio at a frequency the readout
 * doesn't show. Flushes on unmount too, so leaving the view mid-drag can't strand a stale value.
 * `setTimeout` rather than `requestAnimationFrame`: the driver is a finger on a slider, not a poll,
 * so the trailing edge must still fire once the tab is backgrounded.
 */
export function useThrottled<T>(
  action: (value: T) => void,
  interval = ENGINE_UPDATE_INTERVAL_MS,
): (value: T) => void {
  const latest = useRef(action);
  latest.current = action;

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<{ value: T } | null>(null);
  const lastRun = useRef(0);

  const run = useCallback((value: T) => {
    lastRun.current = Date.now();
    pending.current = null;
    latest.current(value);
  }, []);

  const flush = useCallback(() => {
    timer.current = null;
    if (pending.current) run(pending.current.value);
  }, [run]);

  useEffect(
    () => () => {
      if (timer.current === null) return;
      clearTimeout(timer.current);
      flush();
    },
    [flush],
  );

  return useCallback(
    (value: T) => {
      const elapsed = Date.now() - lastRun.current;
      if (timer.current === null && elapsed >= interval) {
        run(value);
        return;
      }

      pending.current = { value };
      if (timer.current === null) {
        timer.current = setTimeout(flush, Math.max(0, interval - elapsed));
      }
    },
    [flush, interval, run],
  );
}
