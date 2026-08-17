import { formatClock, numberOr } from '../app/format';
import type { MoveMode } from '../document/edit';
import { insertEntry, moveEntry, removeEntry, updateEntry } from '../document/edit';
import { entryStartTimes } from '../document/timing';
import type { Schedule } from '../document/types';
import { VoiceType } from '../document/types';
import { CommittedField } from './CommittedField';
import type { NodeRef } from './history';

export interface NodePanelProps {
  schedule: Schedule;
  selected: NodeRef | null;
  mode: MoveMode;
  onCommit(schedule: Schedule, label: string): void;
  onCommitAt(schedule: Schedule, label: string, selection: readonly NodeRef[]): void;
}

// Start goes through moveEntry and obeys the squeeze/ripple mode, so typing and dragging are the
// same edit by two routes. Duration is the field the file actually carries, and changing it ripples
// everything after it within the voice.
export function NodePanel({ schedule, selected, mode, onCommit, onCommitAt }: NodePanelProps) {
  const voice = selected ? schedule.voices[selected.voice] : undefined;
  const entry = selected && voice ? voice.entries[selected.entry] : undefined;

  if (!selected || !voice || !entry) {
    return (
      <section className="editor__fields">
        <h2>Node</h2>
        <p className="editor__hint">
          Tap a node on the chart to edit it exactly. Tap anywhere else to move the playhead there.
        </p>
      </section>
    );
  }

  const starts = entryStartTimes(voice);
  const start = starts[selected.entry];
  const isFirst = selected.entry === 0;
  const isLast = selected.entry === voice.entries.length - 1;
  // Refused, not warned: Gnaural groups entries into voices by their `parent` attribute and takes
  // each voice's properties by document order, so a voice contributing no entry does not merely
  // vanish on reopen — every voice after it takes the wrong slot's name, type and flags.
  const isOnly = voice.entries.length === 1;
  const label = voice.description.trim() || `Voice ${voice.id}`;
  // On a water voice these two fields are not a carrier and a rate at all: `basefreq` is the chance
  // per sample that a drop starts and `beatfreq` is how many can overlap, read from the first node
  // alone (§3.3). Labelling them in Hz would be the panel stating something untrue.
  const drops = voice.type === VoiceType.WaterDrops || voice.type === VoiceType.Rain;

  const patch = (commitLabel: string, next: Schedule) => onCommit(next, commitLabel);

  return (
    <section className="editor__fields">
      <h2>
        Node {selected.entry + 1} of {voice.entries.length} — {label}
      </h2>

      {/* Insert is a command on the selected node rather than a click on empty space: empty space
          can't say which voice it means once there's more than one. */}
      <div className="node-panel__actions">
        <button
          type="button"
          className="button"
          onClick={() =>
            onCommitAt(
              insertEntry(schedule, { voice: selected.voice, after: selected.entry }),
              'Insert node',
              [{ voice: selected.voice, entry: selected.entry + 1 }],
            )
          }
        >
          Insert node after
        </button>
        <button
          type="button"
          className="button"
          disabled={isOnly}
          onClick={() =>
            onCommitAt(
              removeEntry(schedule, { voice: selected.voice, entry: selected.entry }),
              'Delete node',
              [{ voice: selected.voice, entry: Math.max(0, selected.entry - 1) }],
            )
          }
        >
          Delete node
        </button>
      </div>

      <p className="editor__hint">
        {isOnly
          ? 'A voice needs at least one node. Delete the voice itself to remove it.'
          : 'Inserting splits the segment after this node, leaving the curve and the length exactly as they are. Deleting gives the time back to the neighbouring node.'}
      </p>

      <div className="editor__row">
        <CommittedField
          label="Start (s)"
          value={isFirst ? '0' : String(round(start))}
          numeric
          readOnly={isFirst}
          hint={isFirst ? 'The first node always starts the voice' : formatClock(start)}
          onCommit={(value) =>
            patch(
              'Move node',
              moveEntry(schedule, {
                voice: selected.voice,
                entry: selected.entry,
                time: numberOr(value, start),
                mode,
              }),
            )
          }
        />
        <CommittedField
          label="Duration (s)"
          value={String(round(entry.duration))}
          numeric
          hint={isLast ? 'Glides back to the first node (§3.5)' : undefined}
          onCommit={(value) =>
            patch(
              'Change duration',
              updateEntry(schedule, selected.voice, selected.entry, {
                duration: Math.max(0, numberOr(value, entry.duration)),
              }),
            )
          }
        />
      </div>

      <div className="editor__row">
        <CommittedField
          label={drops ? 'Drop chance' : 'Base (Hz)'}
          value={String(drops ? round(entry.baseFreq, 1e6) : round(entry.baseFreq))}
          numeric
          hint={drops ? 'Chance per sample that a drop starts' : undefined}
          onCommit={(value) =>
            patch(
              'Change base frequency',
              updateEntry(schedule, selected.voice, selected.entry, {
                baseFreq: numberOr(value, entry.baseFreq),
              }),
            )
          }
        />
        <CommittedField
          label={drops ? 'Drops' : 'Beat (Hz)'}
          value={String(round(entry.beatFreq))}
          numeric
          hint={drops && !isFirst ? 'Only the first node’s count is used' : undefined}
          onCommit={(value) =>
            patch(
              'Change beat frequency',
              updateEntry(schedule, selected.voice, selected.entry, {
                beatFreq: numberOr(value, entry.beatFreq),
              }),
            )
          }
        />
        <CommittedField
          label="Volume left"
          value={String(round(entry.volumeLeft))}
          numeric
          onCommit={(value) =>
            patch(
              'Change node volume',
              updateEntry(schedule, selected.voice, selected.entry, {
                volumeLeft: numberOr(value, entry.volumeLeft),
              }),
            )
          }
        />
        <CommittedField
          label="Volume right"
          value={String(round(entry.volumeRight))}
          numeric
          onCommit={(value) =>
            patch(
              'Change node volume',
              updateEntry(schedule, selected.voice, selected.entry, {
                volumeRight: numberOr(value, entry.volumeRight),
              }),
            )
          }
        />
      </div>
    </section>
  );
}

// A water voice's drop chance needs more precision than the 1e4 default: the reference default of
// 0.000352858 would otherwise read as 0.0004.
function round(value: number, precision = 1e4): number {
  return Math.round(value * precision) / precision;
}

