import type { Schedule } from '../document/types';

// The command stack — React-free, DOM-free, testable in Node.
//
// Stores whole documents rather than inverse commands: Schedule is immutable and the transforms
// reuse everything they don't touch, so a snapshot after an entry drag costs about a kilobyte
// (worst case ~37kB for a generator or duration scale, ~7MB at HISTORY_LIMIT — negligible next to
// the audio buffers export already allocates). Inverse commands would save that memory at the cost
// of being hard to write correctly for generators and multi-node drags, where a wrong inverse
// corrupts silently instead of failing.
//
// Knows nothing about gestures: a drag holds its in-flight document in its own state and commits
// once on pointerup, since the engine/chart and the autosave/validation paths want different
// documents (in-flight vs committed) and a merged stack would force every consumer to un-merge them.

// Voices are keyed by index, not id: ids are not guaranteed unique in real files, which is the
// same keying the engine's session mute/solo uses.
export interface NodeRef {
  voice: number;
  entry: number;
}

export type Selection = readonly NodeRef[];

export interface CommitMeta {
  // For an "Undo move node" affordance.
  label: string;
  // The selection as it stood when this commit was made, so undoing a delete restores it. Never
  // part of Schedule itself, since the document is kept to what a .gnaural file can express.
  selection?: Selection;
  // Where each voice of the previous document ended up in this one, for a structural edit that
  // reorders or deletes voices — the engine keys session mute/solo by index, so without this an
  // insert would silently reassign another voice's gates. This is the one place the stack still
  // needs a delta, since undo has to apply its inverse and a document alone can't say what moved.
  voiceMap?: readonly number[];
}

// Oldest is dropped rather than newest refused — an editor that stops accepting edits is worse
// than one that forgets the beginning of a long session.
export const HISTORY_LIMIT = 200;

interface HistoryEntry {
  schedule: Schedule;
  // Null for the document the stack was opened with — nothing produced it, so nothing undoes it.
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

  get presentMeta(): CommitMeta | null {
    return this.entries[this.index].meta;
  }

  // Bumped by every change, for useSyncExternalStore subscribers: unlike `present`, this can't be
  // defeated by a future commit that happens to re-push an identical document.
  get version(): number {
    return this.revision;
  }

  get canUndo(): boolean {
    return this.index > 0;
  }

  get canRedo(): boolean {
    return this.index < this.entries.length - 1;
  }

  get undoLabel(): string | null {
    return this.canUndo ? this.entries[this.index].meta?.label ?? null : null;
  }

  get redoLabel(): string | null {
    return this.canRedo ? this.entries[this.index + 1].meta?.label ?? null : null;
  }

  // Pushes a new present, dropping anything that had been undone. A commit of the document that's
  // already present is ignored — an undo step that undoes nothing is worse than no step at all.
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
