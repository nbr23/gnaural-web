import { useState } from 'react';
import { formatClock, numberOr } from '../app/format';
import type { MoveMode } from '../document/edit';
import { moveEntries, removeEntries, scaleEntries } from '../document/edit';
import { entryStartTimes } from '../document/timing';
import type { Schedule } from '../document/types';
import type { Selection } from './history';

export interface GroupPanelProps {
  schedule: Schedule;
  selected: Selection;
  mode: MoveMode;
  onCommit(schedule: Schedule, label: string): void;
  /** An edit that moves the node indices, so it says where the selection should land. */
  onCommitAt(schedule: Schedule, label: string, selection: Selection): void;
}

/**
 * What replaces `NodePanel` when a marquee has selected more than one node.
 *
 * **Exact values stop making sense at two nodes**, which is why this is a different panel rather
 * than a wider one: §6.1 asks for a numeric panel for *the selected node*, and with several there is
 * no single base frequency to type. What generalises is not the value but the *operation* — move the
 * whole selection, stretch it, delete it — so those are what this offers, as typed fields for the
 * same reason §6.1 wanted typed fields at all: a drag is imprecise.
 *
 * Both operations obey the squeeze/ripple control, and the panel says which is in force, because
 * that is what decides whether the program's length changes (§3.7).
 */
export function GroupPanel({ schedule, selected, mode, onCommit, onCommitAt }: GroupPanelProps) {
  const [shift, setShift] = useState('10');
  const [factor, setFactor] = useState('1.5');

  const voices = new Set(selected.map((node) => node.voice));
  const span = selectionSpan(schedule, selected);
  const scalable = [...voices].some(
    (voice) => selected.filter((node) => node.voice === voice).length > 1,
  );

  const move = (seconds: number) => {
    const next = moveEntries(schedule, { nodes: selected, deltaTime: seconds, mode });
    if (next !== schedule) onCommit(next, 'Move nodes');
  };

  const scale = (by: number) => {
    const next = scaleEntries(schedule, { nodes: selected, factor: by, mode });
    if (next !== schedule) onCommit(next, 'Scale selection');
  };

  return (
    <section className="editor__fields">
      <h2>
        {selected.length} nodes in {voices.size} {voices.size === 1 ? 'voice' : 'voices'}
      </h2>

      <p className="editor__hint">
        {span ? `${formatClock(span.start)} to ${formatClock(span.end)}. ` : ''}
        {mode === 'squeeze'
          ? 'Squeezing: the segment after the selection gives and takes the time, so the program stays the same length.'
          : 'Rippling: everything after the selection moves with it, so the program gets longer or shorter.'}
      </p>

      <div className="editor__row">
        <label className="editor__field">
          <span>Move by (s)</span>
          <input
            type="number"
            inputMode="decimal"
            value={shift}
            onChange={(event) => setShift(event.target.value)}
          />
        </label>
        <button type="button" className="button" onClick={() => move(-numberOr(shift, 0))}>
          ← Earlier
        </button>
        <button type="button" className="button" onClick={() => move(numberOr(shift, 0))}>
          Later →
        </button>
      </div>

      <div className="editor__row">
        <label className="editor__field">
          <span>Scale ×</span>
          <input
            type="number"
            inputMode="decimal"
            step="0.1"
            min="0"
            value={factor}
            onChange={(event) => setFactor(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="button"
          disabled={!scalable}
          onClick={() => scale(numberOr(factor, 1))}
        >
          Stretch
        </button>
        <button
          type="button"
          className="button"
          disabled={!scalable}
          onClick={() => {
            const by = numberOr(factor, 1);
            if (by > 0) scale(1 / by);
          }}
        >
          Compress
        </button>
      </div>

      {!scalable && (
        <p className="editor__hint">
          Scaling stretches the time between selected nodes, so it needs at least two in one voice.
        </p>
      )}

      <div className="node-panel__actions">
        <button
          type="button"
          className="button"
          onClick={() => {
            const next = removeEntries(schedule, selected);
            if (next === schedule) return;
            const lowest = selected.reduce((low, node) => Math.min(low, node.entry), Infinity);
            onCommitAt(next, 'Delete nodes', [
              { voice: selected[0].voice, entry: Math.max(0, lowest - 1) },
            ]);
          }}
        >
          Delete {selected.length} nodes
        </button>
      </div>

      {/* The floor step 6 established, stated where a group delete can meet it: Gnaural rebuilds
          voices from their entries, so a voice contributing none takes every later voice's identity
          with it. */}
      <p className="editor__hint">Each voice keeps at least one node.</p>
    </section>
  );
}

/** The selection's extent in schedule time, for a panel that has no chart of its own. */
function selectionSpan(
  schedule: Schedule,
  selected: Selection,
): { start: number; end: number } | null {
  let start = Infinity;
  let end = -Infinity;

  for (const node of selected) {
    const voice = schedule.voices[node.voice];
    const at = voice ? entryStartTimes(voice)[node.entry] : undefined;
    if (at === undefined) continue;
    start = Math.min(start, at);
    end = Math.max(end, at);
  }

  return Number.isFinite(start) ? { start, end } : null;
}

