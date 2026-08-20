import { scheduleDuration } from '../document/timing';
import type { Schedule } from '../document/types';
import type { NoiseLayerSettings } from './engine';
import { CLICK_FREE_RAMP, playSchedule } from './engine';

/**
 * Offline rendering of a schedule for WAV export (PLAN.md §5.1).
 *
 * The offline graph *is* the playback graph: this runs the same `playSchedule` that
 * `PlaybackEngine` shares its node building with, so `stereoswap`, `overallvolume_*`,
 * `voice_mono`, `voice_mute` and the end-of-schedule fade all come along for free, and an export
 * can be null-tested against live playback (§5.3).
 *
 * Nothing here reads the player. What is rendered is the schedule the caller passed and the options
 * it passed with it, so the same arguments always produce the same bytes — the app-level noise bed
 * (§4.5b) arrives as `noise` because someone ticked a checkbox next to the button, and the session's
 * mute and solo arrive already written onto the voices (`silenceMutedVoices`) because a WAV is what
 * the listener is hearing. The session's master-volume slider reaches neither.
 */

export const DEFAULT_EXPORT_SAMPLE_RATE = 44100;

/** How often progress is sampled from the context's clock while rendering. */
const PROGRESS_INTERVAL_MS = 100;

export interface RenderOptions {
  sampleRate?: number;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  /** The app-level noise bed to mix in, when the export asked for one (§4.5b). */
  noise?: NoiseLayerSettings;
}

/** Length of the rendered file: the schedule (shortest voice, §3.7) plus the tail of its
 *  end-of-schedule fade, so the file ends in silence rather than mid-ramp. */
export function renderDuration(schedule: Schedule): number {
  const duration = scheduleDuration(schedule);
  return duration > 0 ? duration + CLICK_FREE_RAMP : 0;
}

export function renderFrameCount(schedule: Schedule, sampleRate: number): number {
  return Math.ceil(renderDuration(schedule) * sampleRate);
}

export class RenderCancelledError extends Error {
  constructor() {
    super('Export cancelled.');
    this.name = 'RenderCancelledError';
  }
}

/**
 * Render a schedule to an `AudioBuffer`, faster than realtime.
 *
 * Progress is read from the context's own clock, which the spec advances one render quantum at a
 * time — no simulated animation. An implementation that only publishes `currentTime` at the end
 * simply leaves progress at zero until it completes.
 *
 * Cancelling settles the promise immediately and discards the result. Be clear-eyed about what
 * that means: `startRendering()` cannot be aborted, so the work continues in the background until
 * it finishes; only the download is cancelled.
 */
export async function renderSchedule(
  schedule: Schedule,
  { sampleRate = DEFAULT_EXPORT_SAMPLE_RATE, onProgress, signal, noise }: RenderOptions = {},
): Promise<AudioBuffer> {
  const duration = renderDuration(schedule);
  if (duration <= 0) throw new Error('This program has no audio to export.');
  if (signal?.aborted) throw new RenderCancelledError();

  const context = createContext(renderFrameCount(schedule, sampleRate), sampleRate);
  playSchedule(context, schedule, noise);

  const timer = setInterval(() => {
    onProgress?.(Math.min(1, context.currentTime / duration));
  }, PROGRESS_INTERVAL_MS);

  try {
    const buffer = await Promise.race([rendering(context), cancellation(signal)]);
    onProgress?.(1);
    return buffer;
  } finally {
    clearInterval(timer);
  }
}

function createContext(frames: number, sampleRate: number): OfflineAudioContext {
  try {
    return new OfflineAudioContext(2, frames, sampleRate);
  } catch {
    // The browser refuses the allocation for very long programs — a real limit worth naming
    // rather than reporting as an unexplained failure.
    throw new Error('This program is too long to export at this sample rate. Try a lower one.');
  }
}

async function rendering(context: OfflineAudioContext): Promise<AudioBuffer> {
  try {
    return await context.startRendering();
  } catch {
    throw new Error('Rendering ran out of memory. Try a lower sample rate.');
  }
}

function cancellation(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new RenderCancelledError()), { once: true });
  });
}
