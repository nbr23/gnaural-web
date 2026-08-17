import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { serializeSchedule } from '../document/serializer';
import type { Schedule } from '../document/types';
import { GNAURAL_EXTENSION } from '../files/openFile';
import { fileNameFor, saveBlob } from '../files/saveFile';
import { ShareTooLargeError, encodeSharePayload, shareUrl } from '../files/shareLink';
import type { NoiseLayerSettings } from '../engine/engine';
import { RenderCancelledError, renderFrameCount, renderSchedule } from '../engine/render';
import { encodeWav, wavByteLength } from '../engine/wav';

export type ExportStatus = 'idle' | 'rendering' | 'saving';

export interface Exporter {
  status: ExportStatus;
  /** 0–1 while rendering. */
  progress: number;
  error: string | null;
  /** Transient confirmation of a share, since copying to the clipboard is otherwise invisible. */
  notice: string | null;
  /** Size the WAV would be with the current settings. */
  estimatedBytes: number;
  exportWav(): void;
  exportGnaural(): void;
  share(): void;
  cancel(): void;
}

/**
 * Owns an export in flight: render → encode → save, plus the state the panel shows.
 *
 * Deliberately independent of `usePlayer` — an export renders the document as authored, in its
 * own `OfflineAudioContext`, and neither reads nor disturbs playback.
 */
export function useExport(
  schedule: Schedule,
  sampleRate: number,
  noise?: NoiseLayerSettings,
): Exporter {
  const [status, setStatus] = useState<ExportStatus>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  // A render can outlive navigation away from the player, so state updates are dropped once the
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
        noise,
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
  }, [noise, save, sampleRate, schedule]);

  const exportGnaural = useCallback(async () => {
    setError(null);
    const blob = new Blob([serializeSchedule(schedule)], { type: 'application/xml' });
    await save(fileNameFor(schedule.title, GNAURAL_EXTENSION), blob);
  }, [save, schedule]);

  /**
   * Hand the whole program to someone else as a URL — the native share sheet where one exists,
   * the clipboard everywhere else. A program too big for a fragment falls back to exporting the
   * file, which is the same program by a slower route rather than a dead end.
   */
  const share = useCallback(async () => {
    setError(null);
    setNotice(null);

    let url: string;
    try {
      url = shareUrl(await encodeSharePayload(schedule));
    } catch (thrown) {
      if (!(thrown instanceof ShareTooLargeError)) throw thrown;
      setNotice('Too large for a link — exporting the file instead.');
      await exportGnaural();
      return;
    }

    if (navigator.share) {
      try {
        await navigator.share({ title: schedule.title || 'Gnaural program', url });
        return;
      } catch (thrown) {
        // Dismissing the share sheet is a cancel, not a failure worth reporting.
        if (thrown instanceof DOMException && thrown.name === 'AbortError') return;
      }
    }

    try {
      await navigator.clipboard.writeText(url);
      setNotice('Link copied.');
    } catch {
      setError('The link could not be copied.');
    }
  }, [exportGnaural, schedule]);

  const cancel = useCallback(() => abort.current?.abort(), []);

  return {
    status,
    progress,
    error,
    notice,
    estimatedBytes,
    exportWav: () => void exportWav(),
    exportGnaural: () => void exportGnaural(),
    share: () => void share(),
    cancel,
  };
}
