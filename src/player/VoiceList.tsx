import { SpeakerOffIcon, SpeakerOnIcon } from '../app/icons';
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
 * Per-voice mute and solo. Runtime state only — silencing a voice to hear another never edits the
 * document.
 *
 * Solo mutes the others and nothing more: the engine holds no separate solo state, a voice is
 * soloed when it's the only renderable one left unmuted (`PlaybackEngine.isVoiceSoloed`), so a
 * quiet row always shows the same crossed speaker a hand-muted row does. Voice types this app
 * cannot render are labelled as silent, not hidden, with their controls disabled — a voice must
 * never be silently dropped.
 */
const TYPE_LABELS: Partial<Record<VoiceType, string>> = {
  [VoiceType.PinkNoise]: 'noise',
  [VoiceType.IsoPulse]: 'isochronic',
  // Named apart from IsoPulse: the difference is audible — the pulse swaps ears.
  [VoiceType.IsoPulseAlt]: 'isochronic (alternating)',
  [VoiceType.WaterDrops]: 'water drops',
  [VoiceType.Rain]: 'rain',
};

const UNRENDERED_LABELS: Partial<Record<VoiceType, string>> = {
  [VoiceType.Pcm]: 'external audio — cannot be rendered',
};

export function VoiceList({ schedule, gates, onToggleMute, onToggleSolo }: VoiceListProps) {
  return (
    <ul className="voice-list">
      {schedule.voices.map((voice, index) => {
        const gate = gates[index];
        const unrendered = UNRENDERED_LABELS[voice.type];
        const badge = unrendered ?? TYPE_LABELS[voice.type];
        const name = voice.description.trim() || `Voice ${voice.id}`;
        const muted = gate?.muted ?? false;
        // A voice that cannot be rendered is silent whatever its gate says — it never sounds.
        const silent = Boolean(unrendered) || muted;
        const label = `${muted ? 'Unmute' : 'Mute'} ${name}`;

        return (
          <li className={`voice-list__row${silent ? ' voice-list__row--silent' : ''}`} key={index}>
            <span className="voice-list__key" style={{ color: seriesColor(index) }} />
            <span className="voice-list__name">
              {name}
              {badge && <span className="voice-list__badge">{badge}</span>}
            </span>
            <button
              type="button"
              className={`voice-list__toggle voice-list__toggle--icon${muted ? ' is-active' : ''}`}
              title={label}
              aria-pressed={muted}
              disabled={Boolean(unrendered)}
              onClick={() => onToggleMute(index)}
            >
              {muted ? <SpeakerOffIcon /> : <SpeakerOnIcon />}
              <span className="visually-hidden">{label}</span>
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
