/**
 * The pulse gate behind voice types 3 and 4 (§3.3 — `BB_VOICETYPE_ISOPULSE` and its `_ALT`
 * variant), replicated from `BB_MainLoop` (BinauralBeat.c:569-614 per entry, :744-808 per sample).
 *
 * **An isochronic voice is a gated tone, not a beating pair.** The reference sets both channels to
 * the same carrier — `cur_beatfreqR_factor = cur_beatfreqL_factor = cur_basefreq * BB_SAMPLE_FACTOR`
 * (:598) with `sinPosR = sinPosL` (:757) — so §3.6's left-is-higher split does not happen here at
 * all. Its own comment says so: *"in isochronic tones, the beat frequency purely affects base
 * frequency pulse on/off duration, not its frequency"*. `beatfreq` is the **rate at which that one
 * tone is switched on and off**, and `basefreq` is the tone.
 *
 * The gate itself is a **50% duty square**: `cur_beatfreq_phasesamplecount_start` is
 * `sampleRate / 2 / beatfreq` (:609), counted down per sample, and the polarity flag flips every
 * time it runs out — so the on and off halves are equal by construction. Its edges are a
 * hundred-sample linear ramp (`cur_beatfreq_phaseenvelope += .01`, clamped at 1, :805), which the
 * reference describes as a modulator "to reduce harmonics in transition between on and off pulses":
 * an anti-click measure, and one whose duration depends on the sample rate (2.27 ms at 44.1 kHz,
 * 2.08 ms at 48 kHz) rather than on anything musical.
 *
 * Here that shape is made by running an oscillator at `beatfreq` through a `WaveShaperNode` whose
 * curve is a steep clamped line, and using the result as an audio-rate signal into a gain node —
 * which is what keeps §4.2's rule intact. **No JS timer touches audio and nothing is scheduled per
 * pulse.** The alternative, scheduling every pulse edge as automation, is ~48,000 param events for a
 * twenty-minute 10 Hz voice per pass, against the 132,480 events that already cost 68 ms per
 * `update()` and forced the editing horizon to exist.
 */

/**
 * Steepness of the clamped line the cosine is shaped through.
 *
 * Near a zero crossing a cosine is linear in time, so the shaped edge is a linear ramp like the
 * reference's, of duration `1 / (pi * k * f)` — measured against `node-web-audio-api` and matching
 * that formula to two decimal places at every rate from 0.5 Hz to 70 Hz. **14 puts the edge at
 * 2.27 ms at a 10 Hz beat, which is exactly the reference's 100 samples at 44.1 kHz.**
 *
 * **Stated deviation:** Gnaural holds the edge at 2.27 ms whatever the beat rate; this holds it at a
 * constant fraction of the period instead (5.7 ms at 4 Hz, 0.57 ms at 40 Hz). A fixed-time edge
 * needs a filter after the shaper, which costs a node per voice, adds group delay and overshoot
 * above 1, and smears the pulse at 70 Hz where the reference is already near-triangular. The duty
 * cycle — the part that decides what is heard — is 50% either way.
 */
export const GATE_STEEPNESS = 14;

/**
 * Floor on the gate oscillator's frequency, matching the reference's own clamp (:592).
 *
 * `beatfreq = 0` is legitimate and means **a steady tone**, not silence: Gnaural's polarity flag
 * simply never flips. With `cosineGateWave` the gate starts saturated at 1 and stays there for
 * hours at this frequency, which reproduces that exactly.
 */
export const MIN_GATE_FREQ = 1e-4;

/** Points in the shaping curve. Ample: the curve is a clamped line, so its only detail is the
 *  segment near zero, which this resolves to ~1/1000 of the input range. **Odd**, so that one
 *  sample sits exactly on zero and the curve is symmetric sample-for-sample rather than only in
 *  the limit — which is what makes the duty cycle exactly 50%. */
const GATE_CURVE_POINTS = 2049;

/**
 * The `WaveShaperNode` curve that turns the gate oscillator into a 0..1 gate.
 *
 * `y = clamp((k*x + 1) / 2, 0, 1)`, or its complement for the right channel of a type-4 voice,
 * where the reference multiplies one channel by the envelope and the other by `1 - envelope`
 * (:788-801) so the pulse alternates between the ears.
 *
 * **The shaper's `oversample` is left at its default of `'none'`, and that is a decision.** The
 * obvious reach for a shaper is `'4x'`, to keep the shaped harmonics from aliasing; measured
 * against `node-web-audio-api`, it instead smears the edge to **26 ms at 10 Hz regardless of this
 * curve** — its resampling filter, not the shaping — which would leave the test runtime and a
 * browser disagreeing about the gate's shape. There is nothing to alias anyway: an edge this soft
 * puts the harmonics far below Nyquist.
 */
export function gateCurve(inverted = false): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(GATE_CURVE_POINTS);
  for (let i = 0; i < GATE_CURVE_POINTS; i++) {
    const x = (i / (GATE_CURVE_POINTS - 1)) * 2 - 1;
    const gate = Math.min(1, Math.max(0, (GATE_STEEPNESS * x + 1) / 2));
    curve[i] = inverted ? 1 - gate : gate;
  }
  return curve;
}

/**
 * A cosine, as a `PeriodicWave` — the gate oscillator's waveform.
 *
 * A plain `'sine'` starts at phase zero and would leave the gate half open at `MIN_GATE_FREQ`,
 * where a cosine sits at 1: that is the whole reason for it, since `beatfreq = 0` has to be a fully
 * sounding tone. Nothing else depends on the gate's absolute phase — one pulse train is the same as
 * another shifted — and `disableNormalization` keeps the amplitude at exactly 1 so the curve's
 * clamp points mean what they say.
 */
export function cosineGateWave(context: BaseAudioContext): PeriodicWave {
  return context.createPeriodicWave(new Float32Array([0, 1]), new Float32Array([0, 0]), {
    disableNormalization: true,
  });
}

/** How long the gate takes to cross between fully off and fully on, at a given rate. Derived from
 *  the cosine's slope at its zero crossing; used by the tests and by the comments above. */
export function gateEdgeSeconds(beatFreq: number): number {
  return 1 / (Math.PI * GATE_STEEPNESS * Math.max(MIN_GATE_FREQ, beatFreq));
}
