import { useEffect } from 'react';

/**
 * Hold the screen awake while a program plays.
 *
 * Default off, and a user-facing toggle rather than a side effect of pressing play — it burns
 * battery, and the common case here is a sleep program where a lit screen is precisely wrong.
 * Playback doesn't need it: the schedule is already on the audio thread, so the screen going off
 * costs nothing.
 *
 * The sentinel is released by the OS whenever the page is hidden and is not restored on return, so
 * the re-acquire on `visibilitychange` isn't belt-and-braces — without it the lock is gone after
 * the first glance at another app.
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
        // Refused — battery saver is on, or the document isn't allowed one. Nothing about
        // playback depends on it, so this isn't worth surfacing as an error.
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
