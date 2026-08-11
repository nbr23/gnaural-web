import type { Schedule } from '../document/types';
import { VoiceType } from '../document/types';
import { seriesColor } from '../viz/palette';
import type { VoiceGate } from './usePlayer';

export interface VoiceListProps {
  schedule: Schedule;
  gates: VoiceGate[];
  onToggleMute: (index: number) => void;
  onToggleSolo: (index: number) => void;
}

/**
 * Per-voice mute and solo (PLAN.md §5.1). Runtime state only — silencing a voice to hear another
 * never edits the document.
 *
 * Each row is keyed with the same colour the chart draws that voice in, so identity carries
 * across the two views. Voice types this app cannot render are labelled as silent rather than
 * hidden, and have their controls disabled: §3.3 is explicit that a voice must never be silently
 * dropped. This is the per-voice half of that; `WarningList` states it once for the program.
 */
const TYPE_LABELS: Partial<Record<VoiceType, string>> = {
  [VoiceType.PinkNoise]: 'noise',
};

const UNRENDERED_LABELS: Partial<Record<VoiceType, string>> = {
  [VoiceType.Pcm]: 'external audio — cannot be rendered',
  [VoiceType.IsoPulse]: 'isochronic — not yet rendered',
  [VoiceType.IsoPulseAlt]: 'isochronic — not yet rendered',
  [VoiceType.WaterDrops]: 'water drops — not yet rendered',
  [VoiceType.Rain]: 'rain — not yet rendered',
};

export function VoiceList({ schedule, gates, onToggleMute, onToggleSolo }: VoiceListProps) {
  return (
    <ul className="voice-list">
      {schedule.voices.map((voice, index) => {
        const gate = gates[index];
        const unrendered = UNRENDERED_LABELS[voice.type];
        const badge = unrendered ?? TYPE_LABELS[voice.type];

        return (
          <li
            className={`voice-list__row${gate?.audible === false ? ' voice-list__row--silent' : ''}`}
            key={index}
          >
            <span className="voice-list__key" style={{ color: seriesColor(index) }} />
            <span className="voice-list__name">
              {voice.description.trim() || `Voice ${voice.id}`}
              {badge && <span className="voice-list__badge">{badge}</span>}
            </span>
            <button
              type="button"
              className={`voice-list__toggle${gate?.muted ? ' is-active' : ''}`}
              aria-pressed={gate?.muted ?? false}
              disabled={Boolean(unrendered)}
              onClick={() => onToggleMute(index)}
            >
              Mute
            </button>
            <button
              type="button"
              className={`voice-list__toggle${gate?.soloed ? ' is-active' : ''}`}
              aria-pressed={gate?.soloed ?? false}
              disabled={Boolean(unrendered)}
              onClick={() => onToggleSolo(index)}
            >
              Solo
            </button>
          </li>
        );
      })}
    </ul>
  );
}
