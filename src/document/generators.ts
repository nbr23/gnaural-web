import type { Entry } from './types';

/**
 * §6.1's generators: the shapes an author starts from instead of drawing curves by hand.
 *
 * Pure breakpoint arithmetic and nothing else — these build an `Entry[]`, never a `Schedule`, so the
 * transform that puts one into a document stays in `edit.ts` with the identity invariants. Each
 * shape is written into a **new voice** (the owner's call): a generator is never destructive, and
 * the voice it makes is the same kind of voice `insertVoice` already makes.
 *
 * **Every shape totals exactly the duration it was asked for, return leg included, and that is
 * §3.5 rather than a styling choice.** The last entry glides back to entry[0]'s values whether or
 * not the schedule loops, so a voice is a closed curve: there is no way to ramp somewhere and stay
 * there. A generator therefore has to decide how long the journey home takes, and it says so —
 * `returnSeconds` is a field on the shapes that have one, not a fraction hidden in here. Getting the
 * total exactly right is what keeps a generated voice from making the schedule ragged (§3.7), since
 * the panel defaults the duration to what the schedule already plays.
 *
 * **Values are not clamped** (the owner's call). §6.1's "sensible" 20–1500 Hz band and its 40 Hz
 * beat ceiling are step 7's validation thresholds, and a generated document is subject to them like
 * any other: the Gamma preset lands above the beat ceiling and raises step 7's notice, which is the
 * honest reading — four shipped presets do the same, and a beat there plays exactly as written.
 */

/** A tone, as the panel's two fields give it. */
export interface Tone {
  baseFreq: number;
  beatFreq: number;
}

export type GeneratorSpec =
  /** One entry, a constant hold. The same document Live mode builds, and the band presets' shape. */
  | { kind: 'hold'; tone: Tone; seconds: number }
  /** §6.1's "linear ramp between two bands over a duration", plus the return §3.5 requires. */
  | { kind: 'ramp'; from: Tone; to: Tone; seconds: number; returnSeconds: number }
  /** §6.1's sleep-cycle template: repeated descents into delta with a rise between them. */
  | { kind: 'sleep-cycle'; baseFreq: number; seconds: number }
  /** §6.1's wake-up ramp: delta up into beta, then home. */
  | { kind: 'wake-up'; baseFreq: number; seconds: number; returnSeconds: number };

export type GeneratorKind = GeneratorSpec['kind'];

/**
 * The level a generated node sits at.
 *
 * The same 0.5 `insertVoice` gives a new tone voice, for the reason step 6 recorded: a new voice at
 * full scale on a programme already near it is the clipping case §5.3's null test had to be designed
 * around.
 */
const GENERATED_VOLUME = 0.5;

/** A sleep cycle is about 90 minutes; the template repeats one for as long as it is given. */
export const SLEEP_CYCLE_SECONDS = 90 * 60;

/**
 * One cycle, as fractions of its length paired with the beat frequency reached there.
 *
 * Descend from alpha through theta into delta, stay there, then rise back towards theta for the
 * REM-ish stretch — after which §3.5's wrap carries it back to the alpha this table opens with,
 * which is exactly the next cycle's descent. **So the template needs no return leg**: its last
 * segment is the return, and a single cycle and eight cycles are the same shape repeated.
 */
const SLEEP_CYCLE: readonly { at: number; beatFreq: number }[] = [
  { at: 0, beatFreq: 10 },
  { at: 0.15, beatFreq: 5 },
  { at: 0.3, beatFreq: 2 },
  { at: 0.6, beatFreq: 2 },
  { at: 0.8, beatFreq: 6 },
];

/** Where a wake-up ramp starts and ends: delta, then well into beta. */
const WAKE_UP = { from: 2, to: 18 };

export function generateEntries(spec: GeneratorSpec): Entry[] {
  const seconds = Math.max(0, spec.seconds);
  if (!(seconds > 0)) return [];

  switch (spec.kind) {
    case 'hold':
      return [entry(spec.tone, seconds)];

    case 'ramp': {
      const home = returnLeg(spec.returnSeconds, seconds);
      return [entry(spec.from, seconds - home), entry(spec.to, home)];
    }

    case 'sleep-cycle': {
      const cycles = Math.max(1, Math.round(seconds / SLEEP_CYCLE_SECONDS));
      const length = seconds / cycles;
      const points = Array.from({ length: cycles }, (_unused, cycle) =>
        SLEEP_CYCLE.map((point) => ({
          at: (cycle + point.at) * length,
          tone: { baseFreq: spec.baseFreq, beatFreq: point.beatFreq },
        })),
      ).flat();
      return fromPoints(points, seconds);
    }

    case 'wake-up': {
      const home = returnLeg(spec.returnSeconds, seconds);
      return [
        entry({ baseFreq: spec.baseFreq, beatFreq: WAKE_UP.from }, seconds - home),
        entry({ baseFreq: spec.baseFreq, beatFreq: WAKE_UP.to }, home),
      ];
    }
  }
}

function entry(tone: Tone, duration: number): Entry {
  return {
    duration,
    baseFreq: tone.baseFreq,
    beatFreq: tone.beatFreq,
    volumeLeft: GENERATED_VOLUME,
    volumeRight: GENERATED_VOLUME,
    preserved: {},
  };
}

/**
 * How long the journey home gets, kept inside the shape's own length.
 *
 * A return of zero would give the final entry a zero duration, which §3.5 then reads as an instant
 * jump back to the opening values at the very end — so it is floored at a sliver rather than
 * allowed, and it can never eat the whole shape.
 */
function returnLeg(requested: number, seconds: number): number {
  const wanted = Number.isFinite(requested) ? requested : 0;
  return Math.min(Math.max(wanted, seconds / 1000), seconds);
}

/** Breakpoints at absolute times into entries, with the last one closing the shape at `seconds`. */
function fromPoints(points: { at: number; tone: Tone }[], seconds: number): Entry[] {
  return points.map((point, index) => {
    const next = points[index + 1]?.at ?? seconds;
    return entry(point.tone, next - point.at);
  });
}
