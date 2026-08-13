import { describe, expect, it } from 'vitest';
import type { EntryWarning, ScheduleWarning, WarningKind } from '../document/warnings';
import { setupRoot } from '../test-utils';
import type { WarningRepair } from './ValidationPanel';
import { ValidationPanel } from './ValidationPanel';
import type { NodeRef } from './history';

const testRoot = setupRoot();

function mount(
  schedule: ScheduleWarning[],
  entries: EntryWarning[],
  repairs?: Partial<Record<WarningKind, WarningRepair>>,
) {
  const selections: NodeRef[] = [];
  testRoot.render(
    <ValidationPanel
      schedule={schedule}
      entries={entries}
      repairs={repairs}
      onSelect={(node) => selections.push(node)}
    />,
  );
  return selections;
}

const ragged: ScheduleWarning = {
  severity: 'warning',
  kind: 'unequal-durations',
  message: 'The voices are not the same length.',
};

const gamma: EntryWarning = {
  severity: 'notice',
  kind: 'beat-above-band',
  message: 'Voice a reaches a beat above 40 Hz at 3 nodes.',
  nodes: [
    { voice: 0, entry: 1 },
    { voice: 0, entry: 4 },
    { voice: 1, entry: 0 },
  ],
};

const volume: EntryWarning = {
  severity: 'warning',
  kind: 'volume-out-of-range',
  message: 'Voice a carries a volume outside 0–1 at 1 node.',
  nodes: [{ voice: 0, entry: 2 }],
};

describe('ValidationPanel', () => {
  it('renders nothing at all for a clean document', () => {
    mount([], []);

    expect(testRoot.query('.validation')).toBeNull();
  });

  /**
   * 9a's severity split, which is what lets §6.1's 40 Hz beat threshold ship against four presets
   * that deliberately exceed it: a warning is shown outright, a notice is folded away.
   */
  it('shows warnings outright and folds notices away', () => {
    mount([ragged], [gamma, volume]);

    const alerts = testRoot.query('[role="alert"]') as HTMLElement;
    expect(alerts.textContent).toContain('not the same length');
    expect(alerts.textContent).toContain('outside 0–1');
    expect(alerts.textContent).not.toContain('above 40 Hz');

    const notices = testRoot.query('.validation__notices') as HTMLElement;
    expect(notices.textContent).toContain('One note about this program');
    expect(notices.textContent).toContain('above 40 Hz');
  });

  /** A row per node would be fifteen copies of one sentence on a gamma-band programme. */
  it('walks the nodes of one rule, one press at a time, and wraps', () => {
    const selections = mount([], [gamma]);
    const show = testRoot.byText('button', 'Show') as HTMLButtonElement;

    expect(show.textContent).toBe('Show (1 of 3)');

    testRoot.click(show);
    expect(selections).toEqual([{ voice: 0, entry: 1 }]);
    expect((testRoot.byText('button', 'Show') as HTMLButtonElement).textContent).toBe('Show (2 of 3)');

    testRoot.click(testRoot.byText('button', 'Show') as HTMLButtonElement);
    testRoot.click(testRoot.byText('button', 'Show') as HTMLButtonElement);
    testRoot.click(testRoot.byText('button', 'Show') as HTMLButtonElement);

    expect(selections).toEqual([
      { voice: 0, entry: 1 },
      { voice: 0, entry: 4 },
      { voice: 1, entry: 0 },
      { voice: 0, entry: 1 },
    ]);
  });

  it('offers nothing to press for a warning with no node to point at', () => {
    // A schedule-scoped warning, and `gnaural-regroup` against a voice with no entries.
    mount([ragged], [{ severity: 'warning', kind: 'gnaural-regroup', message: 'Voice a is empty.', nodes: [] }]);

    expect(testRoot.queryAll('.validation__item')).toHaveLength(2);
    expect(testRoot.queryAll('.validation__show')).toHaveLength(0);
  });
});

/**
 * §3.7's "one-click fix" and the reopen-in-Gnaural repair, both deferred to step 9 and both offered
 * on the row that states the problem — which is the argument for putting them here rather than in a
 * menu: the sentence and the button that answers it are the same object.
 */
describe('ValidationPanel repairs', () => {
  it('offers a fix on the row whose rule has one, and nowhere else', () => {
    let padded = 0;
    mount([ragged], [volume], {
      'unequal-durations': { label: 'Pad to longest', run: () => (padded += 1) },
    });

    const fixes = testRoot.queryAll('.validation__fix');
    expect(fixes).toHaveLength(1);
    expect(fixes[0].textContent).toBe('Pad to longest');

    testRoot.click(fixes[0]);
    expect(padded).toBe(1);
  });

  /**
   * The caller offers a repair only when running it would change something, which is how the third
   * `gnaural-regroup` shape — a voice with no entries, which renumbering cannot help — ends up with
   * a warning and no button.
   */
  it('shows no fix when the caller offers none for that rule', () => {
    mount([], [{ severity: 'warning', kind: 'gnaural-regroup', message: 'Voice a is empty.', nodes: [] }], {
      'unequal-durations': { label: 'Pad to longest', run: () => undefined },
    });

    expect(testRoot.queryAll('.validation__fix')).toHaveLength(0);
  });

  it('offers a fix on a notice too, since severity says nothing about being actionable', () => {
    mount([], [gamma], {
      'beat-above-band': { label: 'Bring into band', run: () => undefined },
    });

    expect(testRoot.query('.validation__notices .validation__fix')).not.toBeNull();
  });
});
