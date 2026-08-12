import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import type { Schedule } from '../document/types';
import type { CommitMeta, NodeRef } from './history';
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
  /** The selected node, or null. Session state: changing it never pushes a commit. */
  selection: NodeRef | null;
  select(node: NodeRef | null): void;
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
  const [selection, setSelection] = useState<NodeRef | null>(null);
  // The commit needs the selection as it stands right now, not as of the render that produced the
  // callback — a drag selects and commits within one gesture.
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  useSyncExternalStore(
    useCallback((listener) => stack.subscribe(listener), [stack]),
    () => stack.version,
  );

  const commit = useCallback(
    (schedule: Schedule, meta: CommitMeta) => {
      const node = selectionRef.current;
      stack.commit(schedule, { selection: node ? [node] : undefined, ...meta });
    },
    [stack],
  );

  const select = useCallback((node: NodeRef | null) => setSelection(node), []);

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
    stack.undo();
    setSelection(crossed?.selection?.[0] ?? null);
  }, [stack]);

  const redo = useCallback(() => {
    if (!stack.canRedo) return;
    stack.redo();
    setSelection(stack.presentMeta?.selection?.[0] ?? null);
  }, [stack]);

  return {
    document: stack.present,
    commit,
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
