import { scheduleDuration } from '../document/timing';
import type { Schedule, Voice } from '../document/types';
import { VoiceType } from '../document/types';
import type { AutomationEvent, AutomationValues } from './compiler';
import { compileVoice, valueAtTime } from './compiler';
import type { NoiseColour } from './noise';
import { LAYER_NOISE_SEEDS, createLayerNoiseBuffer, createNoiseBuffer, noiseSeeds } from './noise';

/** Anti-click gain ramp duration (PLAN.md §4.4 — ~20ms, applied on every transport transition). */
export const CLICK_FREE_RAMP = 0.02;

/**
 * `latencyHint` for the playback context.
 *
 * The default, `'interactive'`, asks for the **smallest** buffer the device can manage — the right
 * choice for a synthesiser you play with your hands, and the wrong one for this. Nothing here
 * responds to input in real time, and a small buffer underruns the moment the phone is busy:
 * scrolling, waking, or dropping the CPU clock with the screen off. Every underrun is a crackle.
 *
 * `'playback'` asks for a large one, trading response latency nobody can perceive here for a
 * buffer deep enough to ride out a stall. `scheduleLookahead` reads `baseLatency`, so it grows to
 * match automatically.
 */
const PLAYBACK_LATENCY_HINT: AudioContextLatencyCategory = 'playback';

/** Floor for `scheduleLookahead`, comfortably past any real device's render-ahead buffer. */
const MIN_LOOKAHEAD = 0.05;

/**
 * How far ahead an endlessly-looping schedule is scheduled (§3.2 — `loops` of 0 or less repeats
 * forever, because Gnaural decrements a counter and stops only when it hits exactly zero).
 *
 * "Forever" cannot be handed to the audio thread, and §4.2 rules out the usual answer: no chunked
 * look-ahead scheduler, because a JS timer topping up automation is exactly what gets throttled
 * with the screen off. So an endless schedule is scheduled to a bound and then ends normally.
 * Twelve hours outruns any real session — the longest bundled programme is under three — so the
 * bound is a deliberate limit rather than a silent truncation.
 */
const LOOP_HORIZON_SECONDS = 12 * 60 * 60;

/** Second bound on the same thing, for a schedule short enough that the horizon alone would
 *  schedule an absurd number of passes. */
const MAX_LOOP_PASSES = 1000;

/**
 * How many times the schedule plays through (§3.2).
 *
 * `loops` counts passes, so 1 plays once. Zero and negatives repeat forever and are bounded here.
 */
function passCount(schedule: Schedule, duration: number): number {
  if (duration <= 0) return 1;
  const declared = Math.floor(schedule.loops);
  if (declared > 0) return declared;
  return Math.max(1, Math.min(MAX_LOOP_PASSES, Math.ceil(LOOP_HORIZON_SECONDS / duration)));
}

/**
 * How far ahead of `currentTime` a transport transition is scheduled.
 *
 * **Without this the anti-click ramp is not a ramp.** `currentTime` is where the audio thread has
 * rendered to, and it renders a whole buffer ahead; a param event scheduled inside that buffer is
 * in the past by the time it is seen, and the spec says such an event takes effect immediately.
 * The 20 ms ramp then collapses into a step, which on a live sine is precisely the click §4.4
 * exists to prevent. Desktop Chrome buffers ~3 ms and got away with it. Android buffers ten times
 * that, which is why play, pause and seek all clicked there and nowhere else.
 *
 * Zero for an `OfflineAudioContext`: rendering is on demand, `currentTime` is exactly where it has
 * reached, nothing is in flight, and a lookahead would only push silence into an export. That is
 * also what keeps the §5.3 null test comparing like with like.
 */
function scheduleLookahead(context: BaseAudioContext): number {
  const buffered = (context as AudioContext).baseLatency;
  if (typeof buffered !== 'number') return 0;
  // Chrome on Android reports 0 here, so in practice the floor is what applies on the target
  // platform and the scaling term only ever helps a desktop that reports honestly.
  return Math.max(MIN_LOOKAHEAD, buffered * 3);
}

interface OutputChain {
  /** Bus a voice's left-channel signal feeds, carrying `overallvolume_left` (§3.2). */
  left: GainNode;
  right: GainNode;
  /** The `stereoSwap` routing matrix — see `buildOutputChain`. */
  route: { ll: GainNode; lr: GainNode; rl: GainNode; rr: GainNode };
  /** App-level master, independent of the file's `overallvolume_*`. */
  masterGain: GainNode;
}

/**
 * Per-channel master gain (§3.2 — `overallvolume_left`/`_right` apply once, after all voices are
 * summed) into a `ChannelMergerNode`, then the app's own master gain, then the destination.
 *
 * `stereoSwap` is applied *after* `overallvolume_*` — §3.2: the left master gain follows the audio
 * into the right output, so asymmetric master volumes plus a swap do not behave like a naive swap.
 *
 * It is a **four-gain routing matrix rather than a choice of merger input**, so that swapping is a
 * parameter change instead of a rewiring. `update()` must never tear the output chain down (an
 * edit is not a new program), and reconnecting a live node is both a click and a node the graph
 * keeps a reference to. With the gains at exactly 1 and 0 the matrix is arithmetically transparent
 * — `x * 1 + 0` — so an offline export renders the same samples it always did, which is what keeps
 * §5.3's null test comparing like with like.
 */
function buildOutputChain(context: BaseAudioContext, schedule: Schedule): OutputChain {
  const left = context.createGain();
  const right = context.createGain();
  left.gain.value = schedule.masterVolume.left;
  right.gain.value = schedule.masterVolume.right;

  const merger = context.createChannelMerger(2);
  const route = {
    ll: context.createGain(),
    lr: context.createGain(),
    rl: context.createGain(),
    rr: context.createGain(),
  };
  left.connect(route.ll).connect(merger, 0, 0);
  left.connect(route.lr).connect(merger, 0, 1);
  right.connect(route.rl).connect(merger, 0, 0);
  right.connect(route.rr).connect(merger, 0, 1);

  const masterGain = context.createGain();
  merger.connect(masterGain).connect(context.destination);

  const output = { left, right, route, masterGain };
  setStereoSwap(output, schedule.stereoSwap);
  return output;
}

/**
 * Point each channel at its output (§3.2). Called with `at` to ramp instead of step, which is what
 * an edit to `stereoswap` during playback needs; called without one at build time, where the gains
 * must land on exactly 1 and 0 for the matrix to stay arithmetically transparent.
 */
function setStereoSwap(output: OutputChain, swapped: boolean, at?: number): void {
  const straight = swapped ? 0 : 1;
  const crossed = swapped ? 1 : 0;
  const targets: [AudioParam, number][] = [
    [output.route.ll.gain, straight],
    [output.route.rr.gain, straight],
    [output.route.lr.gain, crossed],
    [output.route.rl.gain, crossed],
  ];

  for (const [param, value] of targets) {
    if (at === undefined) param.value = value;
    else rampParam(param, value, at);
  }
}

/** Glide a param that is not otherwise automated to a new value, click-free (§4.4). */
function rampParam(param: AudioParam, value: number, at: number): void {
  if (param.value === value) return;
  param.cancelScheduledValues(at);
  param.setValueAtTime(param.value, at);
  param.linearRampToValueAtTime(value, at + CLICK_FREE_RAMP);
}

/** The app-level noise layer's settings (§4.5b), app state rather than document state. */
export interface NoiseLayerSettings {
  colour: NoiseColour;
  /**
   * 0–1, on the same scale a voice's `volume_*` uses: at 0.3 the bed is as loud as a file's own
   * type-1 voice at volume 0.3.
   *
   * **Zero by default, and nothing turns it on but a person.** §3.8 item 6 is the Android
   * importer forcing white noise onto every segment at a hardcoded gain regardless of file
   * content; this is that feature with the defect removed, and the difference is the default.
   */
  gain: number;
}

export const SILENT_NOISE_LAYER: NoiseLayerSettings = { colour: 'gnaural', gain: 0 };

interface NoiseLayer {
  colour: NoiseColour;
  buffers: [AudioBuffer, AudioBuffer];
  merger: ChannelMergerNode;
  gain: GainNode;
  nodes: AudioBufferSourceNode[];
}

/**
 * The app's own noise bed (§4.5b), mixed **into the app's master gain and nothing else**.
 *
 * That placement is the whole design. §4.5b says "before the master gain", and the only master
 * gain that is the app's to use is `output.masterGain` — the file's `overallvolume_*` and its
 * `stereoswap` both belong to the document, and applying them to a layer the document does not
 * contain would make the app's preference follow the program's mixing decisions. So a schedule
 * with a swap, or with silence in one channel, hears exactly the same bed as any other; only the
 * volume slider, which is the app's own, moves it.
 *
 * Its two channels come from independent streams, per §4.5's decorrelation, merged back to stereo
 * so a single gain node carries the level.
 */
function buildNoiseLayer(context: BaseAudioContext, output: OutputChain, colour: NoiseColour): NoiseLayer {
  const [seedL, seedR] = LAYER_NOISE_SEEDS;
  const merger = context.createChannelMerger(2);
  const gain = context.createGain();
  gain.gain.value = 0; // faded in by the caller, so switching it on is not a step

  merger.connect(gain).connect(output.masterGain);
  return {
    colour,
    buffers: [
      createLayerNoiseBuffer(context, seedL, colour),
      createLayerNoiseBuffer(context, seedR, colour),
    ],
    merger,
    gain,
    nodes: [],
  };
}

/**
 * Start the layer's buffer sources, positioned by schedule time for the same reason a noise
 * voice's are: `AudioBufferSourceNode`s are single-use, so every transport transition replaces
 * them, and seeking into the buffer keeps the bed a function of where playback is rather than of
 * how many times it has been started.
 */
function startNoiseLayer(context: BaseAudioContext, layer: NoiseLayer, at: number, offset: number): void {
  stopNoiseLayer(layer, at);
  layer.nodes = layer.buffers.map((buffer, channel) => {
    const node = context.createBufferSource();
    node.buffer = buffer;
    node.loop = true;
    node.connect(layer.merger, 0, channel);
    node.start(at, offset % buffer.duration);
    return node;
  });
}

function stopNoiseLayer(layer: NoiseLayer, when: number): void {
  for (const node of layer.nodes) node.stop(when);
  layer.nodes = [];
}

/**
 * What actually makes a voice's sound, by voice type (§3.3).
 *
 * A binaural voice's oscillator pair lives for the whole session (§4.4 — an `OscillatorNode`
 * cannot be restarted after `stop()`), so `started` records whether it is running yet. A noise
 * voice's `AudioBufferSourceNode`s are single-use by spec and so are recreated on every
 * transport transition; the buffers behind them are generated once.
 */
type VoiceSource =
  | { kind: 'binaural'; oscL: OscillatorNode; oscR: OscillatorNode; started: boolean }
  | {
      kind: 'noise';
      buffers: [AudioBuffer, AudioBuffer];
      /** Where each channel's source connects — the per-channel gains, or the mono downmix. */
      inputs: [AudioNode, AudioNode];
      nodes: AudioBufferSourceNode[];
    };

interface VoiceNodes {
  source: VoiceSource;
  gainL: GainNode;
  gainR: GainNode;
  /**
   * Audibility gates, one per channel — kept separate from the automated gains so muting never
   * fights the compiled curve, and per-channel because a single shared node would sum L and R
   * back together.
   */
  muteL: GainNode;
  muteR: GainNode;
}

/**
 * One source pair per voice, each channel through its own gain and mute gate, into the output
 * chain. Only the source differs by voice type — the volume envelope, mono downmix, mute gate,
 * master volume and stereo swap downstream of it are shared, matching the reference, which
 * applies all of them after its voice-type switch (`BinauralBeat.c:834`).
 *
 * `voice_mono` (§3.2) routes both channels through a single 0.5 gain first, so each carries
 * `(L+R)/2` before `volume_left`/`volume_right` are applied to it independently. It is a
 * downmix of the voice's own content, not a pan — the per-channel volumes still apply afterwards.
 */
function buildVoiceNodes(
  context: BaseAudioContext,
  voice: Voice,
  index: number,
  output: OutputChain,
): VoiceNodes {
  const gainL = context.createGain();
  const gainR = context.createGain();
  const muteL = context.createGain();
  const muteR = context.createGain();

  let inputs: [AudioNode, AudioNode] = [gainL, gainR];
  if (voice.mono) {
    const downmix = context.createGain();
    downmix.gain.value = 0.5;
    downmix.connect(gainL);
    downmix.connect(gainR);
    inputs = [downmix, downmix];
  }

  gainL.connect(muteL).connect(output.left);
  gainR.connect(muteR).connect(output.right);

  return { source: buildVoiceSource(context, voice, index, inputs), gainL, gainR, muteL, muteR };
}

function buildVoiceSource(
  context: BaseAudioContext,
  voice: Voice,
  index: number,
  inputs: [AudioNode, AudioNode],
): VoiceSource {
  if (voice.type === VoiceType.PinkNoise) {
    const [seedL, seedR] = noiseSeeds(index);
    return {
      kind: 'noise',
      buffers: [createNoiseBuffer(context, seedL), createNoiseBuffer(context, seedR)],
      inputs,
      nodes: [],
    };
  }

  const oscL = context.createOscillator();
  const oscR = context.createOscillator();
  oscL.connect(inputs[0]);
  oscR.connect(inputs[1]);
  return { kind: 'binaural', oscL, oscR, started: false };
}

/**
 * Start (or restart) a voice's sound, where context time `t0` carries schedule-time zero and the
 * voice is to be heard from schedule-time `offset`.
 *
 * Oscillators start once and run for the session (§4.4), at `t0` so that their phase is anchored
 * to schedule-time zero — which is what lets an offline export be compared sample-for-sample
 * against live playback (§5.3). Noise sources are single-use, so each call replaces them, seeking
 * the looping buffer to `offset`: a voice's noise is therefore a function of schedule time, and a
 * seek hears the same noise as playing straight through to that point.
 */
function startSource(context: BaseAudioContext, source: VoiceSource, t0: number, offset: number): void {
  const now = context.currentTime;

  if (source.kind === 'binaural') {
    if (source.started) return;
    // Clamped because seeking into a schedule puts schedule-time zero in the past; only the
    // play-from-the-start case can align phase exactly, and only that case needs to.
    const at = Math.max(now, t0);
    source.oscL.start(at);
    source.oscR.start(at);
    source.started = true;
    return;
  }

  const at = t0 + offset;
  stopNoise(source, at);
  source.nodes = source.buffers.map((buffer, channel) => {
    const node = context.createBufferSource();
    node.buffer = buffer;
    node.loop = true;
    node.connect(source.inputs[channel]);
    node.start(at, offset % buffer.duration);
    return node;
  });
}

/** Stop a noise voice's buffer sources; a no-op for oscillators, which outlive every transition. */
function stopNoise(source: VoiceSource, when: number): void {
  if (source.kind !== 'noise') return;
  for (const node of source.nodes) node.stop(when);
  source.nodes = [];
}

function disposeSource(source: VoiceSource, when: number): void {
  if (source.kind === 'noise') {
    stopNoise(source, when);
    return;
  }
  if (!source.started) return;
  source.oscL.stop(when);
  source.oscR.stop(when);
  source.started = false;
}

/** Anchor a binaural voice's frequencies; noise ignores beat and base entirely
 *  (`BinauralBeat.c:553`). */
function anchorFrequency(source: VoiceSource, values: AutomationValues, at: number): void {
  if (source.kind !== 'binaural') return;
  source.oscL.frequency.setValueAtTime(values.leftFreq, at);
  source.oscR.frequency.setValueAtTime(values.rightFreq, at);
}

function rampFrequency(source: VoiceSource, values: AutomationValues, at: number): void {
  if (source.kind !== 'binaural') return;
  source.oscL.frequency.linearRampToValueAtTime(values.leftFreq, at);
  source.oscR.frequency.linearRampToValueAtTime(values.rightFreq, at);
}

function cancelFrequency(source: VoiceSource, from: number): void {
  if (source.kind !== 'binaural') return;
  source.oscL.frequency.cancelScheduledValues(from);
  source.oscR.frequency.cancelScheduledValues(from);
}

function setGate(nodes: VoiceNodes, gate: number): void {
  nodes.muteL.gain.value = gate;
  nodes.muteR.gain.value = gate;
}

/**
 * Anchor at `t0` with the first event via `setValueAtTime` — a ramp always interpolates from
 * whatever value the param already holds, so without an explicit anchor the first ramp would
 * start from the node's default rather than the voice's first entry (PLAN.md §4.2).
 */
function scheduleVoice(events: AutomationEvent[], t0: number, endOffset: number, nodes: VoiceNodes): void {
  if (events.length === 0) return;

  const [first, ...rest] = events;
  anchorFrequency(nodes.source, first, t0);
  nodes.gainL.gain.setValueAtTime(first.leftGain, t0);
  nodes.gainR.gain.setValueAtTime(first.rightGain, t0);

  for (const event of rest) {
    if (event.time > endOffset) break;
    rampFrequency(nodes.source, event, t0 + event.time);
    nodes.gainL.gain.linearRampToValueAtTime(event.leftGain, t0 + event.time);
    nodes.gainR.gain.linearRampToValueAtTime(event.rightGain, t0 + event.time);
  }

  scheduleEnding(events, t0, endOffset, nodes);
}

/**
 * Silence a voice where the schedule ends (§3.7 — the shortest voice ends it for every voice).
 *
 * Without this a Web Audio param holds its last scheduled value indefinitely, so a finished
 * program would drone on forever at entry[0]'s frequency. The fade is `CLICK_FREE_RAMP` long for
 * the usual reason (§4.4).
 *
 * A voice longer than the schedule has no breakpoint at the end, so its true value there is
 * anchored first; a voice that ends exactly with the schedule already has one, and adding a
 * second event at the same instant is avoided.
 */
function scheduleEnding(events: AutomationEvent[], t0: number, endOffset: number, nodes: VoiceNodes): void {
  const lastScheduled = events.reduce((last, e) => (e.time <= endOffset ? e.time : last), 0);

  if (endOffset > lastScheduled) {
    const atEnd = valueAtTime(events, endOffset);
    nodes.gainL.gain.linearRampToValueAtTime(atEnd.leftGain, t0 + endOffset);
    nodes.gainR.gain.linearRampToValueAtTime(atEnd.rightGain, t0 + endOffset);
  }

  nodes.gainL.gain.linearRampToValueAtTime(0, t0 + endOffset + CLICK_FREE_RAMP);
  nodes.gainR.gain.linearRampToValueAtTime(0, t0 + endOffset + CLICK_FREE_RAMP);
}

/**
 * The transition from one pass of the schedule to the next, for a voice that is *longer* than the
 * schedule.
 *
 * Only such a voice needs one. §3.5's unconditional wrap means a voice's automation already ends
 * at entry[0]'s values, so for a voice as long as the schedule the last segment glides back to
 * exactly where the next pass starts and the seam is continuous with nothing scheduled at all.
 *
 * A longer voice is a different matter: §3.7 says the shortest voice ends the schedule and resets
 * every voice, so this one is cut off partway through its curve and restarted from entry[0].
 * Gnaural steps there. **Deviation, deliberate:** the gain is ramped over `CLICK_FREE_RAMP`
 * instead, for the reason §4.4 gives for every other transition — a step on a live sine is a
 * click. Frequency snaps, which carries no such risk.
 */
function scheduleSeam(events: AutomationEvent[], atSeam: number, duration: number, nodes: VoiceNodes): void {
  const before = valueAtTime(events, duration);
  const after = events[0];

  anchorFrequency(nodes.source, after, atSeam);
  nodes.gainL.gain.setValueAtTime(before.leftGain, atSeam);
  nodes.gainR.gain.setValueAtTime(before.rightGain, atSeam);
  nodes.gainL.gain.linearRampToValueAtTime(after.leftGain, atSeam + CLICK_FREE_RAMP);
  nodes.gainR.gain.linearRampToValueAtTime(after.rightGain, atSeam + CLICK_FREE_RAMP);
}

/** Whether §3.7 cuts this voice short — it outlasts the schedule, so a loop restarts it mid-curve. */
function outlastsSchedule(events: AutomationEvent[], duration: number): boolean {
  const end = events[events.length - 1]?.time ?? 0;
  return end > duration + 1e-9;
}

/** Voices this app can render. Other types are parsed and preserved, but silent (§3.3). */
function isRenderable(voice: Voice): boolean {
  return voice.type === VoiceType.Binaural || voice.type === VoiceType.PinkNoise;
}

/**
 * Whether an edit changes the *shape* of the voice graph rather than the values flowing through it.
 *
 * Only three things do: how many voices there are, what kind of source each one needs (`type`), and
 * whether it is downmixed (`mono`) — the one flag that changes a voice's wiring rather than a
 * param. Everything else an editor can touch — every entry, every volume, the master volumes,
 * `stereoswap`, mute flags — is a value, and values are what `rescheduleFrom` already rewrites. So
 * the common editing case, dragging a breakpoint, never rebuilds a node.
 */
function requiresVoiceRebuild(previous: Schedule, next: Schedule): boolean {
  if (previous.voices.length !== next.voices.length) return true;
  return next.voices.some(
    (voice, index) => voice.type !== previous.voices[index].type || voice.mono !== previous.voices[index].mono,
  );
}

/**
 * Build the full audio graph for a schedule and start playback immediately at
 * `context.currentTime`: one persistent source pair per renderable voice (§4.4 — oscillators are
 * reused for the whole session, never stopped/restarted per segment), summed through per-channel
 * master gain into `context.destination`.
 *
 * Works with any `BaseAudioContext` — a real `AudioContext` for playback, or an
 * `OfflineAudioContext` for deterministic sample-level testing and for WAV export
 * (`renderSchedule`), which is why this shares `buildOutputChain`/`buildVoiceNodes` with
 * `PlaybackEngine` instead of building a graph of its own.
 *
 * Voice types 0 (binaural) and 1 (noise) are rendered. Types 2–6 are parsed and preserved by the
 * document layer but silent here (§3.3), and `VoiceList`/`WarningList` say so.
 *
 * **Exactly one pass, whatever `loops` says.** This is the export path (`renderSchedule`), and a
 * WAV of a schedule that repeats forever is not a file anyone can write. Repetition is a playback
 * behaviour, so it lives in `PlaybackEngine`; keeping it out of here is also what lets §5.3's null
 * test compare the two paths over the same stretch of audio.
 */
export function playSchedule(context: BaseAudioContext, schedule: Schedule): void {
  const output = buildOutputChain(context, schedule);
  const t0 = context.currentTime;
  const endOffset = scheduleDuration(schedule);

  schedule.voices.forEach((voice, index) => {
    if (!isRenderable(voice)) return;

    const nodes = buildVoiceNodes(context, voice, index, output);
    // The document's own mute flag applies here, so an offline export matches live playback.
    setGate(nodes, voice.muted ? 0 : 1);
    scheduleVoice(compileVoice(voice), t0, endOffset, nodes);
    startSource(context, nodes.source, t0, 0);
  });
}

interface VoiceState {
  /** Index into `schedule.voices` — the stable key, since real files reuse voice ids (§3.4). */
  index: number;
  events: AutomationEvent[];
  nodes: VoiceNodes;
}

/**
 * Interactive playback session: play, pause, seek, and stop for a single loaded schedule, all
 * implemented as one primitive (`rescheduleFrom`) per PLAN.md §4.3 — "Implement seek as the only
 * primitive; play() is rescheduleFrom(0) and resume is rescheduleFrom(pausedAt)." Here, `play()`
 * folds both cases into one call: it always resumes from wherever playback last stopped
 * (`frozenOffset`, which is 0 right after `load()`), so a dedicated `resume()` isn't needed.
 *
 * `AudioContext` is created lazily on the first `play()`, which must happen inside a
 * user-gesture handler (§4.4), then reused for the session's lifetime. Oscillators are created
 * once per loaded schedule and never stopped/restarted between transport actions (§4.4) —
 * audibility is controlled entirely by gain automation. A noise voice is the one exception the
 * API forces: `AudioBufferSourceNode`s are single-use, so they are rebuilt on each transition and
 * positioned by schedule time (see `startSource`).
 *
 * Every transition (play, pause, seek, stop) ramps gain over `CLICK_FREE_RAMP` (~20ms) rather
 * than jumping to the new value instantly — required for stop (§4.4: "cutting a sine mid-cycle
 * produces an audible click"), and applied uniformly here since a seek can jump gain by an
 * arbitrary amount too. Frequency has no such click risk (`OscillatorNode` frequency changes
 * don't introduce an amplitude discontinuity), so it re-anchors directly.
 *
 * Mute and solo are **session** state, deliberately separate from the document's own
 * `voice.muted` flag (which Phase 1's editor will change): the document seeds the initial state
 * and runtime toggles override it, so silencing a voice to hear another never edits the file.
 * Muting changes no timing — a muted voice still advances through its entries and can still end
 * the schedule (§3.2).
 *
 * Accepts an optional `BaseAudioContext` for deterministic testing with an `OfflineAudioContext`
 * (mirroring `playSchedule`); real usage leaves it unset so the browser `AudioContext` is
 * created lazily.
 */
export class PlaybackEngine {
  private context: BaseAudioContext | null;
  private schedule: Schedule | null = null;
  private output: OutputChain | null = null;
  private voiceStates: VoiceState[] = [];
  private anchorContextTime = 0; // context.currentTime corresponding to total-time zero
  private frozenTotal = 0; // total offset to resume from; authoritative only while paused
  private playing = false;
  private duration = 0;
  private passes = 1;
  private masterGain = 1;
  private noise: NoiseLayerSettings = SILENT_NOISE_LAYER;
  private noiseLayer: NoiseLayer | null = null;
  private muted = new Set<number>();
  private soloed = new Set<number>();

  constructor(context?: BaseAudioContext) {
    this.context = context ?? null;
  }

  load(schedule: Schedule): void {
    this.teardownGraph();
    this.schedule = schedule;
    this.duration = scheduleDuration(schedule);
    this.passes = passCount(schedule, this.duration);
    this.frozenTotal = 0;
    this.playing = false;
    this.muted = new Set(schedule.voices.flatMap((voice, index) => (voice.muted ? [index] : [])));
    this.soloed = new Set();
  }

  /**
   * Swap in an edited version of the loaded schedule without interrupting playback (§6.1).
   *
   * `load()` is for a different program: it tears the graph down, silences everything and returns
   * to zero, all of which are right when you pick another file and wrong for an edit. This keeps
   * the context, the output chain, the oscillators and their phase, the playhead, the session
   * mute/solo state and the master gain, and rewrites only what the edit changed — then
   * re-schedules from where the playhead already is, which §4.3 made a single call.
   *
   * **The playhead is projected forward across the transition, and that is the whole subtlety.**
   * `rescheduleFrom(total)` means "be at schedule-time `total` when this lands", and what it lands
   * on is `scheduleLookahead + CLICK_FREE_RAMP` in the future — so passing the *current* offset
   * silently walks the clock backwards by that much. Once per seek it is the invisible artifact
   * `getCurrentOffset` already documents. Ten times a second under a drag it is 0.7 s of lost
   * playback per second, and the playhead visibly stalls. Adding the window back is what makes an
   * edit continuous instead of a very small seek.
   *
   * Two paths, indistinguishable from outside: values are written into the voices that already
   * exist, and only a change of voice count, `type` or `mono` builds new nodes (see
   * `requiresVoiceRebuild`) — a crossfade, not a cut.
   */
  update(schedule: Schedule): void {
    const previous = this.schedule;
    if (!previous) {
      this.load(schedule);
      return;
    }
    // The document is immutable and reference-compared (§4.1), so this is the honest no-op test.
    if (schedule === previous) return;

    // Read the position under the *old* duration, before the edit can change what a pass is.
    const wasPlaying = this.playing;
    const pass = this.getPass();
    const offset = this.getCurrentOffset();

    this.adoptDocumentMutes(previous, schedule);
    this.schedule = schedule;
    this.duration = scheduleDuration(schedule);
    this.passes = passCount(schedule, this.duration);

    // An edit can change how long the schedule is (§3.7 — the shortest voice decides). Keep the
    // position within the pass rather than the absolute time across passes: that is what the
    // listener hears as "where I am", and a schedule cut shorter than the playhead simply ends.
    const resumeAt =
      Math.min(pass, this.passes - 1) * this.duration + Math.min(offset, this.duration);

    const context = this.context;
    if (!context || !this.output) {
      this.frozenTotal = Math.min(this.getTotalDuration(), resumeAt);
      return;
    }

    const lookahead = scheduleLookahead(context);
    const at = context.currentTime + lookahead;
    rampParam(this.output.left.gain, schedule.masterVolume.left, at);
    rampParam(this.output.right.gain, schedule.masterVolume.right, at);
    setStereoSwap(this.output, schedule.stereoSwap, at);

    if (requiresVoiceRebuild(previous, schedule)) {
      this.retireVoices(at + CLICK_FREE_RAMP);
      this.buildVoices(context, schedule, this.output);
    } else {
      for (const state of this.voiceStates) {
        state.events = compileVoice(schedule.voices[state.index]);
      }
      this.applyVoiceGates();
    }

    const projected = wasPlaying ? lookahead + CLICK_FREE_RAMP : 0;
    this.rescheduleFrom(Math.min(this.getTotalDuration(), resumeAt + projected), wasPlaying);
  }

  /**
   * Create the context and graph without scheduling anything or making a sound.
   *
   * Exists so the caller can get the output's real sample rate *before* starting playback — the
   * silent keepalive needs it, and on Android that element has to be playing before the context is
   * asked to resume, since it is what holds audio focus. Idempotent, and `play()` still calls the
   * same thing, so skipping it changes nothing but the ordering.
   */
  prepare(): void {
    if (!this.schedule) return;
    this.ensureGraph();
  }

  play(): void {
    if (!this.schedule) return;
    this.ensureGraph();
    this.rescheduleFrom(this.frozenTotal, true);
  }

  pause(): void {
    if (!this.context || !this.playing) return;
    this.rescheduleFrom(this.getTotalOffset(), false);
  }

  /**
   * Seek within the current pass. A looping schedule keeps the passes it has already played.
   *
   * Seeking to the very end of a pass therefore lands on the start of the next one, because on a
   * looping schedule those are the same instant and the same audio. Only the end of the final pass
   * is the end of playback.
   */
  seek(offset: number): void {
    if (!this.schedule) return;
    this.ensureGraph();
    const within = Math.min(this.duration, Math.max(0, offset));
    this.rescheduleFrom(this.getPass() * this.duration + within, this.playing);
  }

  stop(): void {
    if (!this.context) return;
    this.rescheduleFrom(0, false);
  }

  /** Where the playhead sits **within the current pass** — what the timeline and chart plot. */
  getCurrentOffset(): number {
    if (this.duration <= 0) return 0;
    const total = this.getTotalOffset();
    // At the very end the modulo would wrap to zero, which reads as "back at the start" when what
    // is true is "finished".
    return total >= this.getTotalDuration() ? this.duration : total % this.duration;
  }

  /** How long one pass lasts — the shortest voice, per §3.7. */
  getDuration(): number {
    return this.duration;
  }

  /** Everything that will be played: one pass per `loops`, bounded for an endless schedule. */
  getTotalDuration(): number {
    return this.duration * this.passes;
  }

  /** Which pass is playing, counting from zero. */
  getPass(): number {
    if (this.duration <= 0) return 0;
    return Math.min(this.passes - 1, Math.floor(this.getTotalOffset() / this.duration));
  }

  /** How many passes there are, per `loops` (§3.2). */
  getPassCount(): number {
    return this.passes;
  }

  /** Whether the last pass has run out. The audio has already faded on its own scheduled ramp. */
  hasEnded(): boolean {
    const total = this.getTotalDuration();
    return total > 0 && this.getTotalOffset() >= total;
  }

  /** Elapsed time across every pass — the engine's own coordinate, and what `seek` works in. */
  private getTotalOffset(): number {
    if (!this.context) return this.frozenTotal;
    const elapsed = this.playing
      ? this.context.currentTime - this.anchorContextTime
      : this.frozenTotal;
    return Math.min(this.getTotalDuration(), Math.max(0, elapsed));
  }

  /** The output rate, once a context exists — what anything sharing the output must match. */
  getSampleRate(): number | null {
    return this.context?.sampleRate ?? null;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  /** App-level output level, independent of the file's `overallvolume_*` (§5.1). */
  setMasterGain(value: number): void {
    this.masterGain = Math.max(0, value);
    if (!this.output || !this.context) return;

    // Ramped rather than stepped: a slider dragged across a jumping param is audible as zipper
    // noise.
    const now = this.context.currentTime;
    const gain = this.output.masterGain.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(this.masterGain, now + CLICK_FREE_RAMP);
  }

  getMasterGain(): number {
    return this.masterGain;
  }

  /**
   * The app's own noise bed (§4.5b) — a listening preference, not part of the loaded document.
   *
   * It therefore survives `load()` like the master volume does, follows the transport (a bed with
   * nothing under it is just hiss), and is **absent from `playSchedule`**, which is the export
   * path: a WAV is the document as authored, and the same program must export the same bytes
   * whoever renders it.
   */
  setNoiseLayer(settings: NoiseLayerSettings): void {
    this.noise = { colour: settings.colour, gain: Math.max(0, settings.gain) };
    if (!this.context) return;

    const at = this.context.currentTime + scheduleLookahead(this.context);
    this.applyNoiseLayer(at, this.playing && !this.hasEnded());
  }

  getNoiseLayer(): NoiseLayerSettings {
    return this.noise;
  }

  setVoiceMuted(index: number, muted: boolean): void {
    setMembership(this.muted, index, muted);
    this.applyVoiceGates();
  }

  setVoiceSoloed(index: number, soloed: boolean): void {
    setMembership(this.soloed, index, soloed);
    this.applyVoiceGates();
  }

  isVoiceMuted(index: number): boolean {
    return this.muted.has(index);
  }

  isVoiceSoloed(index: number): boolean {
    return this.soloed.has(index);
  }

  /** Whether a voice is audible right now, with mute and solo both taken into account. */
  isVoiceAudible(index: number): boolean {
    if (this.muted.has(index)) return false;
    return this.soloed.size === 0 || this.soloed.has(index);
  }

  /**
   * Bring the context back if the platform put it to sleep.
   *
   * Creating an `AudioContext` inside a user gesture (§4.4) gets it `running`, and for a page that
   * stays in the foreground that is the end of it. Android is not that page: pressing pause on the
   * media notification hands audio focus away, and Chrome **suspends** the context when it goes.
   * A suspended context's `currentTime` stops, so `rescheduleFrom` goes on scheduling perfectly
   * correct automation against a clock that never reaches it — silence, a frozen playhead, and no
   * way back, because nothing else in the app would ever have resumed it. Found on hardware:
   * lock-screen pause worked and then nothing could start playback again, in the app or out of it.
   *
   * Not awaited. `resume()` must be called from within the user gesture that asked for playback,
   * and the clock stays frozen until it settles, so the automation scheduled immediately after
   * this is still comfortably in the future when the audio thread gets there.
   *
   * `baseLatency` is the discriminator `scheduleLookahead` already uses for "is this a real-time
   * context": an `OfflineAudioContext` also reports `suspended` before it renders, and resuming
   * one out of band would start its render early.
   */
  private resumeIfSuspended(): void {
    const context = this.context as AudioContext | null;
    if (!context || typeof context.baseLatency !== 'number') return;

    if (context.state !== 'suspended' || typeof context.resume !== 'function') return;

    // A refusal costs us this one transition, not the session — better than throwing out of a
    // click handler.
    void context.resume().catch(() => undefined);
  }

  /** Lazily create the `AudioContext` (§4.4 — must happen inside a user gesture) and build the
   *  persistent voice graph, the first time either is needed. */
  private ensureGraph(): void {
    this.context ??= new AudioContext({ latencyHint: PLAYBACK_LATENCY_HINT });
    if (!this.output && this.schedule) this.buildGraph(this.context, this.schedule);
  }

  private buildGraph(context: BaseAudioContext, schedule: Schedule): void {
    const output = buildOutputChain(context, schedule);
    output.masterGain.gain.value = this.masterGain;
    this.output = output;
    this.buildVoices(context, schedule, output);

    // Generated here rather than left to the first transition, for the case that matters most:
    // the setting persists, so a returning listener has it on before they press Play. Filling two
    // ten-second buffers is tens of milliseconds of main-thread work, and inside `rescheduleFrom`
    // that work sits between reading the clock and scheduling against it — long enough to push the
    // anti-click ramp back into the past, which is exactly the bug `scheduleLookahead` exists for.
    // `prepare()` runs this inside the user's gesture, before anything is sounding.
    if (this.noise.gain > 0) this.noiseLayer = buildNoiseLayer(context, output, this.noise.colour);
  }

  /** Separate from `buildGraph` because `update()` replaces voices while keeping the output chain
   *  — the chain belongs to the session, the voices belong to the document. */
  private buildVoices(context: BaseAudioContext, schedule: Schedule, output: OutputChain): void {
    schedule.voices.forEach((voice, index) => {
      if (!isRenderable(voice)) return;

      const nodes = buildVoiceNodes(context, voice, index, output);
      nodes.gainL.gain.value = 0; // silent until the first rescheduleFrom fades it in
      nodes.gainR.gain.value = 0;
      setGate(nodes, this.isVoiceAudible(index) ? 1 : 0);
      // Sources are started by the first rescheduleFrom, not here, so that schedule-time zero is
      // the instant an oscillator's phase starts from zero.
      this.voiceStates.push({ index, events: compileVoice(voice), nodes });
    });
  }

  private teardownGraph(): void {
    const now = this.context?.currentTime ?? 0;
    for (const { nodes } of this.voiceStates) disposeSource(nodes.source, now);
    this.voiceStates = [];
    // The layer's settings are app state and survive a new program, but its nodes hang off the
    // output chain this is discarding, so they are rebuilt with the next graph.
    if (this.noiseLayer) stopNoiseLayer(this.noiseLayer, now);
    this.noiseLayer = null;
    this.output = null;
  }

  /**
   * Fade the current voices out and release them at `when`, leaving the output chain standing.
   *
   * The replacements are built silent and faded in by the `rescheduleFrom` that follows, reaching
   * full level at the same instant these reach zero — so a structural edit crossfades rather than
   * cutting, which is §4.4's rule applied to the one transition that has to swap nodes. Nothing
   * disconnects anything: a source that has been stopped releases the whole chain behind it, and a
   * JS timer waiting to disconnect is exactly what §4.2 keeps out of the audio path.
   */
  private retireVoices(when: number): void {
    const context = this.context;
    if (!context) return;
    const now = context.currentTime;

    for (const { nodes } of this.voiceStates) {
      for (const param of [nodes.gainL.gain, nodes.gainR.gain]) {
        // Read before cancelling, for the reason `rescheduleFrom` gives.
        const held = param.value;
        param.cancelScheduledValues(now);
        param.setValueAtTime(held, now);
        param.linearRampToValueAtTime(0, when);
      }
      disposeSource(nodes.source, when);
    }

    this.voiceStates = [];
  }

  /**
   * Take on the document's own mute flags, but only where the edit actually changed one.
   *
   * Session mute/solo is deliberately separate from `voice.muted` (§3.2): the document seeds it and
   * runtime toggles override it. Re-seeding wholesale on every edit would undo a listener's solo
   * every time they dragged a breakpoint; ignoring the document entirely would make the editor's
   * own mute control do nothing. Comparing against the previous document is what distinguishes an
   * edit *to* the flag from an edit that merely happened while the flag was set.
   */
  private adoptDocumentMutes(previous: Schedule, next: Schedule): void {
    next.voices.forEach((voice, index) => {
      if (voice.muted !== previous.voices[index]?.muted) setMembership(this.muted, index, voice.muted);
    });

    // Indices are the key (§3.4 — ids are not unique), so a shorter document leaves strays behind.
    for (const set of [this.muted, this.soloed]) {
      for (const index of [...set]) if (index >= next.voices.length) set.delete(index);
    }
  }

  /**
   * Bring the noise layer into line with its settings and the transport, as of context time `at`.
   *
   * Called at the end of every `rescheduleFrom` — the choke point §4.3 gives every transition —
   * and from `setNoiseLayer`, which is a transition for this one node. `sounding` is that
   * transition's own answer to "is there audio after this", so a seek to the very end silences the
   * bed with everything else.
   *
   * The layer is **built on first use and never before**, so a listener who leaves it off never
   * pays for a second pair of looping buffer sources. That cost is the one this graph has proved
   * sensitive to on a phone, and the layer is off by default.
   */
  private applyNoiseLayer(at: number, sounding: boolean): void {
    const context = this.context;
    const output = this.output;
    if (!context || !output) return;

    const audible = sounding && this.noise.gain > 0;

    // A colour is a different buffer and so needs different sources. Fade the old ones out and
    // release them; the replacement below is built silent and fades in over them, so the change is
    // a crossfade rather than a hole. Nothing disconnects anything — a stopped source releases the
    // chain behind it, and a JS timer waiting to disconnect is what §4.2 keeps out of the audio
    // path.
    if (this.noiseLayer && this.noiseLayer.colour !== this.noise.colour) {
      this.retireNoiseLayer(at);
    }
    if (audible && !this.noiseLayer) {
      this.noiseLayer = buildNoiseLayer(context, output, this.noise.colour);
    }

    const layer = this.noiseLayer;
    if (!layer) return;

    const target = audible ? this.noise.gain : 0;
    const gain = layer.gain.gain;
    // Read before cancelling, held flat across the lookahead window, then ramped — the same shape
    // `rescheduleFrom` uses on every other gain, and for the same reasons.
    const held = gain.value;
    gain.cancelScheduledValues(at);
    gain.setValueAtTime(held, at);
    gain.linearRampToValueAtTime(target, at + CLICK_FREE_RAMP);

    if (!audible) {
      stopNoiseLayer(layer, at + CLICK_FREE_RAMP);
      return;
    }

    // Only when there are none: a seek does not need to reposition stationary noise, and a slider
    // dragged across the level should not rebuild a source ten times a second.
    if (layer.nodes.length === 0) startNoiseLayer(context, layer, at, this.getTotalOffset());

    // The bed ends where the programme does, scheduled up front like everything else (§4.2).
    // Held flat until then rather than ramped from here, which would fade it out across the whole
    // schedule.
    const endsAt = this.anchorContextTime + this.getTotalDuration();
    if (endsAt > at + CLICK_FREE_RAMP) {
      gain.setValueAtTime(target, endsAt);
      gain.linearRampToValueAtTime(0, endsAt + CLICK_FREE_RAMP);
    }
  }

  private retireNoiseLayer(at: number): void {
    const layer = this.noiseLayer;
    if (!layer) return;

    const gain = layer.gain.gain;
    const held = gain.value;
    gain.cancelScheduledValues(at);
    gain.setValueAtTime(held, at);
    gain.linearRampToValueAtTime(0, at + CLICK_FREE_RAMP);
    stopNoiseLayer(layer, at + CLICK_FREE_RAMP);
    this.noiseLayer = null;
  }

  private applyVoiceGates(): void {
    if (!this.context) return;
    const now = this.context.currentTime;

    for (const { index, nodes } of this.voiceStates) {
      const gate = this.isVoiceAudible(index) ? 1 : 0;
      for (const param of [nodes.muteL.gain, nodes.muteR.gain]) {
        param.cancelScheduledValues(now);
        param.setValueAtTime(param.value, now);
        param.linearRampToValueAtTime(gate, now + CLICK_FREE_RAMP);
      }
    }
  }

  /**
   * Rebuild every voice's scheduled automation as of `total` seconds into playback (PLAN.md §4.3).
   *
   * `total` counts across passes, so for a looping schedule this schedules the remainder of the
   * current pass and then every pass after it, in full and up front — no JS timer touches audio
   * (§4.2), which is the whole reason playback survives a screen-off phone.
   */
  private rescheduleFrom(total: number, playing: boolean): void {
    const context = this.context;
    if (!context) return;

    // Before the clock is read, because a suspended one is frozen and everything below is
    // relative to it.
    if (playing) this.resumeIfSuspended();

    const now = context.currentTime;
    // The instant the transition happens: far enough ahead that the whole ramp below is still in
    // the future when the audio thread reaches it. See `scheduleLookahead`.
    const at = now + scheduleLookahead(context);
    const t0 = at + CLICK_FREE_RAMP - total;
    const totalDuration = this.getTotalDuration();
    // Seeking to the very end leaves nothing to play; treat it as silent rather than holding the
    // final value.
    const audible = playing && total < totalDuration;
    const offset = this.duration > 0 ? total % this.duration : 0;
    const firstPass = this.duration > 0 ? Math.floor(total / this.duration) : 0;
    const lastPassStart = (this.passes - 1) * this.duration;

    for (const { events, nodes } of this.voiceStates) {
      // Read before cancelling: `cancelScheduledValues` drops a ramp in progress and leaves the
      // param holding that ramp's *start* value, not the value it had actually reached.
      const heldL = nodes.gainL.gain.value;
      const heldR = nodes.gainR.gain.value;

      cancelFrequency(nodes.source, now);
      nodes.gainL.gain.cancelScheduledValues(now);
      nodes.gainR.gain.cancelScheduledValues(now);

      const target = valueAtTime(events, offset);

      // Frequency: no click risk from an instant jump — reanchor directly at the new offset.
      anchorFrequency(nodes.source, target, at);

      // Gain: pin the value it actually holds, keep it flat across the lookahead window, then
      // glide to the new target (0 if pausing/stopping) over a ramp that is entirely ahead of the
      // audio thread. Every transition, including a large seek jump, is click-free.
      nodes.gainL.gain.setValueAtTime(heldL, now);
      nodes.gainR.gain.setValueAtTime(heldR, now);
      nodes.gainL.gain.setValueAtTime(heldL, at);
      nodes.gainR.gain.setValueAtTime(heldR, at);
      nodes.gainL.gain.linearRampToValueAtTime(audible ? target.leftGain : 0, at + CLICK_FREE_RAMP);
      nodes.gainR.gain.linearRampToValueAtTime(audible ? target.rightGain : 0, at + CLICK_FREE_RAMP);

      if (audible) {
        const truncated = outlastsSchedule(events, this.duration);

        for (let pass = firstPass; pass < this.passes; pass++) {
          const passStart = pass * this.duration;
          // Only a voice §3.7 cuts short needs anything at the seam; for one as long as the
          // schedule, §3.5's wrap has already brought it back to entry[0].
          if (pass > firstPass && truncated) scheduleSeam(events, t0 + passStart, this.duration, nodes);

          for (const event of events) {
            // The first event of a later pass sits at the same instant as the previous pass's
            // terminal one and carries the same values; scheduling both would put two events on
            // one param at one time to no effect.
            if (pass > firstPass && event.time <= 0) continue;
            if (passStart + event.time <= total) continue;
            if (event.time > this.duration) break;
            rampFrequency(nodes.source, event, t0 + passStart + event.time);
            nodes.gainL.gain.linearRampToValueAtTime(event.leftGain, t0 + passStart + event.time);
            nodes.gainR.gain.linearRampToValueAtTime(event.rightGain, t0 + passStart + event.time);
          }
        }

        scheduleEnding(events, t0 + lastPassStart, this.duration, nodes);
        startSource(context, nodes.source, t0, total);
      } else {
        // Pausing or stopping: buffer sources can't be gated back on, so they are released once
        // the anti-click fade has finished and rebuilt by the next play.
        stopNoise(nodes.source, at + CLICK_FREE_RAMP);
      }
    }

    this.anchorContextTime = t0;
    this.frozenTotal = total;
    this.playing = playing;

    // Last, so it reads the position and the schedule end this transition has just established.
    this.applyNoiseLayer(at, audible);
  }
}

function setMembership(set: Set<number>, value: number, member: boolean): void {
  if (member) set.add(value);
  else set.delete(value);
}
