import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import type { Schedule } from '../document/types';
import type { VoiceMap } from '../document/voiceMap';
import { invertVoiceMap } from '../document/voiceMap';
import type { CommitMeta, NodeRef, Selection } from './history';
import { HistoryStack } from './history';

export interface Editor {
  // The committed document — what's rendered, validated, autosaved and handed to the engine.
  // Deliberately a single field rather than preview ?? committed: publishing an in-flight document
  // here would re-render the whole tree, including the chart's memoised model/layout. A gesture
  // keeps its in-flight document to itself in EditSurface and gives the engine a throttled copy.
  document: Schedule;
  // Pushes a new document; a transform that changed nothing returns its input and is ignored. The
  // current selection travels with the commit, so undoing a move restores what was selected then.
  commit(schedule: Schedule, meta: CommitMeta): void;
  // Where each voice of the previously published document ended up in this one, or null when
  // nothing moved — the engine keys session mute/solo by voice index, and two documents alone can't
  // say which voice became which. Inverted on undo, taken as-is on redo.
  voiceMap: VoiceMap | null;
  // Order is the document's, not pick order: a group edit reads it as a set of addresses.
  selection: Selection;
  select(selection: Selection): void;
  undo(): void;
  redo(): void;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
}

// The React face of HistoryStack, deliberately thin: everything decidable without React lives in
// history.ts. The initial document is read once — after that the editor owns it, so a later change
// to the argument is a different program, not a state to merge (mount a new editor via `key`).
// Re-renders happen only on commit, undo and redo; a history hook that published every intermediate
// drag value would starve the audio thread the same way an un-throttled chart would.
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

  // Restores the selection the commit *being crossed* was made with — the entry being left, not the
  // one arrived at. Reading the entry arrived at looks equivalent but isn't: undoing the first edit
  // lands on the opening document, which carries no selection, deselecting the node you were
  // working on right when you were about to try again.
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

  // Restores the selection that commit was made with — a pre-edit selection landing in a post-edit
  // document, so unlike undo it has to be carried across the transition via moveSelection.
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

// Shared rather than a fresh [] per call: the chart's memoised selection layer keys off this
// array's identity, so a new empty one per render would rebuild every ring for an unchanged selection.
const EMPTY_SELECTION: Selection = [];

// A voice a structural edit deleted takes its selected nodes with it.
function moveSelection(selection: Selection | undefined, map: VoiceMap | undefined): Selection {
  if (!selection) return EMPTY_SELECTION;
  if (!map) return selection;

  return selection.flatMap((node) => {
    const voice = map[node.voice];
    return voice === undefined || voice < 0 ? [] : [{ voice, entry: node.entry }];
  });
}

// Keeps a restored selection pointing at things that exist: a history move can land on a document
// with fewer voices or entries than the selection references. Entries are clamped rather than
// dropped — after undoing a delete, the node one along is the useful place to land — and clamping
// can collide two nodes onto one, so the result is deduplicated.
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
