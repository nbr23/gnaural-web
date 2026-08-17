import { useCallback, useEffect, useRef, useState } from 'react';
import { SILENT_NOISE_LAYER } from '../engine/engine';
import { DEFAULT_EXPORT_SAMPLE_RATE } from '../engine/render';
import { DEFAULT_LIVE_VALUES } from '../live/liveSchedule';
import type { Settings } from '../library/storage';
import { loadSettings, saveSetting } from '../library/storage';

/** How long changes settle before they are written. The volume slider fires on every pixel of a
 *  drag; the database does not need to hear about all of them. */
const WRITE_DEBOUNCE_MS = 250;

export const DEFAULT_SETTINGS: Settings = {
  masterGain: 1,
  exportSampleRate: DEFAULT_EXPORT_SAMPLE_RATE,
  /** Off by default — it burns battery and the common case is a sleep program. */
  wakeLock: false,
  headphoneNoticeSeen: false,
  /** Silent by default, and only a person turns it on. */
  noiseColour: SILENT_NOISE_LAYER.colour,
  noiseGain: SILENT_NOISE_LAYER.gain,
  liveBaseFreq: DEFAULT_LIVE_VALUES.baseFreq,
  liveBeatFreq: DEFAULT_LIVE_VALUES.beatFreq,
  favourites: [],
  /** Nothing overridden: top-level sections start open, everything nested starts folded. */
  sectionOverrides: [],
};

export interface SettingsStore {
  settings: Settings;
  /**
   * Whether the stored values have arrived yet. Most UI tolerates the defaults showing first, but a
   * first-run notice whose default is "not yet seen" would otherwise flash on every launch —
   * anything gated on a boolean the user has already answered must wait for this.
   */
  hydrated: boolean;
  set<K extends keyof Settings>(key: K, value: Settings[K]): void;
}

/**
 * The handful of preferences that outlive a visit, backed by IndexedDB. Defaults are synchronous
 * and stored values arrive after, since gating the first render on a database read would mean a
 * blank frame on every launch.
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
