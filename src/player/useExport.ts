import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { serializeSchedule } from '../document/serializer';
import type { Schedule } from '../document/types';
import { GNAURAL_EXTENSION } from '../files/openFile';
import { fileNameFor, saveBlob } from '../files/saveFile';
import {
  DEFAULT_EXPORT_SAMPLE_RATE,
  RenderCancelledError,
  renderFrameCount,
  renderSchedule,
} from '../engine/render';
import { encodeWav, wavByteLength } from '../engine/wav';

export type ExportStatus = 'idle' | 'rendering' | 'saving';

export interface Exporter {
  status: ExportStatus;
  /** 0–1 while rendering. */
  progress: number;
  error: string | null;
  sampleRate: number;
  /** Size of the WAV the current settings would produce, exactly as `encodeWav` will write it. */
  estimatedBytes: number;
  setSampleRate(rate: number): void;
  exportWav(): void;
  exportGnaural(): void;
  cancel(): void;
}

/**
 * Owns an export in flight: render → encode → save, plus the state the panel shows.
 *
 * Deliberately independent of `usePlayer` — an export renders the document as authored, at its
 * own sample rate, in its own `OfflineAudioContext`, and neither reads nor disturbs playback.
 * Nothing about it needs to outlive the player view, so it is held by the panel rather than
 * threaded down from `App`.
 */
export function useExport(schedule: Schedule): Exporter {
  const [status, setStatus] = useState<ExportStatus>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [sampleRate, setSampleRate] = useState(DEFAULT_EXPORT_SAMPLE_RATE);
  const abort = useRef<AbortController | null>(null);

  // A render outlives navigation away from the player, so state updates are dropped once the
  // hook is gone rather than warning about an unmounted component.
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      abort.current?.abort();
    };
  }, []);

  const estimatedBytes = useMemo(
    () => wavByteLength(renderFrameCount(schedule, sampleRate), 2),
    [schedule, sampleRate],
  );

  const save = useCallback(async (name: string, blob: Blob) => {
    try {
      await saveBlob(name, blob);
    } catch {
      if (live.current) setError('The file could not be saved.');
    }
  }, []);

  const exportWav = useCallback(async () => {
    const controller = new AbortController();
    abort.current = controller;
    setError(null);
    setProgress(0);
    setStatus('rendering');

    try {
      const buffer = await renderSchedule(schedule, {
        sampleRate,
        signal: controller.signal,
        onProgress: (fraction) => {
          if (live.current) setProgress(fraction);
        },
      });
      if (!live.current || controller.signal.aborted) return;

      setStatus('saving');
      await save(fileNameFor(schedule.title, '.wav'), encodeWav(buffer));
    } catch (thrown) {
      if (live.current && !(thrown instanceof RenderCancelledError)) {
        setError(thrown instanceof Error ? thrown.message : 'The export failed.');
      }
    } finally {
      abort.current = null;
      if (live.current) setStatus('idle');
    }
  }, [save, sampleRate, schedule]);

  const exportGnaural = useCallback(async () => {
    setError(null);
    const blob = new Blob([serializeSchedule(schedule)], { type: 'application/xml' });
    await save(fileNameFor(schedule.title, GNAURAL_EXTENSION), blob);
  }, [save, schedule]);

  const cancel = useCallback(() => abort.current?.abort(), []);

  return {
    status,
    progress,
    error,
    sampleRate,
    estimatedBytes,
    setSampleRate,
    exportWav: () => void exportWav(),
    exportGnaural: () => void exportGnaural(),
    cancel,
  };
}
