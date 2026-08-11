import { useEffect } from 'react';

/**
 * Hold the screen awake while a program plays (PLAN.md §5.1).
 *
 * **Default off, and a user-facing toggle rather than a side effect of pressing play** — it burns
 * battery, and the common case here is a sleep program where a lit screen is precisely wrong.
 * Playback does not need it: the schedule is already on the audio thread (§4.2), so the screen
 * going off costs nothing.
 *
 * The sentinel is released by the OS whenever the page is hidden and is not restored on return,
 * so a re-acquire on `visibilitychange` is not belt-and-braces — without it the lock is gone
 * after the first glance at another app.
 */
export function useWakeLock(enabled: boolean): void {
  useEffect(() => {
    const api = navigator.wakeLock;
    if (!enabled || !api) return;

    let sentinel: WakeLockSentinel | null = null;
    let released = false;

    const acquire = async () => {
      if (released || sentinel || document.visibilityState !== 'visible') return;
      try {
        sentinel = await api.request('screen');
        sentinel.addEventListener('release', () => {
          sentinel = null;
        });
      } catch {
        // Refused — the battery saver is on, or the document is not allowed one. Not an error
        // worth surfacing: nothing about playback depends on it.
      }
    };

    void acquire();
    document.addEventListener('visibilitychange', acquire);

    return () => {
      released = true;
      document.removeEventListener('visibilitychange', acquire);
      void sentinel?.release().catch(() => undefined);
    };
  }, [enabled]);
}
