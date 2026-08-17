import type { Entry } from './types';

/**
 * Generators: the shapes an author starts from instead of drawing curves by hand. Pure breakpoint
 * arithmetic that builds an `Entry[]`, never a `Schedule` — always written into a new voice by
 * `edit.ts`. Every shape totals exactly the duration it was asked for, return leg included, since a
 * voice is a closed curve with no way to ramp somewhere and stay there. Values are not clamped —
 * they're subject to the same validation thresholds as any other entry.
 */

/** A tone, as the panel's two fields give it. */
export interface Tone {
  baseFreq: number;
  beatFreq: number;
}

export type GeneratorSpec =
  /** One entry, a constant hold. */
  | { kind: 'hold'; tone: Tone; seconds: number }
  /** Linear ramp between two bands over a duration, plus the return leg a closed curve requires. */
  | { kind: 'ramp'; from: Tone; to: Tone; seconds: number; returnSeconds: number }
  /** Sleep-cycle template: repeated descents into delta with a rise between them. */
  | { kind: 'sleep-cycle'; baseFreq: number; seconds: number }
  /** Wake-up ramp: delta up into beta, then home. */
  | { kind: 'wake-up'; baseFreq: number; seconds: number; returnSeconds: number };

export type GeneratorKind = GeneratorSpec['kind'];

/** The level a generated node sits at — the same 0.5 `insertVoice` gives a new tone voice. */
const GENERATED_VOLUME = 0.5;

/** A sleep cycle is about 90 minutes; the template repeats one for as long as it is given. */
export const SLEEP_CYCLE_SECONDS = 90 * 60;

/**
 * One cycle, as fractions of its length paired with the beat frequency reached there: descend from
 * alpha through theta into delta, stay there, then rise back towards theta for the REM-ish stretch.
 * The wrap back to entry[0] carries it back to alpha, which is the next cycle's descent — so the
 * template needs no explicit return leg.
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
 * How long the journey home gets, kept inside the shape's own length. A return of zero would give
 * the final entry a zero duration — an instant jump back to the opening values — so it's floored at
 * a sliver.
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
