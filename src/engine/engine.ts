import { scheduleDuration } from '../document/timing';
import type { Schedule, Voice } from '../document/types';
import { VoiceType } from '../document/types';
import type { AutomationEvent, AutomationValues } from './compiler';
import { compileVoice, valueAtTime } from './compiler';
import { createNoiseBuffer, noiseSeeds } from './noise';

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
  return lookaheadOverride ?? Math.max(MIN_LOOKAHEAD, buffered * 3);
}

/**
 * Force the lookahead, in seconds. **Diagnostic only** — see `src/app/debug.ts`.
 *
 * A module-level knob rather than a constructor argument because it is a temporary way to bisect
 * a device's buffering from the URL, not part of the engine's design. Ignored offline, where the
 * lookahead is always zero.
 */
let lookaheadOverride: number | null = null;

export function setLookaheadOverride(seconds: number | null): void {
  lookaheadOverride = seconds;
}

/** What the device reports about its output path. **Diagnostic only** — see `src/app/debug.ts`. */
export interface EngineDiagnostics {
  sampleRate: number | null;
  baseLatency: number | null;
  outputLatency: number | null;
  state: string | null;
  lookahead: number | null;
}

interface OutputChain {
  /** Bus a voice's left-channel signal feeds. Already accounts for `stereoSwap`. */
  left: AudioNode;
  right: AudioNode;
  /** App-level master, independent of the file's `overallvolume_*`. */
  masterGain: GainNode;
}

/**
 * Per-channel master gain (§3.2 — `overallvolume_left`/`_right` apply once, after all voices are
 * summed) into a `ChannelMergerNode`, then the app's own master gain, then the destination.
 *
 * `stereoSwap` swaps which merger input each channel feeds, which is deliberately *after*
 * `overallvolume_*` has been applied — §3.2: the left master gain follows the audio into the
 * right output, so asymmetric master volumes plus a swap do not behave like a naive swap.
 */
function buildOutputChain(context: BaseAudioContext, schedule: Schedule): OutputChain {
  const left = context.createGain();
  const right = context.createGain();
  left.gain.value = schedule.masterVolume.left;
  right.gain.value = schedule.masterVolume.right;

  const merger = context.createChannelMerger(2);
  left.connect(merger, 0, schedule.stereoSwap ? 1 : 0);
  right.connect(merger, 0, schedule.stereoSwap ? 0 : 1);

  const masterGain = context.createGain();
  merger.connect(masterGain).connect(context.destination);

  return { left, right, masterGain };
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

/** Voices this app can render. Other types are parsed and preserved, but silent (§3.3). */
function isRenderable(voice: Voice): boolean {
  return voice.type === VoiceType.Binaural || voice.type === VoiceType.PinkNoise;
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
 * document layer but silent here; surfacing a user-visible warning for them (§3.3) is a later
 * step. `loops` (§3.7) is not yet applied — see PROGRESS.md.
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
  private anchorContextTime = 0; // context.currentTime corresponding to schedule-offset 0
  private frozenOffset = 0; // offset to resume from; authoritative only while paused
  private playing = false;
  private duration = 0;
  private masterGain = 1;
  private muted = new Set<number>();
  private soloed = new Set<number>();

  constructor(context?: BaseAudioContext) {
    this.context = context ?? null;
  }

  load(schedule: Schedule): void {
    this.teardownGraph();
    this.schedule = schedule;
    this.duration = scheduleDuration(schedule);
    this.frozenOffset = 0;
    this.playing = false;
    this.muted = new Set(schedule.voices.flatMap((voice, index) => (voice.muted ? [index] : [])));
    this.soloed = new Set();
  }

  play(): void {
    if (!this.schedule) return;
    this.ensureGraph();
    this.rescheduleFrom(this.frozenOffset, true);
  }

  pause(): void {
    if (!this.context || !this.playing) return;
    this.rescheduleFrom(this.getCurrentOffset(), false);
  }

  seek(offset: number): void {
    if (!this.schedule) return;
    this.ensureGraph();
    this.rescheduleFrom(Math.min(this.duration, Math.max(0, offset)), this.playing);
  }

  stop(): void {
    if (!this.context) return;
    this.rescheduleFrom(0, false);
  }

  getCurrentOffset(): number {
    if (!this.context) return this.frozenOffset;
    const elapsed = this.playing
      ? this.context.currentTime - this.anchorContextTime
      : this.frozenOffset;
    return Math.min(this.duration, Math.max(0, elapsed));
  }

  /** How long the schedule plays for — the shortest voice, per §3.7. */
  getDuration(): number {
    return this.duration;
  }

  /** The output rate, once a context exists — what anything sharing the output must match. */
  getSampleRate(): number | null {
    return this.context?.sampleRate ?? null;
  }

  /** What the device actually reports about its output. **Diagnostic only** — see `debug.ts`. */
  getDiagnostics(): EngineDiagnostics {
    const context = this.context as AudioContext | null;
    if (!context) return { sampleRate: null, baseLatency: null, outputLatency: null, state: null, lookahead: null };

    return {
      sampleRate: context.sampleRate,
      baseLatency: context.baseLatency ?? null,
      outputLatency: context.outputLatency ?? null,
      state: context.state ?? null,
      lookahead: scheduleLookahead(context),
    };
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
    this.output = null;
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

  /** Rebuild every voice's scheduled automation as of schedule-time `offset` (PLAN.md §4.3). */
  private rescheduleFrom(offset: number, playing: boolean): void {
    const context = this.context;
    if (!context) return;

    const now = context.currentTime;
    // The instant the transition happens: far enough ahead that the whole ramp below is still in
    // the future when the audio thread reaches it. See `scheduleLookahead`.
    const at = now + scheduleLookahead(context);
    const t0 = at + CLICK_FREE_RAMP - offset;
    // Seeking to the very end leaves nothing to play; treat it as silent rather than holding the
    // final value.
    const audible = playing && offset < this.duration;

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
        for (const event of events) {
          if (event.time <= offset) continue;
          if (event.time > this.duration) break;
          rampFrequency(nodes.source, event, t0 + event.time);
          nodes.gainL.gain.linearRampToValueAtTime(event.leftGain, t0 + event.time);
          nodes.gainR.gain.linearRampToValueAtTime(event.rightGain, t0 + event.time);
        }
        scheduleEnding(events, t0, this.duration, nodes);
        startSource(context, nodes.source, t0, offset);
      } else {
        // Pausing or stopping: buffer sources can't be gated back on, so they are released once
        // the anti-click fade has finished and rebuilt by the next play.
        stopNoise(nodes.source, at + CLICK_FREE_RAMP);
      }
    }

    this.anchorContextTime = t0;
    this.frozenOffset = offset;
    this.playing = playing;
  }
}

function setMembership(set: Set<number>, value: number, member: boolean): void {
  if (member) set.add(value);
  else set.delete(value);
}
