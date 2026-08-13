import { describe, expect, it } from 'vitest';
import { setInputValue, setupRoot } from '../test-utils';
import type { LaneDomains, LaneId } from '../viz/geometry';
import { LaneRanges } from './LaneRanges';

const testRoot = setupRoot();

const LABELS: Record<LaneId, string> = {
  beat: 'Beat',
  base: 'Base',
  volumeLeft: 'Volume L',
  volumeRight: 'Volume R',
};

function mount(domains: LaneDomains = {}, lanes: LaneId[] = ['beat', 'base']) {
  const changes: LaneDomains[] = [];
  testRoot.render(
    <LaneRanges
      lanes={lanes}
      labels={LABELS}
      domains={domains}
      fitted={{ beat: [3, 13], base: [90, 210] }}
      onChange={(next) => changes.push(next)}
    />,
  );
  return changes;
}

function field(label: string): HTMLInputElement {
  return testRoot.query(`input[aria-label="${label}"]`) as HTMLInputElement;
}

describe('LaneRanges', () => {
  it('shows the fitted domain until somebody overrides it', () => {
    mount();
    expect(field('Beat minimum').value).toBe('3');
    expect(field('Beat maximum').value).toBe('13');
  });

  /** Only open lanes: a closed lane has no axis on screen to override. */
  it('offers a range for each open lane and no others', () => {
    mount({}, ['beat']);
    expect(testRoot.queryAll('input')).toHaveLength(2);
  });

  it('overrides one edge and keeps the other, so a single field is enough to widen a lane', () => {
    const changes = mount();
    testRoot.act(() => setInputValue(field('Beat maximum'), '40'));

    expect(changes).toEqual([{ beat: [3, 40] }]);
  });

  it('refuses a range that would collapse or invert the axis', () => {
    const changes = mount();
    testRoot.act(() => setInputValue(field('Beat maximum'), '3'));
    testRoot.act(() => setInputValue(field('Beat maximum'), '1'));

    expect(changes).toEqual([]);
  });

  it('goes back to fitting the data on Fit, which is disabled until there is an override', () => {
    const changes = mount({ beat: [0, 40] });
    const fits = testRoot.queryAll('button');

    expect((fits[0] as HTMLButtonElement).disabled).toBe(false);
    expect((fits[1] as HTMLButtonElement).disabled).toBe(true);

    testRoot.click(fits[0]);
    expect(changes).toEqual([{}]);
  });

  it('shows an override rather than the fitted values once one is set', () => {
    mount({ beat: [0, 40] });
    expect(field('Beat minimum').value).toBe('0');
    expect(field('Beat maximum').value).toBe('40');
    // The lane nobody overrode still reads from the data.
    expect(field('Base minimum').value).toBe('90');
  });
});
