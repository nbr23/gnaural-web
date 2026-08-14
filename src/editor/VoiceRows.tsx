import { formatClock } from '../app/format';
import { SpeakerOffIcon, SpeakerOnIcon } from '../app/icons';
import type { VoiceEdit, VoiceKind } from '../document/edit';
import { insertEntry, insertVoice, moveVoice, removeVoice, updateVoice } from '../document/edit';
import { DURATION_EPSILON, scheduleDuration, voiceDuration } from '../document/timing';
import type { Schedule } from '../document/types';
import { VoiceType } from '../document/types';
import { seriesColor } from '../viz/palette';
import { CommittedField } from './CommittedField';
import type { NodeRef } from './history';

export interface VoiceRowsProps {
  schedule: Schedule;
  onCommit(schedule: Schedule, label: string): void;
  /** Omit `selection` to carry the current one across the edit's own voice map. */
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

/**
 * §6.1's "per-voice mute / solo / hide / rename / reorder; add and remove voices".
 *
 * **Its own component rather than a configured `player/VoiceList`**, which reads the same and is a
 * different thing: that list is runtime state that never touches the file, this one is mostly the
 * document. Same reasoning that gave Live mode its own view instead of a configured `PlayerView`.
 *
 * **Every control here is the document; none of it is session state.** Solo lives in the player
 * instead, and only there: it means "mute the others", so in a list whose mute *is* `voice_mute` it
 * could only work by editing the program you are authoring — a listening gesture that lands in the
 * undo history and in the saved file. A *session* mute is not offered beside the document one
 * either: the two do the identical audible thing and differ only invisibly, in whether they reach
 * the file, and two controls that look alike and differ invisibly is worse than one.
 * `adoptDocumentMutes` makes the flag audible the moment it is toggled.
 *
 * **Reorder is buttons, not drag-and-drop**: there is no hover on a phone, a second drag system
 * beside a chart that captures the pointer is asking for trouble, buttons are keyboard-operable for
 * free, and the corpus tops out at five voices.
 */
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
                {/* §3.7 made local: the shortest voice ends the whole programme. */}
                {own - playback > DURATION_EPSILON && (
                  <span className="voice-rows__badge"> cut short at {formatClock(playback)}</span>
                )}
              </p>

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
                {/* Types 3 and 4 are one voice type with a switch, not two things to add: the
                    only difference is whether each pulse lands in both ears or alternates between
                    them. It is a `type` change, so the engine crossfades rather than cutting. */}
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
                {/* The one shape the `gnaural-regroup` repair cannot reach: a voice with no
                    entries contributes no datapoint whatever its id, so Gnaural loses it on reopen
                    and every voice after it takes the wrong name, type and flags. Giving it a node
                    or deleting it are the only two answers, and both are here.
                    `insertEntry` has repaired an empty voice since step 6. */}
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
      </div>
    </section>
  );
}

/** Whether this voice is one of the pair the Alternate-ears toggle switches between. */
function isochronicType(type: VoiceType): boolean {
  return type === VoiceType.IsoPulse || type === VoiceType.IsoPulseAlt;
}

/** A flag that is either on or off, so it reports its state rather than just its name. */
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

/** A one-shot command. Deliberately not `aria-pressed`: it has no state to be in. */
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
