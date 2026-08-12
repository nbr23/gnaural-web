import { formatClock } from '../app/format';
import type { VoiceEdit, VoiceKind } from '../document/edit';
import { insertVoice, moveVoice, removeVoice, updateVoice } from '../document/edit';
import { DURATION_EPSILON, scheduleDuration, voiceDuration } from '../document/timing';
import type { Schedule } from '../document/types';
import { VoiceType } from '../document/types';
import { scheduleWarnings } from '../document/warnings';
import type { VoiceGate } from '../player/usePlayer';
import { seriesColor } from '../viz/palette';
import { CommittedField } from './CommittedField';
import type { NodeRef } from './history';

export interface VoiceRowsProps {
  schedule: Schedule;
  /** Session state, read for `Solo` only — the one control here the format has no field for. */
  gates: VoiceGate[];
  onCommit(schedule: Schedule, label: string): void;
  /** Omit `selection` to carry the current one across the edit's own voice map. */
  onStructural(edit: VoiceEdit, label: string, selection?: NodeRef | null): void;
  onToggleSolo(index: number): void;
}

const TYPE_LABELS: Partial<Record<VoiceType, string>> = {
  [VoiceType.PinkNoise]: 'noise',
  [VoiceType.Pcm]: 'external audio',
  [VoiceType.IsoPulse]: 'isochronic',
  [VoiceType.IsoPulseAlt]: 'isochronic',
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
 * **Mute and Hide are the document's own flags; Solo is the only session control here.** That is
 * the whole rule, and the caption says it. A *session* mute is deliberately not offered beside the
 * document one: the two do the identical audible thing and differ only invisibly, in whether they
 * reach the file, and two controls that look alike and differ invisibly is worse than one. The
 * editor is the place where the document's flag is the one you mean; `adoptDocumentMutes` makes it
 * audible the moment it is toggled, without disturbing a listener's solo.
 *
 * **Reorder is buttons, not drag-and-drop**: there is no hover on a phone, a second drag system
 * beside a chart that captures the pointer is asking for trouble, buttons are keyboard-operable for
 * free, and the corpus tops out at five voices.
 */
export function VoiceRows({
  schedule,
  gates,
  onCommit,
  onStructural,
  onToggleSolo,
}: VoiceRowsProps) {
  const voices = schedule.voices;
  const playback = scheduleDuration(schedule);
  // The one message this step can newly cause. Taken from the shared producer rather than written
  // here, so the editor and the player cannot come to word it differently. Step 7's inline
  // validation is where the rest of the surface arrives.
  const empty = scheduleWarnings(schedule).find((warning) => warning.kind === 'nothing-to-play');

  const add = (kind: VoiceKind) => {
    const edit = insertVoice(schedule, { kind });
    onStructural(edit, 'Add voice', { voice: edit.schedule.voices.length - 1, entry: 0 });
  };

  return (
    <section className="editor__fields">
      <h2>Voices</h2>
      <p className="editor__hint">
        Mute and hide are saved with the program. Solo is just for listening and is never written to
        the file.
      </p>

      {empty && <p className="editor__hint editor__hint--warn">{empty.message}</p>}

      <ul className="voice-rows">
        {voices.map((voice, index) => {
          const own = voiceDuration(voice);
          const badge = TYPE_LABELS[voice.type];
          const nodes = voice.entries.length;

          return (
            <li className="voice-rows__row" key={index}>
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
                <Toggle
                  label="Mute"
                  active={voice.muted}
                  onClick={() =>
                    onCommit(
                      updateVoice(schedule, index, { muted: !voice.muted }),
                      voice.muted ? 'Unmute voice' : 'Mute voice',
                    )
                  }
                />
                <Toggle
                  label="Solo"
                  active={gates[index]?.soloed ?? false}
                  onClick={() => onToggleSolo(index)}
                />
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
        <button type="button" className="button" onClick={() => add('noise')}>
          Add noise voice
        </button>
      </div>
    </section>
  );
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
