import type { Schedule, Voice } from '../document/types';
import { VoiceType } from '../document/types';
import { compileVoice } from './compiler';

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

/**
 * Thin browser-only session wrapper. `AudioContext` is created lazily on the first `play()`
 * call, which must happen inside a user-gesture handler (§4.4), then reused for the app's
 * lifetime.
 *
 * `stop()` here is a step-3 stopgap — closing the context is simple but not click-free and
 * discards the graph entirely. Proper pause/resume/seek via `rescheduleFrom` lands in step 4.
 */
export class PlaybackEngine {
  private context: AudioContext | null = null;

  play(schedule: Schedule): void {
    if (!this.context) this.context = new AudioContext();
    playSchedule(this.context, schedule);
  }

  stop(): void {
    if (!this.context) return;
    void this.context.close();
    this.context = null;
  }
}
