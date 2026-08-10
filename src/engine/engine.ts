import { scheduleDuration } from '../document/timing';
import type { Schedule, Voice } from '../document/types';
import { VoiceType } from '../document/types';
import type { AutomationEvent } from './compiler';
import { compileVoice, valueAtTime } from './compiler';

/** Anti-click gain ramp duration (PLAN.md §4.4 — ~20ms, applied on every transport transition). */
export const CLICK_FREE_RAMP = 0.02;

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

interface VoiceNodes {
  oscL: OscillatorNode;
  oscR: OscillatorNode;
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
 * One oscillator pair per voice, each through its own gain and mute gate, into the output chain.
 *
 * `voice_mono` (§3.2) routes both oscillators through a single 0.5 gain first, so each channel
 * carries `(L+R)/2` before `volume_left`/`volume_right` are applied to it independently. It is a
 * downmix of the voice's own content, not a pan — the per-channel volumes still apply afterwards.
 */
function buildVoiceNodes(context: BaseAudioContext, voice: Voice, output: OutputChain): VoiceNodes {
  const oscL = context.createOscillator();
  const oscR = context.createOscillator();
  const gainL = context.createGain();
  const gainR = context.createGain();
  const muteL = context.createGain();
  const muteR = context.createGain();

  if (voice.mono) {
    const downmix = context.createGain();
    downmix.gain.value = 0.5;
    oscL.connect(downmix);
    oscR.connect(downmix);
    downmix.connect(gainL);
    downmix.connect(gainR);
  } else {
    oscL.connect(gainL);
    oscR.connect(gainR);
  }

  gainL.connect(muteL).connect(output.left);
  gainR.connect(muteR).connect(output.right);

  return { oscL, oscR, gainL, gainR, muteL, muteR };
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
  nodes.oscL.frequency.setValueAtTime(first.leftFreq, t0);
  nodes.oscR.frequency.setValueAtTime(first.rightFreq, t0);
  nodes.gainL.gain.setValueAtTime(first.leftGain, t0);
  nodes.gainR.gain.setValueAtTime(first.rightGain, t0);

  for (const event of rest) {
    if (event.time > endOffset) break;
    nodes.oscL.frequency.linearRampToValueAtTime(event.leftFreq, t0 + event.time);
    nodes.oscR.frequency.linearRampToValueAtTime(event.rightFreq, t0 + event.time);
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
  return voice.type === VoiceType.Binaural;
}

/**
 * Build the full audio graph for a schedule and start playback immediately at
 * `context.currentTime`: one persistent oscillator pair per binaural voice (§4.4 — oscillators
 * are reused for the whole session, never stopped/restarted per segment), summed through
 * per-channel master gain into `context.destination`.
 *
 * Works with any `BaseAudioContext` — a real `AudioContext` for playback, or an
 * `OfflineAudioContext` for deterministic sample-level testing and for step 7's WAV export,
 * which is why this shares `buildOutputChain`/`buildVoiceNodes` with `PlaybackEngine` instead of
 * building a graph of its own.
 *
 * Only voice type 0 (binaural) is rendered. Other types are parsed and preserved by the document
 * layer but silent here; surfacing a user-visible warning for them (§3.3) is a later step.
 * `loops` (§3.7) is not yet applied — see PROGRESS.md.
 */
export function playSchedule(context: BaseAudioContext, schedule: Schedule): void {
  const output = buildOutputChain(context, schedule);
  const t0 = context.currentTime;
  const endOffset = scheduleDuration(schedule);

  for (const voice of schedule.voices) {
    if (!isRenderable(voice)) continue;

    const nodes = buildVoiceNodes(context, voice, output);
    // The document's own mute flag applies here, so an offline export matches live playback.
    setGate(nodes, voice.muted ? 0 : 1);
    scheduleVoice(compileVoice(voice), t0, endOffset, nodes);
    nodes.oscL.start(t0);
    nodes.oscR.start(t0);
  }
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
 * audibility is controlled entirely by gain automation.
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
    if (!this.context) this.context = new AudioContext();
    if (!this.output && this.schedule) this.buildGraph(this.context, this.schedule);
  }

  private buildGraph(context: BaseAudioContext, schedule: Schedule): void {
    const output = buildOutputChain(context, schedule);
    output.masterGain.gain.value = this.masterGain;
    this.output = output;

    schedule.voices.forEach((voice, index) => {
      if (!isRenderable(voice)) return;

      const nodes = buildVoiceNodes(context, voice, output);
      nodes.gainL.gain.value = 0; // silent until the first rescheduleFrom fades it in
      nodes.gainR.gain.value = 0;
      setGate(nodes, this.isVoiceAudible(index) ? 1 : 0);
      nodes.oscL.start();
      nodes.oscR.start();
      this.voiceStates.push({ index, events: compileVoice(voice), nodes });
    });
  }

  private teardownGraph(): void {
    for (const { nodes } of this.voiceStates) {
      nodes.oscL.stop();
      nodes.oscR.stop();
    }
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
    const t0 = now + CLICK_FREE_RAMP - offset;
    // Seeking to the very end leaves nothing to play; treat it as silent rather than holding the
    // final value.
    const audible = playing && offset < this.duration;

    for (const { events, nodes } of this.voiceStates) {
      nodes.oscL.frequency.cancelScheduledValues(now);
      nodes.oscR.frequency.cancelScheduledValues(now);
      nodes.gainL.gain.cancelScheduledValues(now);
      nodes.gainR.gain.cancelScheduledValues(now);

      const target = valueAtTime(events, offset);

      // Frequency: no click risk from an instant jump — reanchor directly at the new offset.
      nodes.oscL.frequency.setValueAtTime(target.leftFreq, now);
      nodes.oscR.frequency.setValueAtTime(target.rightFreq, now);

      // Gain: glide from whatever it currently holds to the new target (0 if pausing/stopping),
      // so every transition — including a large seek jump — is click-free.
      nodes.gainL.gain.setValueAtTime(nodes.gainL.gain.value, now);
      nodes.gainR.gain.setValueAtTime(nodes.gainR.gain.value, now);
      nodes.gainL.gain.linearRampToValueAtTime(audible ? target.leftGain : 0, now + CLICK_FREE_RAMP);
      nodes.gainR.gain.linearRampToValueAtTime(audible ? target.rightGain : 0, now + CLICK_FREE_RAMP);

      if (audible) {
        for (const event of events) {
          if (event.time <= offset) continue;
          if (event.time > this.duration) break;
          nodes.oscL.frequency.linearRampToValueAtTime(event.leftFreq, t0 + event.time);
          nodes.oscR.frequency.linearRampToValueAtTime(event.rightFreq, t0 + event.time);
          nodes.gainL.gain.linearRampToValueAtTime(event.leftGain, t0 + event.time);
          nodes.gainR.gain.linearRampToValueAtTime(event.rightGain, t0 + event.time);
        }
        scheduleEnding(events, t0, this.duration, nodes);
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
