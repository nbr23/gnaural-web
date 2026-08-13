import { describe, expect, it } from 'vitest';
import type { VoiceEdit } from '../document/edit';
import { scheduleDuration, voiceDuration } from '../document/timing';
import type { Entry, Schedule, Voice } from '../document/types';
import { VoiceType } from '../document/types';
import { entryWarnings, scheduleWarnings } from '../document/warnings';
import { setInputValue, setSelectValue, setupRoot } from '../test-utils';
import { AuthoringPanel } from './AuthoringPanel';
import type { NodeRef, Selection } from './history';

const testRoot = setupRoot();

function makeVoice(id: number, durations: number[]): Voice {
  const entries = durations.map<Entry>((duration, index) => ({
    duration,
    baseFreq: 200 + index,
    beatFreq: 10 - index,
    volumeLeft: 0.5,
    volumeRight: 0.5,
    preserved: { parent: String(id) },
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

function schedule(voices = [makeVoice(0, [100, 200, 300]), makeVoice(1, [200, 400])]): Schedule {
  return {
    title: 'Aids',
    description: '',
    author: '',
    loops: 1,
    masterVolume: { left: 1, right: 1 },
    stereoSwap: false,
    voices,
    preserved: {},
  };
}

interface Harness {
  commits: { schedule: Schedule; label: string }[];
  commitsAt: { schedule: Schedule; label: string; selection: Selection }[];
  structural: { edit: VoiceEdit; label: string; selection?: NodeRef | null }[];
  /** Whatever the last command produced, however it was committed. */
  last(): Schedule;
}

function mount(document = schedule(), selected: Selection = []) {
  const harness: Harness = {
    commits: [],
    commitsAt: [],
    structural: [],
    last: () =>
      harness.structural.at(-1)?.edit.schedule ??
      harness.commitsAt.at(-1)?.schedule ??
      harness.commits.at(-1)!.schedule,
  };

  testRoot.render(
    <AuthoringPanel
      schedule={document}
      selected={selected}
      onCommit={(next, label) => harness.commits.push({ schedule: next, label })}
      onCommitAt={(next, label, selection) =>
        harness.commitsAt.push({ schedule: next, label, selection })
      }
      onStructural={(edit, label, selection) =>
        harness.structural.push({ edit, label, selection })
      }
    />,
  );
  return harness;
}

function button(label: string): HTMLButtonElement {
  return testRoot.byText('button', label) as HTMLButtonElement;
}

function field(label: string): HTMLInputElement {
  const span = testRoot.queryAll('.editor__field span').find((node) => node.textContent === label);
  return span?.parentElement?.querySelector('input') as HTMLInputElement;
}

describe('AuthoringPanel — program length', () => {
  it('scales the whole programme to the target, proportionally', () => {
    const before = schedule();
    const harness = mount(before);

    testRoot.act(() => setInputValue(field('Target length (s)'), '300'));
    testRoot.click(button('Scale program'));

    const after = harness.commits.at(-1)!;
    expect(after.label).toBe('Scale program');
    expect(scheduleDuration(after.schedule)).toBeCloseTo(300, 6);
    // Every voice by the same factor, so a spread of any size survives in proportion (§3.7).
    expect(voiceDuration(after.schedule.voices[1])).toBeCloseTo(
      voiceDuration(before.voices[1]) * (300 / scheduleDuration(before)),
      6,
    );
  });

  it('commits nothing when the target is the length it already is', () => {
    const harness = mount();

    testRoot.act(() => setInputValue(field('Target length (s)'), '600'));
    testRoot.click(button('Scale program'));

    expect(harness.commits).toEqual([]);
  });
});

describe('AuthoringPanel — voice tools', () => {
  it('defaults its target to the voice the selection is in', () => {
    mount(schedule(), [{ voice: 1, entry: 0 }]);
    expect((testRoot.query('.authoring select') as HTMLSelectElement).value).toBe('1');
  });

  it('duplicates the chosen voice next to it and lands the selection on the copy', () => {
    const harness = mount();

    testRoot.act(() => setSelectValue(testRoot.query('.authoring select') as HTMLSelectElement, '1'));
    testRoot.click(button('Duplicate'));

    const { edit, label, selection } = harness.structural.at(-1)!;
    expect(label).toBe('Duplicate voice');
    expect(edit.schedule.voices).toHaveLength(3);
    expect(edit.voiceMap).toEqual([0, 1]);
    expect(selection).toEqual({ voice: 2, entry: 0 });
    // The copy must not merge back into its source when Gnaural reopens the file.
    expect(entryWarnings(edit.schedule).filter((w) => w.kind === 'gnaural-regroup')).toEqual([]);
  });

  it('reverses a voice and mirrors the selection inside it', () => {
    const harness = mount(schedule(), [
      { voice: 0, entry: 1 },
      { voice: 1, entry: 0 },
    ]);

    testRoot.click(button('Reverse'));

    const { label, schedule: after, selection } = harness.commitsAt.at(-1)!;
    expect(label).toBe('Reverse voice');
    expect(after.voices[0].entries.map((entry) => entry.duration)).toEqual([300, 200, 100]);
    expect(selection).toEqual([
      { voice: 0, entry: 2 },
      { voice: 1, entry: 0 },
    ]);
  });

  it('rotates a voice in either direction, keeping its length', () => {
    const before = schedule();
    const harness = mount(before);

    testRoot.act(() => setInputValue(field('Offset by (s)'), '100'));
    testRoot.click(button('Rotate later'));

    const later = harness.commitsAt.at(-1)!;
    expect(later.label).toBe('Offset voice');
    expect(voiceDuration(later.schedule.voices[0])).toBeCloseTo(600, 9);
    // 100 s later means starting 100 s before the end, which is inside the last segment — so the
    // rotation splits it, adding the one node it is ever allowed to add.
    expect(later.schedule.voices[0].entries).toHaveLength(4);
    expect(later.schedule.voices[0].entries[0].duration).toBeCloseTo(100, 9);

    testRoot.click(button('Rotate earlier'));
    expect(voiceDuration(harness.commitsAt.at(-1)!.schedule.voices[0])).toBeCloseTo(600, 9);
  });

  /** The rotation renumbers that voice's nodes, so a selection inside it no longer means anything. */
  it('drops only the selection inside the voice it rotated', () => {
    const harness = mount(schedule(), [
      { voice: 0, entry: 2 },
      { voice: 1, entry: 1 },
    ]);

    testRoot.act(() => setInputValue(field('Offset by (s)'), '50'));
    testRoot.click(button('Rotate later'));

    expect(harness.commitsAt.at(-1)!.selection).toEqual([{ voice: 1, entry: 1 }]);
  });

  it('offers no voice tools, and says so, when there are no voices', () => {
    mount(schedule([]));

    expect(testRoot.byText('button', 'Duplicate')).toBeUndefined();
    expect(testRoot.text()).toContain('Add a voice first');
  });
});

describe('AuthoringPanel — generators', () => {
  /**
   * The whole point of the owner's "always a new voice": generating cannot destroy anything, and the
   * voice it makes spans exactly what the schedule already plays, so it cannot make it ragged either.
   */
  it('adds a voice at the playing length rather than overwriting one', () => {
    const before = schedule();
    const harness = mount(before);

    testRoot.click(button('Generate'));

    const { edit, label, selection } = harness.structural.at(-1)!;
    expect(label).toBe('Generate voice');
    expect(edit.schedule.voices).toHaveLength(3);
    expect(edit.schedule.voices[0]).toBe(before.voices[0]);
    expect(voiceDuration(edit.schedule.voices[2])).toBeCloseTo(scheduleDuration(before), 9);
    expect(selection).toEqual({ voice: 2, entry: 0 });
    expect(
      scheduleWarnings(edit.schedule).filter((w) => w.kind === 'unequal-durations'),
    ).toEqual([]);
  });

  it('generates each shape, naming the voice after it', () => {
    const harness = mount();
    const select = () => testRoot.queryAll('.authoring select')[1] as HTMLSelectElement;

    for (const [kind, name] of [
      ['hold', 'Hold'],
      ['sleep-cycle', 'Sleep cycle'],
      ['wake-up', 'Wake-up ramp'],
    ] as const) {
      testRoot.act(() => setSelectValue(select(), kind));
      testRoot.click(button('Generate'));

      const added = harness.structural.at(-1)!.edit.schedule.voices.at(-1)!;
      expect(added.description).toBe(name);
      expect(added.entries.length).toBeGreaterThan(0);
    }
  });

  it('takes the duration it is given, spending part of it on the way home (§3.5)', () => {
    const harness = mount();

    testRoot.act(() => setInputValue(field('Over (s)'), '1200'));
    testRoot.act(() => setInputValue(field('Return over (s)'), '120'));
    testRoot.click(button('Generate'));

    const added = harness.structural.at(-1)!.edit.schedule.voices.at(-1)!;
    expect(voiceDuration(added)).toBeCloseTo(1200, 9);
    expect(added.entries.at(-1)!.duration).toBeCloseTo(120, 9);
  });

  /** A band preset is a hold at the band's own centre, so the chip writes into the beat field. */
  it('fills the beat from an EEG band chip', () => {
    const harness = mount();

    testRoot.click(button('Alpha 10.2 Hz'));
    testRoot.click(button('Generate'));

    expect(harness.structural.at(-1)!.edit.schedule.voices.at(-1)!.entries[0].beatFreq).toBeCloseTo(
      10.198,
      3,
    );
  });

  it('hides the return field for the one shape that needs none', () => {
    mount();
    const select = testRoot.queryAll('.authoring select')[1] as HTMLSelectElement;

    expect(field('Return over (s)')).toBeDefined();
    testRoot.act(() => setSelectValue(select, 'sleep-cycle'));
    expect(field('Return over (s)')).toBeUndefined();
  });

  it('generates into an empty schedule, where there is no playing length to match', () => {
    const harness = mount(schedule([]));

    testRoot.click(button('Generate'));

    const added = harness.structural.at(-1)!.edit.schedule.voices[0];
    expect(voiceDuration(added)).toBeGreaterThan(0);
  });
});
