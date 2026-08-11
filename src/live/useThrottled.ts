import { useCallback, useEffect, useRef } from 'react';

/**
 * How often an edit reaches the engine. The precedent is `CLOCK_INTERVAL_MS` in `usePlayer`, and
 * so is the reasoning, but the number comes from somewhere more specific.
 *
 * **A transition is already ~70 ms wide.** `scheduleLookahead` is at least 50 ms — and Android
 * reports `baseLatency` 0, so the floor is exactly what applies there — plus `CLICK_FREE_RAMP` at
 * 20 ms. Calling faster than that means every update cancels the previous one's ramp before it has
 * landed, which is the ramp-in-the-past bug rebuilt from the caller's side. 100 ms is the first
 * round number clear of the window.
 */
export const LIVE_UPDATE_INTERVAL_MS = 100;

/**
 * Rate-limit a value going somewhere expensive, delivering the first change at once and the last
 * change always.
 *
 * **The trailing edge is not an optimisation, it is the correctness condition.** A throttle that
 * drops the final change leaves the audio at a frequency the readout does not show — every
 * intermediate value may be dropped, the last one may not. It also flushes on unmount, so leaving
 * the view mid-drag cannot strand the engine on a stale value.
 *
 * `setTimeout` rather than `requestAnimationFrame`, which is what `usePlayer`'s clock uses: rAF is
 * right for a *poll*, since a backgrounded tab should stop polling, and wrong for this, since the
 * driver is a finger on a slider — a trailing edge that never fires because the tab was hidden
 * would strand exactly the value that must not be dropped.
 */
export function useThrottled<T>(
  action: (value: T) => void,
  interval = LIVE_UPDATE_INTERVAL_MS,
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
