import { formatClock } from '../app/format';
import type { MoveMode } from '../document/edit';
import { insertEntry, moveEntry, removeEntry, updateEntry } from '../document/edit';
import { entryStartTimes } from '../document/timing';
import type { Schedule } from '../document/types';
import { CommittedField } from './CommittedField';
import type { NodeRef } from './history';

export interface NodePanelProps {
  schedule: Schedule;
  selected: NodeRef | null;
  mode: MoveMode;
  onCommit(schedule: Schedule, label: string): void;
  /** An edit that moves the node indices, so it says where the selection should land. */
  onCommitAt(schedule: Schedule, label: string, selection: NodeRef | null): void;
}

/**
 * Exact values for the selected node (§6.1: "dragging is imprecise and people want exact values").
 *
 * It is also the way out of the drag's one real limit: a drag can only reach what is drawn, and the
 * lane's domain is fitted to the data with headroom. Anything outside that is typed here.
 *
 * **Start and duration are both editable and they are different operations.** Start is where the
 * chart's x-axis puts the node, so it goes through `moveEntry` and obeys the squeeze/ripple mode —
 * typing and dragging are then the same edit by two routes. Duration is the field the file actually
 * carries, and changing it necessarily ripples everything after it within the voice.
 *
 * Committed on blur, by reusing the header's own field: per-keystroke commits would make undo walk
 * back through a number one digit at a time, and would push a document at the engine per keystroke.
 */
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

  const patch = (commitLabel: string, next: Schedule) => onCommit(next, commitLabel);

  return (
    <section className="editor__fields">
      <h2>
        Node {selected.entry + 1} of {voice.entries.length} — {label}
      </h2>

      {/* §6.1 asks for a click on empty space to insert. That gesture is not available: step 5 gave
          a pointer that misses a node to seeking and reserved the move for a marquee, and — the
          larger reason — empty space cannot say *which* voice it means, and 12 of the 19 bundled
          programs have more than one. So insert is a command on the node you already picked. */}
      <div className="node-panel__actions">
        <button
          type="button"
          className="button"
          onClick={() =>
            onCommitAt(
              insertEntry(schedule, { voice: selected.voice, after: selected.entry }),
              'Insert node',
              { voice: selected.voice, entry: selected.entry + 1 },
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
              { voice: selected.voice, entry: Math.max(0, selected.entry - 1) },
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
          label="Base (Hz)"
          value={String(round(entry.baseFreq))}
          numeric
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
          label="Beat (Hz)"
          value={String(round(entry.beatFreq))}
          numeric
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

/** Enough digits for the presets' 0.001 s entries, without showing a float's full tail. */
function round(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

function numberOr(value: string, fallback: number): number {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}
