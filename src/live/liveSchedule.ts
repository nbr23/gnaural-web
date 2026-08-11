import { formatHz } from '../app/format';
import type { Schedule } from '../document/types';
import { VoiceType } from '../document/types';

/**
 * The document behind Live mode (PLAN.md §6.1): one voice, one entry, rebuilt from the sliders.
 *
 * **One entry is a complete program**, not a degenerate one. §3.5's wrap is unconditional — the
 * last entry ramps back to entry[0] whether or not the schedule loops — so a single entry ramps to
 * itself and the voice is a constant hold. The reference agrees at the source level:
 * `BB_CalibrateVoice` (BinauralBeat.c:305) wraps `nextEntry` to 0, making every `*_spread` exactly
 * zero, and Gnaural's own editor guards on `TotalDataPoints < 1` (ScheduleGUI.c:2182) — one point
 * is accepted, zero is what is rejected. So a file this produces reopens in Gnaural desktop.
 *
 * Nothing here knows about audio or React: the builder is pure, which is what lets the same
 * function feed the readout, the engine and the serializer.
 */

/**
 * How long the live entry lasts, and therefore how long a live session can run.
 *
 * **Twelve hours in a single pass, deliberately, and this is not a cosmetic default.**
 * `rescheduleFrom` schedules every remaining pass up front, so a repeating live schedule pays for
 * its whole future on every `update()`: a 60-second entry with `loops <= 0` is 720 passes and
 * ~1440 param events per call, ten times a second under a drag. One pass is ~20 events, whatever
 * the session's length.
 *
 * A single pass buys two more things. There is no seam at all, so §3.5's wrap is a flat ramp from
 * a value to itself and there is nothing to hear at any join. And `getCurrentOffset()` reports the
 * offset *within the pass*, so a looping live schedule would reset its elapsed clock every pass —
 * a session that reads 0:04 after an hour and four minutes.
 *
 * Twelve hours outruns any real sitting, and reaching it ends playback the ordinary way, through
 * `scheduleEnding`'s fade and `hasEnded()`. A stated limit, not a silent truncation.
 */
export const LIVE_SESSION_SECONDS = 12 * 60 * 60;

export interface Range {
  min: number;
  max: number;
  /** Values are rounded to this, so what is displayed, stored and heard are the same number. */
  step: number;
}

/**
 * Not §6.1's 20–1500 Hz: that is the *validation* boundary, the point at which the editor should
 * start warning, rather than a range a thumb should be able to reach. 20 Hz is below what any
 * phone or headphone reproduces and the beat percept degrades badly above ~1000 Hz of carrier.
 * 40–800 covers the whole bundled corpus (104–658 Hz) with headroom at both ends.
 */
export const BASE_RANGE: Range = { min: 40, max: 800, step: 0.1 };

/** The top **is** §6.1's number — "above ~40 Hz the effect breaks down" — so Live mode cannot
 *  produce a document that step 8's validation pass would warn about. */
export const BEAT_RANGE: Range = { min: 0.5, max: 40, step: 0.01 };

export interface LiveValues {
  baseFreq: number;
  beatFreq: number;
}

/** Mid-slider, in alpha (§1: relaxed wakefulness) — awake, and a safe first impression. */
export const DEFAULT_LIVE_VALUES: LiveValues = { baseFreq: 200, beatFreq: 10 };

export function clampTo(range: Range, value: number): number {
  if (!Number.isFinite(value)) return range.min;
  const clamped = Math.min(range.max, Math.max(range.min, value));
  return Math.round(clamped / range.step) * range.step;
}

export function clampValues(values: LiveValues): LiveValues {
  return {
    baseFreq: clampTo(BASE_RANGE, values.baseFreq),
    beatFreq: clampTo(BEAT_RANGE, values.beatFreq),
  };
}

/** A factual line, not a claim about what the audio does (§2). Used as the voice's description,
 *  and as the default description of a program kept from a live session. */
export function describeLive(values: LiveValues): string {
  return `${formatHz(values.beatFreq)} Hz beat at ${formatHz(values.baseFreq)} Hz base`;
}

export interface LiveScheduleOptions {
  title?: string;
  description?: string;
  /** Defaults to the 12-hour session container; a kept program passes its own chosen length. */
  durationSeconds?: number;
}

/**
 * Build the one-entry schedule the sliders describe.
 *
 * Volumes are pinned at 1.0: a document is authored at unity and the listener's own level is the
 * app's master gain, which is not the document's business. That is also what makes a kept program
 * export at the same level as any other file.
 */
export function buildLiveSchedule(values: LiveValues, options: LiveScheduleOptions = {}): Schedule {
  const clamped = clampValues(values);
  const description = options.description ?? describeLive(clamped);

  return {
    title: options.title ?? 'Live',
    description,
    // Left blank on purpose: the app is not the author of what someone dialled in, and an imported
    // card falls back to the source name for its credit.
    author: '',
    loops: 1,
    masterVolume: { left: 1, right: 1 },
    stereoSwap: false,
    voices: [
      {
        id: 0,
        description,
        type: VoiceType.Binaural,
        muted: false,
        hidden: false,
        mono: false,
        entries: [
          {
            duration: options.durationSeconds ?? LIVE_SESSION_SECONDS,
            baseFreq: clamped.baseFreq,
            beatFreq: clamped.beatFreq,
            volumeLeft: 1,
            volumeRight: 1,
            preserved: {},
          },
        ],
        preserved: {},
      },
    ],
    preserved: {},
  };
}
