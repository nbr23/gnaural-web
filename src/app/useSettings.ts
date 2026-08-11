import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_EXPORT_SAMPLE_RATE } from '../engine/render';
import type { Settings } from '../library/storage';
import { loadSettings, saveSetting } from '../library/storage';

/** How long changes settle before they are written. The volume slider fires on every pixel of a
 *  drag; the database does not need to hear about all of them. */
const WRITE_DEBOUNCE_MS = 250;

export const DEFAULT_SETTINGS: Settings = {
  masterGain: 1,
  exportSampleRate: DEFAULT_EXPORT_SAMPLE_RATE,
  /** Off by default (PLAN.md §5.1) — it burns battery and the common case is a sleep program. */
  wakeLock: false,
  headphoneNoticeSeen: false,
};

export interface SettingsStore {
  settings: Settings;
  /**
   * Whether the stored values have arrived yet.
   *
   * Everything else here tolerates the defaults showing first — a volume slider that jumps from 1
   * to 0.35 a frame later is not worth a blank launch. A *first-run* notice does not tolerate it:
   * its default is "not yet seen", so without this it would flash on every single launch and then
   * vanish. Anything gated on a boolean the user has already answered must wait for the read.
   */
  hydrated: boolean;
  set<K extends keyof Settings>(key: K, value: Settings[K]): void;
}

/**
 * The handful of preferences that outlive a visit (PLAN.md §5.1), backed by IndexedDB.
 *
 * **Defaults are synchronous and stored values arrive after.** Gating the first render on a
 * database read would mean a blank frame on every launch to save a volume slider from moving, and
 * nothing here is applied to audio before the user's first gesture anyway — by which time the read
 * has long settled.
 */
export function useSettings(): SettingsStore {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [hydrated, setHydrated] = useState(false);

  /** Anything the user changed during the initial read must win over what that read returns. */
  const touched = useRef(new Set<keyof Settings>());
  const pending = useRef<Partial<Settings>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const write = useCallback(() => {
    for (const [key, value] of Object.entries(pending.current)) {
      void saveSetting(key as keyof Settings, value as never);
    }
    pending.current = {};
    timer.current = null;
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadSettings().then((stored) => {
      if (cancelled) return;
      setSettings((current) => {
        const merged = { ...current };
        for (const [key, value] of Object.entries(stored) as [keyof Settings, never][]) {
          if (!touched.current.has(key)) merged[key] = value;
        }
        return merged;
      });
      setHydrated(true);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  // A change made in the last quarter-second is written on the way out rather than dropped.
  useEffect(
    () => () => {
      if (timer.current === null) return;
      clearTimeout(timer.current);
      write();
    },
    [write],
  );

  const set = useCallback(
    <K extends keyof Settings>(key: K, value: Settings[K]) => {
      touched.current.add(key);
      setSettings((current) => ({ ...current, [key]: value }));

      pending.current[key] = value;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(write, WRITE_DEBOUNCE_MS);
    },
    [write],
  );

  return { settings, hydrated, set };
}
