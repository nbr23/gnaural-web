import { describe, expect, it } from 'vitest';
import { entryStartTimes, voiceDuration } from '../document/timing';
import type { Entry, Schedule, Voice } from '../document/types';
import { VoiceType } from '../document/types';
import { setInputValue, setupRoot } from '../test-utils';
import { GroupPanel } from './GroupPanel';
import type { NodeRef, Selection } from './history';

const testRoot = setupRoot();

function makeVoice(id: number, durations: number[]): Voice {
  const entries = durations.map<Entry>((duration) => ({
    duration,
    baseFreq: 200,
    beatFreq: 10,
    volumeLeft: 0.5,
    volumeRight: 0.5,
    preserved: {},
  }));
  return {
    id,
    description: `Voice ${id}`,
    type: VoiceType.Binaural,
    muted: false,
    hidden: false,
    mono: false,
    entries,
    preserved: {},
  };
}

function schedule(): Schedule {
  return {
    title: 'Group',
    description: '',
    author: '',
    loops: 1,
    masterVolume: { left: 1, right: 1 },
    stereoSwap: false,
    voices: [makeVoice(0, [10, 20, 30, 40]), makeVoice(1, [10, 20, 30, 40])],
    preserved: {},
  };
}

interface Harness {
  commits: { schedule: Schedule; label: string }[];
  commitsAt: { schedule: Schedule; label: string; selection: readonly NodeRef[] }[];
}

function mount(selected: Selection, mode: 'squeeze' | 'ripple' = 'squeeze') {
  const harness: Harness = { commits: [], commitsAt: [] };
  testRoot.render(
    <GroupPanel
      schedule={schedule()}
      selected={selected}
      mode={mode}
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

const group: Selection = [
  { voice: 0, entry: 1 },
  { voice: 0, entry: 2 },
];

describe('GroupPanel', () => {
  it('says how much is selected and where it is', () => {
    mount([...group, { voice: 1, entry: 1 }]);
    expect(testRoot.text()).toContain('3 nodes in 2 voices');
    expect(testRoot.text()).toContain('0:10 to 0:30');
  });

  /** §3.7 is what the mode decides, so the panel says which is in force rather than assuming. */
  it('says whether the program will change length', () => {
    mount(group, 'squeeze');
    expect(testRoot.text()).toContain('stays the same length');

    mount(group, 'ripple');
    expect(testRoot.text()).toContain('longer or shorter');
  });

  it('moves the whole selection later and earlier by the typed amount', () => {
    const harness = mount(group);
    testRoot.act(() => setInputValue(testRoot.query('input[type="number"]') as HTMLInputElement, '5'));
    testRoot.click(button('Later →'));

    expect(harness.commits).toHaveLength(1);
    expect(harness.commits[0].label).toBe('Move nodes');
    expect(entryStartTimes(harness.commits[0].schedule.voices[0])).toEqual([0, 15, 35, 60]);
  });

  it('scales the time inside the selection', () => {
    const harness = mount(group);
    const factor = testRoot.queryAll('input[type="number"]')[1] as HTMLInputElement;
    testRoot.act(() => setInputValue(factor, '2'));
    testRoot.click(button('Stretch'));

    expect(harness.commits[0].label).toBe('Scale selection');
    // The block spans 10..30; doubled it spans 10..50, and the squeeze takes the extra 20 s out of
    // the segment after it, so the voice is exactly as long as it was.
    expect(entryStartTimes(harness.commits[0].schedule.voices[0])).toEqual([0, 10, 50, 60]);
    expect(voiceDuration(harness.commits[0].schedule.voices[0])).toBe(100);
  });

  it('compresses by the same factor, the other way', () => {
    const harness = mount(group);
    testRoot.act(() =>
      setInputValue(testRoot.queryAll('input[type="number"]')[1] as HTMLInputElement, '2'),
    );
    testRoot.click(button('Compress'));

    expect(entryStartTimes(harness.commits[0].schedule.voices[0])).toEqual([0, 10, 20, 60]);
  });

  /** Scaling stretches the time *between* nodes, so one node in a voice has no span to stretch. */
  it('refuses to scale a selection with no span, and says why', () => {
    mount([
      { voice: 0, entry: 1 },
      { voice: 1, entry: 2 },
    ]);

    expect(button('Stretch').disabled).toBe(true);
    expect(testRoot.text()).toContain('at least two in one voice');
  });

  it('deletes the selection and leaves the node before it selected', () => {
    const harness = mount(group);
    testRoot.click(button('Delete 2 nodes'));

    expect(harness.commitsAt).toHaveLength(1);
    expect(harness.commitsAt[0].label).toBe('Delete nodes');
    expect(harness.commitsAt[0].schedule.voices[0].entries).toHaveLength(2);
    expect(harness.commitsAt[0].selection).toEqual([{ voice: 0, entry: 0 }]);
    // Length-preserving, exactly as a single delete is.
    expect(voiceDuration(harness.commitsAt[0].schedule.voices[0])).toBe(100);
  });

  /** Step 6's floor, where a group delete is the way to meet it. */
  it('states that a voice always keeps a node', () => {
    mount(group);
    expect(testRoot.text()).toContain('keeps at least one node');
  });
});
