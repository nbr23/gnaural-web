import { useCallback, useState, useSyncExternalStore } from 'react';
import type { Schedule } from '../document/types';
import type { CommitMeta } from './history';
import { HistoryStack } from './history';

export interface Editor {
  /**
   * The document to render, to validate and to hand the engine.
   *
   * Today that is exactly the committed present. When node dragging lands it becomes
   * `preview ?? committed`: a gesture holds its in-flight document here without pushing a commit,
   * and `committed` becomes a second field, because the consumers genuinely differ — the chart and
   * the engine want what the finger is doing, autosave and the warning list want the last thing the
   * user actually decided.
   */
  document: Schedule;
  /** Push a new document. A transform that changed nothing returns its input, and is ignored. */
  commit(schedule: Schedule, meta: CommitMeta): void;
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

  useSyncExternalStore(
    useCallback((listener) => stack.subscribe(listener), [stack]),
    () => stack.version,
  );

  const commit = useCallback(
    (schedule: Schedule, meta: CommitMeta) => stack.commit(schedule, meta),
    [stack],
  );
  const undo = useCallback(() => stack.undo(), [stack]);
  const redo = useCallback(() => stack.redo(), [stack]);

  return {
    document: stack.present,
    commit,
    undo,
    redo,
    canUndo: stack.canUndo,
    canRedo: stack.canRedo,
    undoLabel: stack.undoLabel,
    redoLabel: stack.redoLabel,
  };
}
