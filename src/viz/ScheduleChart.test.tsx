import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseSchedule } from '../document/parser';
import { loadFixture } from '../document/test-fixtures';
import type { Entry, Schedule, Voice } from '../document/types';
import { VoiceType } from '../document/types';
import { ScheduleChart } from './ScheduleChart';

const WIDTH = 640;

/**
 * happy-dom lays nothing out, so `clientWidth` is 0 and the chart would never size itself. Stub
 * the observer with a fixed width — the same thing a real browser reports on first observe.
 */
beforeAll(() => {
  globalThis.ResizeObserver = class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) {
      this.callback([{ target, contentRect: { width: WIDTH } } as ResizeObserverEntry], this);
    }
    unobserve() {}
    disconnect() {}
  };
});

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(element: React.ReactNode) {
  act(() => root.render(element));
}

function makeEntry(partial: Partial<Entry>): Entry {
  return { duration: 0, baseFreq: 0, beatFreq: 0, volumeLeft: 1, volumeRight: 1, preserved: {}, ...partial };
}

function makeVoice(partial: Partial<Voice>): Voice {
  return {
    id: 0,
    description: '',
    type: VoiceType.Binaural,
    muted: false,
    hidden: false,
    mono: false,
    entries: [makeEntry({ duration: 10, baseFreq: 200, beatFreq: 10 }), makeEntry({ duration: 10, baseFreq: 100, beatFreq: 4 })],
    preserved: {},
    ...partial,
  };
}

function makeSchedule(voices: Voice[]): Schedule {
  return {
    title: 'Test program',
    description: '',
    author: '',
    loops: 1,
    masterVolume: { left: 1, right: 1 },
    stereoSwap: false,
    voices,
    preserved: {},
  };
}

function seriesPaths() {
  return container.querySelectorAll('path.schedule-chart__series');
}

describe('ScheduleChart', () => {
  it('draws one path per lane per visible voice', () => {
    render(<ScheduleChart schedule={makeSchedule([makeVoice({ id: 0 }), makeVoice({ id: 1 })])} />);
    // Two lanes (beat, base) x two voices.
    expect(seriesPaths()).toHaveLength(4);
    expect([...seriesPaths()].every((p) => !p.getAttribute('d')?.includes('NaN'))).toBe(true);
  });

  it('omits hidden voices', () => {
    render(<ScheduleChart schedule={makeSchedule([makeVoice({ id: 0 }), makeVoice({ id: 1, hidden: true })])} />);
    expect(seriesPaths()).toHaveLength(2);
  });

  it('shows a legend for two or more voices and none for one', () => {
    render(<ScheduleChart schedule={makeSchedule([makeVoice({ id: 0, description: 'Carrier' })])} />);
    expect(container.querySelector('.schedule-chart__legend')).toBeNull();

    render(
      <ScheduleChart
        schedule={makeSchedule([
          makeVoice({ id: 0, description: 'Carrier' }),
          makeVoice({ id: 1, description: 'Hiss', type: VoiceType.PinkNoise }),
        ])}
      />,
    );
    const legend = container.querySelector('.schedule-chart__legend');
    expect(legend?.textContent).toContain('Carrier');
    expect(legend?.textContent).toContain('Hiss');
    // A non-binaural voice says so, since its curve is not audible as a tone.
    expect(legend?.textContent).toContain('noise');
  });

  it('moves the playhead with currentTime and hides it when absent', () => {
    const schedule = makeSchedule([makeVoice({ id: 0 })]);

    render(<ScheduleChart schedule={schedule} />);
    expect(container.querySelector('.schedule-chart__playhead')).toBeNull();

    render(<ScheduleChart schedule={schedule} currentTime={5} />);
    const at5 = container.querySelector('.schedule-chart__playhead')!.getAttribute('x1');

    render(<ScheduleChart schedule={schedule} currentTime={15} />);
    const at15 = container.querySelector('.schedule-chart__playhead')!.getAttribute('x1');

    expect(Number(at15)).toBeGreaterThan(Number(at5));
  });

  it('hides the playhead outside the drawn extent', () => {
    render(<ScheduleChart schedule={makeSchedule([makeVoice({ id: 0 })])} currentTime={999} />);
    expect(container.querySelector('.schedule-chart__playhead')).toBeNull();
  });

  it('marks where the shortest voice ends, but only when lengths actually differ (§3.7)', () => {
    const short = makeVoice({ id: 1, entries: [makeEntry({ duration: 5, baseFreq: 150, beatFreq: 6 })] });

    render(<ScheduleChart schedule={makeSchedule([makeVoice({ id: 0 })])} />);
    expect(container.querySelector('.schedule-chart__truncation')).toBeNull();

    render(<ScheduleChart schedule={makeSchedule([makeVoice({ id: 0 }), short])} />);
    expect(container.querySelector('.schedule-chart__truncation')).not.toBeNull();
    expect(container.textContent).toContain('ends 0:05');
  });

  it('shades the beat lane with EEG bands', () => {
    render(<ScheduleChart schedule={makeSchedule([makeVoice({ id: 0 })])} />);
    expect(container.querySelectorAll('rect.schedule-chart__band').length).toBeGreaterThan(0);
    expect(container.textContent).toContain('Theta');
  });

  it('exposes a crosshair readout on keyboard focus, not hover alone', () => {
    render(<ScheduleChart schedule={makeSchedule([makeVoice({ id: 0 })])} />);
    const svg = container.querySelector('svg')!;

    act(() => {
      svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    });

    expect(container.querySelector('.schedule-chart__crosshair')).not.toBeNull();
    const tooltip = container.querySelector('.schedule-chart__tooltip')!;
    expect(tooltip.textContent).toContain('0:20');
    // At the wrap point the curve is back at entry[0]'s values (§3.5).
    expect(tooltip.textContent).toContain('10 Hz');
    expect(tooltip.textContent).toContain('200 Hz');
  });

  it('describes itself for assistive technology', () => {
    render(<ScheduleChart schedule={makeSchedule([makeVoice({ id: 0 })])} />);
    const label = container.querySelector('svg')!.getAttribute('aria-label');
    expect(label).toContain('Test program');
    expect(label).toContain('1 voice');
    expect(label).toContain('0:20');
  });

  it('renders an empty state rather than a blank box when nothing is plottable', () => {
    render(<ScheduleChart schedule={makeSchedule([])} />);
    expect(container.querySelector('.schedule-chart__empty')).not.toBeNull();
    expect(container.querySelector('svg')).toBeNull();
  });

  it('renders the powernap fixture end to end', () => {
    render(<ScheduleChart schedule={parseSchedule(loadFixture('powernap.gnaural'))} currentTime={600} />);

    expect(seriesPaths()).toHaveLength(2);
    expect(container.querySelector('.schedule-chart__playhead')).not.toBeNull();
    expect(container.textContent).toContain('20:00');
  });
});
