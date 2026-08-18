import { formatClock, formatHz, numberOr } from '../app/format';
import { SpeakerOffIcon, SpeakerOnIcon } from '../app/icons';
import type { VoiceEdit, VoiceKind } from '../document/edit';
import {
  insertEntry,
  insertVoice,
  moveVoice,
  removeVoice,
  transposeVoice,
  updateVoice,
} from '../document/edit';
import { DURATION_EPSILON, scheduleDuration, voiceDuration } from '../document/timing';
import type { Schedule } from '../document/types';
import { VoiceType, isTonalType } from '../document/types';
import { seriesColor } from '../viz/palette';
import { CommittedField } from './CommittedField';
import type { NodeRef } from './history';

export interface VoiceRowsProps {
  schedule: Schedule;
  onCommit(schedule: Schedule, label: string): void;
  onStructural(edit: VoiceEdit, label: string, selection?: NodeRef | null): void;
}

const TYPE_LABELS: Partial<Record<VoiceType, string>> = {
  [VoiceType.PinkNoise]: 'noise',
  [VoiceType.Pcm]: 'external audio',
  [VoiceType.IsoPulse]: 'isochronic',
  [VoiceType.IsoPulseAlt]: 'isochronic (alternating)',
  [VoiceType.WaterDrops]: 'water drops',
  [VoiceType.Rain]: 'rain',
};

// Every control here edits the document; there's no session state. Solo lives only in the player,
// since it means "mute the others" and would otherwise have to edit the program just to listen.
// Reorder is buttons rather than drag-and-drop, since a second drag system beside the chart's own
// pointer capture invites trouble, and the corpus tops out at five voices anyway.
export function VoiceRows({ schedule, onCommit, onStructural }: VoiceRowsProps) {
  const voices = schedule.voices;
  const playback = scheduleDuration(schedule);

  const add = (kind: VoiceKind) => {
    const edit = insertVoice(schedule, { kind });
    onStructural(edit, 'Add voice', { voice: edit.schedule.voices.length - 1, entry: 0 });
  };

  return (
    <section className="editor__fields">
      <p className="editor__hint">
        Mute and hide are saved with the program. To silence a voice just for listening, use the
        player.
      </p>

      <ul className="voice-rows">
        {voices.map((voice, index) => {
          const own = voiceDuration(voice);
          const badge = TYPE_LABELS[voice.type];
          const nodes = voice.entries.length;

          const name = voice.description.trim() || `Voice ${voice.id}`;
          const muteLabel = `${voice.muted ? 'Unmute' : 'Mute'} ${name}`;
          // Only where `basefreq` is a carrier: the engine never reads it on a noise voice, and on
          // water and rain it is a per-sample probability, so a field in Hz would be untrue there.
          const first = isTonalType(voice.type) ? voice.entries[0] : undefined;

          return (
            <li
              className={`voice-rows__row${voice.muted ? ' voice-rows__row--silent' : ''}`}
              key={index}
            >
              <div className="voice-rows__identity">
                <span className="voice-rows__key" style={{ color: seriesColor(index) }} />
                <CommittedField
                  label={`Name of voice ${index + 1}`}
                  labelHidden
                  value={voice.description}
                  onCommit={(value) =>
                    onCommit(updateVoice(schedule, index, { description: value }), 'Rename voice')
                  }
                />
              </div>

              <p className="voice-rows__meta">
                {badge && <span className="voice-rows__badge">{badge}</span>}
                {nodes} {nodes === 1 ? 'node' : 'nodes'} · {formatClock(own)}
                {own - playback > DURATION_EPSILON && (
                  <span className="voice-rows__badge"> cut short at {formatClock(playback)}</span>
                )}
              </p>

              {/* The first node is the reference: retuning a voice means moving the whole curve, so
                  typing a new carrier here shifts every node by the same amount. */}
              {first && (
                <div className="voice-rows__tune">
                  <CommittedField
                    label="Base (Hz)"
                    value={formatHz(first.baseFreq)}
                    numeric
                    hint={`Shifts all ${nodes} ${nodes === 1 ? 'node' : 'nodes'} by the same amount`}
                    onCommit={(value) => {
                      const next = transposeVoice(schedule, {
                        voice: index,
                        delta: numberOr(value, first.baseFreq) - first.baseFreq,
                      });
                      if (next !== schedule) onCommit(next, 'Shift base frequency');
                    }}
                  />
                </div>
              )}

              <div className="voice-rows__controls">
                <button
                  type="button"
                  className={`voice-rows__toggle voice-rows__toggle--icon${voice.muted ? ' is-active' : ''}`}
                  title={muteLabel}
                  aria-pressed={voice.muted}
                  onClick={() =>
                    onCommit(
                      updateVoice(schedule, index, { muted: !voice.muted }),
                      voice.muted ? 'Unmute voice' : 'Mute voice',
                    )
                  }
                >
                  {voice.muted ? <SpeakerOffIcon /> : <SpeakerOnIcon />}
                  <span className="visually-hidden">{muteLabel}</span>
                </button>
                <Toggle
                  label="Hide"
                  active={voice.hidden}
                  onClick={() =>
                    onCommit(
                      updateVoice(schedule, index, { hidden: !voice.hidden }),
                      voice.hidden ? 'Show voice' : 'Hide voice',
                    )
                  }
                />
                {/* No explicit selection: these carry it through the map, so moving one voice
                    cannot pull the selection off a node in another. */}
                <Action
                  label="Move up"
                  disabled={index === 0}
                  onClick={() =>
                    onStructural(moveVoice(schedule, { from: index, to: index - 1 }), 'Move voice')
                  }
                />
                <Action
                  label="Move down"
                  disabled={index === voices.length - 1}
                  onClick={() =>
                    onStructural(moveVoice(schedule, { from: index, to: index + 1 }), 'Move voice')
                  }
                />
                {/* IsoPulse and IsoPulseAlt are a type change, not separate voices, so toggling
                    crossfades rather than cutting. */}
                {isochronicType(voice.type) && (
                  <Toggle
                    label="Alternate ears"
                    active={voice.type === VoiceType.IsoPulseAlt}
                    onClick={() =>
                      onCommit(
                        updateVoice(schedule, index, {
                          type:
                            voice.type === VoiceType.IsoPulseAlt
                              ? VoiceType.IsoPulse
                              : VoiceType.IsoPulseAlt,
                        }),
                        voice.type === VoiceType.IsoPulseAlt
                          ? 'Pulse in both ears'
                          : 'Alternate ears',
                      )
                    }
                  />
                )}
                {/* A voice with no entries is lost on reopen and shifts every later voice's
                    identity, and the gnaural-regroup repair can't fix that shape — only giving it a
                    node or deleting it can. */}
                {nodes === 0 && (
                  <Action
                    label="Add node"
                    onClick={() =>
                      onCommit(insertEntry(schedule, { voice: index, after: 0 }), 'Insert node')
                    }
                  />
                )}
                <Action
                  label="Delete"
                  onClick={() => onStructural(removeVoice(schedule, index), 'Delete voice')}
                />
              </div>
            </li>
          );
        })}
      </ul>

      <div className="editor__row">
        <button type="button" className="button" onClick={() => add('tone')}>
          Add tone voice
        </button>
        <button type="button" className="button" onClick={() => add('isochronic')}>
          Add isochronic voice
        </button>
        <button type="button" className="button" onClick={() => add('noise')}>
          Add noise voice
        </button>
        <button type="button" className="button" onClick={() => add('water')}>
          Add water drops voice
        </button>
        <button type="button" className="button" onClick={() => add('rain')}>
          Add rain voice
        </button>
      </div>
    </section>
  );
}

function isochronicType(type: VoiceType): boolean {
  return type === VoiceType.IsoPulse || type === VoiceType.IsoPulseAlt;
}

function Toggle({ label, active, onClick }: { label: string; active: boolean; onClick(): void }) {
  return (
    <button
      type="button"
      className={`voice-rows__toggle${active ? ' is-active' : ''}`}
      aria-pressed={active}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

// Unlike Toggle, has no aria-pressed: a one-shot command has no state to be in.
function Action({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled?: boolean;
  onClick(): void;
}) {
  return (
    <button type="button" className="voice-rows__toggle" disabled={disabled} onClick={onClick}>
      {label}
    </button>
  );
}
