import { describe, expect, it } from 'vitest';
import { voiceDuration } from '../document/timing';
import type { Entry, Schedule, Voice } from '../document/types';
import { VoiceType } from '../document/types';
import { setupRoot } from '../test-utils';
import { NodePanel } from './NodePanel';
import type { NodeRef } from './history';

function makeEntry(partial: Partial<Entry> = {}): Entry {
  return {
    duration: 100,
    baseFreq: 200,
    beatFreq: 8,
    volumeLeft: 0.5,
    volumeRight: 0.5,
    preserved: {},
    ...partial,
  };
}

function withEntries(entries: Entry[]): Schedule {
  const voice: Voice = {
    id: 0,
    description: 'Carrier',
    type: VoiceType.Binaural,
    muted: false,
    hidden: false,
    mono: false,
    entries,
    preserved: {},
  };
  return {
    title: 'Draft',
    description: '',
    author: '',
    loops: 1,
    masterVolume: { left: 1, right: 1 },
    stereoSwap: false,
    voices: [voice],
    preserved: {},
  };
}

const testRoot = setupRoot();

interface Harness {
  commits: { schedule: Schedule; label: string }[];
  commitsAt: { schedule: Schedule; label: string; selection: readonly NodeRef[] }[];
}

function mount(schedule: Schedule, selected: NodeRef | null) {
  const harness: Harness = { commits: [], commitsAt: [] };

  testRoot.render(
    <NodePanel
      schedule={schedule}
      selected={selected}
      mode="squeeze"
      onCommit={(next, label) => harness.commits.push({ schedule: next, label })}
      onCommitAt={(next, label, selection) =>
        harness.commitsAt.push({ schedule: next, label, selection })
      }
    />,
  );

  return harness;
}

function button(label: string): HTMLButtonElement {
  return testRoot.byText('button', label) as HTMLButtonElement;
}

describe('NodePanel', () => {
  it('offers nothing to insert into with no node selected', () => {
    mount(withEntries([makeEntry(), makeEntry()]), null);
    expect(testRoot.byText('button', 'Insert node after')).toBeUndefined();
  });

  /**
   * The insert splits the following segment, so the curve and the voice's length are exactly what
   * they were — what it adds is a handle.
   */
  it('inserts after the selected node without changing the length', () => {
    const schedule = withEntries([makeEntry({ duration: 100 }), makeEntry({ duration: 60 })]);
    const harness = mount(schedule, { voice: 0, entry: 0 });

    testRoot.click(button('Insert node after'));

    const { schedule: after, label, selection } = harness.commitsAt[0];
    expect(label).toBe('Insert node');
    expect(after.voices[0].entries.map((entry) => entry.duration)).toEqual([50, 50, 60]);
    expect(voiceDuration(after.voices[0])).toBe(voiceDuration(schedule.voices[0]));
    // The new node is the one to carry on editing.
    expect(selection).toEqual([{ voice: 0, entry: 1 }]);
  });

  it('deletes the selected node and leaves the neighbour selected', () => {
    const schedule = withEntries([makeEntry({ duration: 100 }), makeEntry({ duration: 60 })]);
    const harness = mount(schedule, { voice: 0, entry: 1 });

    testRoot.click(button('Delete node'));

    const { schedule: after, label, selection } = harness.commitsAt[0];
    expect(label).toBe('Delete node');
    expect(after.voices[0].entries.map((entry) => entry.duration)).toEqual([160]);
    expect(selection).toEqual([{ voice: 0, entry: 0 }]);
  });

  /** A voice with no entries mis-assigns every later voice's properties when Gnaural reopens it. */
  it('refuses to delete the only node of a voice, and says what to do instead', () => {
    mount(withEntries([makeEntry()]), { voice: 0, entry: 0 });

    expect(button('Delete node').disabled).toBe(true);
    expect(testRoot.text()).toContain('Delete the voice itself');
  });
});
