import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import type { Schedule } from '../document/types';
import type { VoiceMap } from '../document/voiceMap';
import { invertVoiceMap } from '../document/voiceMap';
import type { CommitMeta, NodeRef, Selection } from './history';
import { HistoryStack } from './history';

export interface Editor {
  /**
   * The committed document — what is rendered, validated, autosaved and handed the engine.
   *
   * **It stays a single field, reversing what step 4 expected.** That entry predicted a split into
   * `preview ?? committed` once dragging landed, on the grounds that the chart and the engine want
   * what the finger is doing while autosave and validation want the last decision. The premise is
   * right and the conclusion was wrong: publishing an in-flight document here would hand it to every
   * consumer of the editor, re-rendering the whole tree — including the chart, whose memoised model
   * and layout are the reason a playhead does not starve the audio thread. A gesture keeps its
   * in-flight document to itself, in `EditSurface`, and gives the engine a throttled copy that
   * renders nothing. See PROGRESS.md for the measurement.
   */
  document: Schedule;
  /**
   * Push a new document. A transform that changed nothing returns its input, and is ignored.
   *
   * The current selection travels with the commit, so undoing a move restores what was selected
   * when it was made; the caller does not supply it.
   */
  commit(schedule: Schedule, meta: CommitMeta): void;
  /**
   * Where each voice of the previously published document ended up in this one, or null when
   * nothing moved.
   *
   * The one thing a consumer cannot work out for itself: the engine keys session mute and solo by
   * voice index, and two documents do not say which voice became which. Set by a structural commit,
   * **inverted** on undo and taken as-is on redo — the same transition-not-state reading the
   * selection restore below documents.
   */
  voiceMap: VoiceMap | null;
  /**
   * The selected nodes, empty for none. Session state: changing it never pushes a commit.
   *
   * Plural since step 8's marquee, which is what `Selection` and `CommitMeta.selection` have been
   * shaped for since step 4. Order is the document's, not the order they were picked in: a group
   * edit reads it as a set of addresses, and nothing downstream cares which node was first.
   */
  selection: Selection;
  select(selection: Selection): void;
  undo(): void;
  redo(): void;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
}

/**
 * The React face of `HistoryStack` — a thin one, deliberately: everything that can be decided
 * without React is decided in `history.ts`, which is why the stack is testable in Node.
 *
 * **The initial document is read once.** After that the editor owns the document, so a later change
 * to the argument is not a new state to merge but a different program — mount a new editor for it
 * (`key` on the view), rather than trying to reconcile two histories.
 *
 * Re-renders happen on commit, undo and redo, and on nothing else. That matters here as much as it
 * does in the player: `CLOCK_INTERVAL_MS` and `StaticPlot` exist because re-rendering this tree at
 * pointer rate is enough main-thread work to starve the audio thread on a phone, and a history hook
 * that published every intermediate value would be the same defect in a new place.
 */
export function useEditor(initial: Schedule): Editor {
  const [stack] = useState(() => new HistoryStack(initial));
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  // The commit needs the selection as it stands right now, not as of the render that produced the
  // callback — a drag selects and commits within one gesture.
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  useSyncExternalStore(
    useCallback((listener) => stack.subscribe(listener), [stack]),
    () => stack.version,
  );

  // Not state: it is read once by the effect that pushes the document at the engine, in the same
  // render the document changed. Making it state would be a second re-render for a value no view
  // displays.
  const voiceMap = useRef<VoiceMap | null>(null);

  const commit = useCallback(
    (schedule: Schedule, meta: CommitMeta) => {
      const nodes = selectionRef.current;
      const before = stack.present;
      stack.commit(schedule, { selection: nodes.length > 0 ? nodes : undefined, ...meta });
      // Only if it was taken: `commit` ignores a document that is already present.
      if (stack.present !== before) voiceMap.current = meta.voiceMap ?? null;
    },
    [stack],
  );

  const select = useCallback(
    (next: Selection) => setSelection(next.length > 0 ? next : EMPTY_SELECTION),
    [],
  );

  /**
   * Navigating the history restores the selection the *commit being crossed* was made with.
   *
   * A commit's meta describes a transition, not a state, so undo and redo both read the entry on the
   * far side of it — which for an undo is the one being left. Reading the entry arrived at instead
   * looks equivalent and is not: undoing the very first edit lands on the opening document, which
   * nothing produced and which therefore carries no selection, so the node you were working on would
   * be deselected exactly when you were about to try again. §6.1's "undoing a delete restores the
   * selection it had" means the selection the delete had.
   */
  const undo = useCallback(() => {
    if (!stack.canUndo) return;
    const crossed = stack.presentMeta;
    const undone = stack.present;
    stack.undo();
    voiceMap.current = crossed?.voiceMap
      ? invertVoiceMap(crossed.voiceMap, undone.voices.length)
      : null;
    setSelection(inRange(crossed?.selection, stack.present));
  }, [stack]);

  /**
   * Redo restores the selection that commit was made *with*, which is a pre-edit selection landing
   * in a post-edit document — so unlike undo it has to be carried across the transition. A voice the
   * commit deleted has nowhere to land and the selection goes.
   */
  const redo = useCallback(() => {
    if (!stack.canRedo) return;
    stack.redo();
    const meta = stack.presentMeta;
    voiceMap.current = meta?.voiceMap ?? null;
    setSelection(inRange(moveSelection(meta?.selection, meta?.voiceMap), stack.present));
  }, [stack]);

  return {
    document: stack.present,
    commit,
    voiceMap: voiceMap.current,
    selection,
    select,
    undo,
    redo,
    canUndo: stack.canUndo,
    canRedo: stack.canRedo,
    undoLabel: stack.undoLabel,
    redoLabel: stack.redoLabel,
  };
}

/**
 * One empty selection, shared.
 *
 * Not a fresh `[]` per call: `EditSurface` and the chart's `memo`'d selection layer both key off
 * this array's identity, so a new empty one per render would rebuild every ring in the plot for a
 * selection that has not changed.
 */
const EMPTY_SELECTION: Selection = [];

/** Follow a selection across a structural transition. A deleted voice takes its nodes with it. */
function moveSelection(selection: Selection | undefined, map: VoiceMap | undefined): Selection {
  if (!selection) return EMPTY_SELECTION;
  if (!map) return selection;

  return selection.flatMap((node) => {
    const voice = map[node.voice];
    return voice === undefined || voice < 0 ? [] : [{ voice, entry: node.entry }];
  });
}

/**
 * Keep a restored selection pointing at things that exist.
 *
 * A `NodeRef` is a pair of indices and a history move can land on a document with fewer of either,
 * so this is the backstop that keeps stale ones out of the views. Entries are clamped rather than
 * dropped: after undoing a delete the node one along is the useful place to be, and losing the
 * selection is what step 5's own selection defect felt like. Clamping can collide two nodes onto
 * one, so the result is deduplicated.
 */
function inRange(selection: Selection | null | undefined, schedule: Schedule): Selection {
  if (!selection || selection.length === 0) return EMPTY_SELECTION;

  const seen = new Map<string, NodeRef>();
  for (const node of selection) {
    const voice = schedule.voices[node.voice];
    if (!voice || voice.entries.length === 0) continue;

    const entry = Math.min(Math.max(0, node.entry), voice.entries.length - 1);
    seen.set(`${node.voice}:${entry}`, entry === node.entry ? node : { voice: node.voice, entry });
  }

  return seen.size > 0 ? [...seen.values()] : EMPTY_SELECTION;
}
