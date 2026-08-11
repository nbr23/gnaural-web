import type { Schedule } from '../document/types';

/**
 * The command stack (PLAN.md §6.1) — React-free, DOM-free, and testable in Node, the same split
 * `viz/geometry.ts` keeps from `ScheduleChart.tsx`.
 *
 * **A stack of documents, not of inverse commands.** §6.1 allows either and the document model
 * decides it: `Schedule` is immutable and the transforms in `src/document/edit.ts` reuse everything
 * they do not touch, so a snapshot after an entry drag costs about a kilobyte. Measured against
 * `oobe-lucid-dreams-2` (3 voices, 77 entries each): ~1.1 kB per entry edit, so a full history of
 * them is ~220 kB, and the worst case — a generator or a duration scale that rebuilds every entry
 * in the document — is ~37 kB a step, ~7 MB at the cap. That is nothing beside the 423 MB
 * `AudioBuffer` a `powernap` export already allocates. Inverse commands would save that and cost
 * §6.3's requirement to undo generators and multi-node drags, which is exactly where an inverse is
 * hardest to write and where a wrong one corrupts silently instead of failing.
 *
 * **It knows nothing about gestures.** No `begin`/`preview`/`abort`: a drag holds its in-flight
 * document in its own state and commits once, on pointerup — the same place Live mode put its
 * slider state rather than in app-wide state. The two documents have genuinely different consumers
 * (the engine and the chart want the in-flight one; autosave and validation want the committed
 * one), so a stack that merged them would only force every consumer to un-merge them.
 */

/**
 * A node selection: entries addressed the way the document addresses them, by index into
 * `schedule.voices` and index into that voice's entries.
 *
 * Voices are keyed by index because §3.4's ids are not unique in real files, which is the same
 * keying the engine's session mute/solo uses.
 */
export interface NodeRef {
  voice: number;
  entry: number;
}

export type Selection = readonly NodeRef[];

export interface CommitMeta {
  /** What this commit did, for an "Undo move node" affordance. §6.1 wants named commands. */
  label: string;
  /**
   * The selection as it stood when this commit was made, so undoing a delete restores the selection
   * it had. Selection is never part of `Schedule`: it would have to survive the serializer, and §4.1
   * keeps the document to what a `.gnaural` file can express.
   */
  selection?: Selection;
  /**
   * Where each voice of the previous document ended up in this one, for a structural edit that
   * reorders or deletes voices. The engine keys session mute/solo by index, so without this an
   * insert silently reassigns another voice's gates.
   *
   * The one place a stack of documents still needs a delta: undo has to apply this map's inverse,
   * and a document cannot be asked what moved. Reserved here so the structural-edit step does not
   * have to reshape the stack; nothing builds a map yet.
   */
  voiceMap?: readonly number[];
}

/**
 * How many documents are kept. The oldest is dropped rather than the newest refused — an editor
 * that stops accepting edits is worse than one that forgets the beginning of a long session.
 */
export const HISTORY_LIMIT = 200;

interface HistoryEntry {
  schedule: Schedule;
  /** Null for the document the stack was opened with — nothing produced it, so nothing undoes it. */
  meta: CommitMeta | null;
}

export class HistoryStack {
  private entries: HistoryEntry[];
  private index = 0;
  private listeners = new Set<() => void>();
  private revision = 0;

  constructor(
    initial: Schedule,
    private readonly limit = HISTORY_LIMIT,
  ) {
    this.entries = [{ schedule: initial, meta: null }];
  }

  get present(): Schedule {
    return this.entries[this.index].schedule;
  }

  /** The metadata of the commit that produced the present, or null at the opening document. */
  get presentMeta(): CommitMeta | null {
    return this.entries[this.index].meta;
  }

  /**
   * Bumped by every change. What a `useSyncExternalStore` subscriber snapshots: `present` alone
   * would be a fine snapshot today, but a version cannot be defeated by a future commit that
   * happens to re-push an identical document.
   */
  get version(): number {
    return this.revision;
  }

  get canUndo(): boolean {
    return this.index > 0;
  }

  get canRedo(): boolean {
    return this.index < this.entries.length - 1;
  }

  /** What undo would reverse — the commit that produced the present. */
  get undoLabel(): string | null {
    return this.canUndo ? this.entries[this.index].meta?.label ?? null : null;
  }

  get redoLabel(): string | null {
    return this.canRedo ? this.entries[this.index + 1].meta?.label ?? null : null;
  }

  /**
   * Push a new present, dropping anything that had been undone.
   *
   * A commit of the document that is already present is ignored: the transforms return their input
   * unchanged when a patch changes nothing (retyping the same title), and an undo step that undoes
   * nothing is worse than no step at all.
   */
  commit(schedule: Schedule, meta: CommitMeta): void {
    if (schedule === this.present) return;

    this.entries.length = this.index + 1;
    this.entries.push({ schedule, meta });

    if (this.entries.length > this.limit) this.entries.shift();
    this.index = this.entries.length - 1;
    this.changed();
  }

  undo(): void {
    if (!this.canUndo) return;
    this.index -= 1;
    this.changed();
  }

  redo(): void {
    if (!this.canRedo) return;
    this.index += 1;
    this.changed();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private changed(): void {
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }
}
