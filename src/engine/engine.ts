import type { Schedule, Voice } from '../document/types';
import { VoiceType } from '../document/types';
import type { AutomationEvent } from './compiler';
import { compileVoice, valueAtTime } from './compiler';

/** Anti-click gain ramp duration (PLAN.md §4.4 — ~20ms, applied on every transport transition). */
export const CLICK_FREE_RAMP = 0.02;

interface VoiceNodes {
  oscL: OscillatorNode;
  oscR: OscillatorNode;
  gainL: GainNode;
  gainR: GainNode;
}

function buildVoiceNodes(context: BaseAudioContext, masterGainL: AudioNode, masterGainR: AudioNode): VoiceNodes {
  const oscL = context.createOscillator();
  const oscR = context.createOscillator();
  const gainL = context.createGain();
  const gainR = context.createGain();

  oscL.connect(gainL).connect(masterGainL);
  oscR.connect(gainR).connect(masterGainR);

  return { oscL, oscR, gainL, gainR };
}

/**
 * Anchor at `t0` with the first event via `setValueAtTime` — a ramp always interpolates from
 * whatever value the param already holds, so without an explicit anchor the first ramp would
 * start from the node's default rather than the voice's first entry (PLAN.md §4.2).
 */
function scheduleVoice(voice: Voice, t0: number, nodes: VoiceNodes): void {
  const events = compileVoice(voice);
  if (events.length === 0) return;

  const [first, ...rest] = events;
  nodes.oscL.frequency.setValueAtTime(first.leftFreq, t0);
  nodes.oscR.frequency.setValueAtTime(first.rightFreq, t0);
  nodes.gainL.gain.setValueAtTime(first.leftGain, t0);
  nodes.gainR.gain.setValueAtTime(first.rightGain, t0);

  for (const event of rest) {
    nodes.oscL.frequency.linearRampToValueAtTime(event.leftFreq, t0 + event.time);
    nodes.oscR.frequency.linearRampToValueAtTime(event.rightFreq, t0 + event.time);
    nodes.gainL.gain.linearRampToValueAtTime(event.leftGain, t0 + event.time);
    nodes.gainR.gain.linearRampToValueAtTime(event.rightGain, t0 + event.time);
  }
}

/**
 * Build the full audio graph for a schedule and start playback immediately at
 * `context.currentTime`: one persistent oscillator pair per binaural voice (§4.4 — oscillators
 * are reused for the whole session, never stopped/restarted per segment), summed through
 * per-channel master gain (§3.2 — overallvolume_left/right apply once, after all voices are
 * summed) into `context.destination`.
 *
 * Works with any `BaseAudioContext` — a real `AudioContext` for playback, or an
 * `OfflineAudioContext` for deterministic sample-level testing.
 *
 * Only voice type 0 (binaural) is rendered in this step. Other types are parsed and preserved
 * by the document layer but silently skipped here; surfacing a user-visible warning for them
 * (PLAN.md §3.3) is a later step. Mute, mono downmix, `stereoSwap`, and looping (§3.2) are not
 * yet applied — see PROGRESS.md.
 */
export function playSchedule(context: BaseAudioContext, schedule: Schedule): void {
  const masterGainL = context.createGain();
  const masterGainR = context.createGain();
  masterGainL.gain.value = schedule.masterVolume.left;
  masterGainR.gain.value = schedule.masterVolume.right;

  const merger = context.createChannelMerger(2);
  masterGainL.connect(merger, 0, 0);
  masterGainR.connect(merger, 0, 1);
  merger.connect(context.destination);

  const t0 = context.currentTime;

  for (const voice of schedule.voices) {
    if (voice.type !== VoiceType.Binaural) continue;

    const nodes = buildVoiceNodes(context, masterGainL, masterGainR);
    scheduleVoice(voice, t0, nodes);
    nodes.oscL.start(t0);
    nodes.oscR.start(t0);
  }
}

interface VoiceState {
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
 * Accepts an optional `BaseAudioContext` for deterministic testing with an `OfflineAudioContext`
 * (mirroring `playSchedule`); real usage leaves it unset so the browser `AudioContext` is
 * created lazily.
 */
export class PlaybackEngine {
  private context: BaseAudioContext | null;
  private schedule: Schedule | null = null;
  private voiceStates: VoiceState[] = [];
  private anchorContextTime = 0; // context.currentTime corresponding to schedule-offset 0
  private frozenOffset = 0; // offset to resume from; authoritative only while paused
  private playing = false;

  constructor(context?: BaseAudioContext) {
    this.context = context ?? null;
  }

  load(schedule: Schedule): void {
    this.teardownGraph();
    this.schedule = schedule;
    this.frozenOffset = 0;
    this.playing = false;
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
    this.rescheduleFrom(Math.max(0, offset), this.playing);
  }

  stop(): void {
    if (!this.context) return;
    this.rescheduleFrom(0, false);
  }

  getCurrentOffset(): number {
    if (!this.context) return this.frozenOffset;
    return this.playing ? this.context.currentTime - this.anchorContextTime : this.frozenOffset;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  /** Lazily create the `AudioContext` (§4.4 — must happen inside a user gesture) and build the
   *  persistent voice graph, the first time either is needed. */
  private ensureGraph(): void {
    if (!this.context) this.context = new AudioContext();
    if (this.voiceStates.length === 0 && this.schedule) this.buildGraph(this.context, this.schedule);
  }

  private buildGraph(context: BaseAudioContext, schedule: Schedule): void {
    const masterGainL = context.createGain();
    const masterGainR = context.createGain();
    masterGainL.gain.value = schedule.masterVolume.left;
    masterGainR.gain.value = schedule.masterVolume.right;

    const merger = context.createChannelMerger(2);
    masterGainL.connect(merger, 0, 0);
    masterGainR.connect(merger, 0, 1);
    merger.connect(context.destination);

    for (const voice of schedule.voices) {
      if (voice.type !== VoiceType.Binaural) continue;

      const nodes = buildVoiceNodes(context, masterGainL, masterGainR);
      nodes.gainL.gain.value = 0; // silent until the first rescheduleFrom fades it in
      nodes.gainR.gain.value = 0;
      nodes.oscL.start();
      nodes.oscR.start();
      this.voiceStates.push({ events: compileVoice(voice), nodes });
    }
  }

  private teardownGraph(): void {
    for (const { nodes } of this.voiceStates) {
      nodes.oscL.stop();
      nodes.oscR.stop();
    }
    this.voiceStates = [];
  }

  /** Rebuild every voice's scheduled automation as of schedule-time `offset` (PLAN.md §4.3). */
  private rescheduleFrom(offset: number, playing: boolean): void {
    const context = this.context;
    if (!context) return;

    const now = context.currentTime;
    const t0 = now + CLICK_FREE_RAMP - offset;

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
      nodes.gainL.gain.linearRampToValueAtTime(playing ? target.leftGain : 0, now + CLICK_FREE_RAMP);
      nodes.gainR.gain.linearRampToValueAtTime(playing ? target.rightGain : 0, now + CLICK_FREE_RAMP);

      if (playing) {
        for (const event of events) {
          if (event.time <= offset) continue;
          nodes.oscL.frequency.linearRampToValueAtTime(event.leftFreq, t0 + event.time);
          nodes.oscR.frequency.linearRampToValueAtTime(event.rightFreq, t0 + event.time);
          nodes.gainL.gain.linearRampToValueAtTime(event.leftGain, t0 + event.time);
          nodes.gainR.gain.linearRampToValueAtTime(event.rightGain, t0 + event.time);
        }
      }
    }

    this.anchorContextTime = t0;
    this.frozenOffset = offset;
    this.playing = playing;
  }
}
