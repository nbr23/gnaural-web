import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { serializeSchedule } from '../document/serializer';
import type { Schedule } from '../document/types';
import { isRenderableType } from '../document/types';
import { GNAURAL_EXTENSION } from '../files/openFile';
import { fileNameFor, saveBlob } from '../files/saveFile';
import { ShareTooLargeError, encodeSharePayload, shareUrl } from '../files/shareLink';
import type { NoiseLayerSettings } from '../engine/engine';
import { RenderCancelledError, renderFrameCount, renderSchedule } from '../engine/render';
import { encodeWav, wavByteLength } from '../engine/wav';
import type { VoiceGate } from './usePlayer';

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
  nothingAudible: boolean;
  exportWav(): void;
  exportGnaural(): void;
  share(): void;
  cancel(): void;
}

/**
 * The document as the session is currently hearing it: the player's mute and solo gates written
 * onto the voices they belong to.
 *
 * The gates are a superset of the document's own flags — `PlaybackEngine` seeds them from
 * `voice.muted` and a toggle can lift one — so a voice muted in the file but un-muted by hand is
 * audible here, which is what the listener is hearing. The schedule itself is returned untouched
 * when the two already agree: `useMemo` and the render both key on its identity, and an export
 * nobody has gated stays the same bytes it always was.
 *
 * Mute changes no timing (§3.7 counts every voice, muted or not), so this never changes how long
 * the render is.
 */
export function silenceMutedVoices(schedule: Schedule, gates: readonly VoiceGate[]): Schedule {
  const changed = schedule.voices.some(
    (voice, index) => index < gates.length && gates[index].muted !== voice.muted,
  );
  if (!changed) return schedule;

  return {
    ...schedule,
    voices: schedule.voices.map((voice, index) => {
      const muted = gates[index]?.muted ?? voice.muted;
      return muted === voice.muted ? voice : { ...voice, muted };
    }),
  };
}

function hasAudibleVoice(schedule: Schedule): boolean {
  return schedule.voices.some((voice) => isRenderableType(voice.type) && !voice.muted);
}

/**
 * Owns an export in flight: render → encode → save, plus the state the panel shows.
 *
 * `gates` are the player's session mute/solo, and they reach the **WAV and nothing else**: a WAV is
 * audio, so it is what you are hearing, while `.gnaural` and a share link are the program itself and
 * carry the document's own flags. Nothing is read from the player here — the caller passes the gates
 * in, the same way it passes the noise bed — and the render still runs in its own
 * `OfflineAudioContext` without disturbing playback.
 */
export function useExport(
  schedule: Schedule,
  sampleRate: number,
  noise?: NoiseLayerSettings,
  gates: readonly VoiceGate[] = [],
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

  const audible = useMemo(() => silenceMutedVoices(schedule, gates), [gates, schedule]);

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
      const buffer = await renderSchedule(audible, {
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
  }, [audible, noise, save, sampleRate, schedule]);

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
    nothingAudible: !hasAudibleVoice(audible),
    exportWav: () => void exportWav(),
    exportGnaural: () => void exportGnaural(),
    share: () => void share(),
    cancel,
  };
}
