import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { parseSchedule } from '../document/parser';
import { loadFixture } from '../document/test-fixtures';
import type { Entry, Schedule, Voice } from '../document/types';
import { VoiceType } from '../document/types';
import { TEST_WIDTH } from '../test-setup';
import { pointer, setupRoot, stubRect } from '../test-utils';
import { ScheduleChart } from './ScheduleChart';

const testRoot = setupRoot();
const render = testRoot.render;

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
  return testRoot.queryAll('path.schedule-chart__series');
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
    expect(testRoot.query('.schedule-chart__legend')).toBeNull();

    render(
      <ScheduleChart
        schedule={makeSchedule([
          makeVoice({ id: 0, description: 'Carrier' }),
          makeVoice({ id: 1, description: 'Hiss', type: VoiceType.PinkNoise }),
        ])}
      />,
    );
    const legend = testRoot.query('.schedule-chart__legend');
    expect(legend?.textContent).toContain('Carrier');
    expect(legend?.textContent).toContain('Hiss');
    // A non-binaural voice says so, since its curve is not audible as a tone.
    expect(legend?.textContent).toContain('noise');
  });

  it('moves the playhead with currentTime and hides it when absent', () => {
    const schedule = makeSchedule([makeVoice({ id: 0 })]);

    render(<ScheduleChart schedule={schedule} />);
    expect(testRoot.query('.schedule-chart__playhead')).toBeNull();

    render(<ScheduleChart schedule={schedule} currentTime={5} />);
    const at5 = testRoot.query('.schedule-chart__playhead')!.getAttribute('x1');

    render(<ScheduleChart schedule={schedule} currentTime={15} />);
    const at15 = testRoot.query('.schedule-chart__playhead')!.getAttribute('x1');

    expect(Number(at15)).toBeGreaterThan(Number(at5));
  });

  it('hides the playhead outside the drawn extent', () => {
    render(<ScheduleChart schedule={makeSchedule([makeVoice({ id: 0 })])} currentTime={999} />);
    expect(testRoot.query('.schedule-chart__playhead')).toBeNull();
  });

  it('marks where the shortest voice ends, but only when lengths actually differ (§3.7)', () => {
    const short = makeVoice({ id: 1, entries: [makeEntry({ duration: 5, baseFreq: 150, beatFreq: 6 })] });

    render(<ScheduleChart schedule={makeSchedule([makeVoice({ id: 0 })])} />);
    expect(testRoot.query('.schedule-chart__truncation')).toBeNull();

    render(<ScheduleChart schedule={makeSchedule([makeVoice({ id: 0 }), short])} />);
    expect(testRoot.query('.schedule-chart__truncation')).not.toBeNull();
    expect(testRoot.text()).toContain('ends 0:05');
  });

  it('shades the beat lane with EEG bands', () => {
    render(<ScheduleChart schedule={makeSchedule([makeVoice({ id: 0 })])} />);
    expect(testRoot.queryAll('rect.schedule-chart__band').length).toBeGreaterThan(0);
    expect(testRoot.text()).toContain('Theta');
  });

  it('exposes a crosshair readout on keyboard focus, not hover alone', () => {
    render(<ScheduleChart schedule={makeSchedule([makeVoice({ id: 0 })])} />);
    const svg = testRoot.query('svg')!;

    act(() => {
      svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    });

    expect(testRoot.query('.schedule-chart__crosshair')).not.toBeNull();
    const tooltip = testRoot.query('.schedule-chart__tooltip')!;
    expect(tooltip.textContent).toContain('0:20');
    // At the wrap point the curve is back at entry[0]'s values (§3.5).
    expect(tooltip.textContent).toContain('10 Hz');
    expect(tooltip.textContent).toContain('200 Hz');
  });

  it('describes itself for assistive technology', () => {
    render(<ScheduleChart schedule={makeSchedule([makeVoice({ id: 0 })])} />);
    const label = testRoot.query('svg')!.getAttribute('aria-label');
    expect(label).toContain('Test program');
    expect(label).toContain('1 voice');
    expect(label).toContain('0:20');
  });

  it('renders an empty state rather than a blank box when nothing is plottable', () => {
    render(<ScheduleChart schedule={makeSchedule([])} />);
    expect(testRoot.query('.schedule-chart__empty')).not.toBeNull();
    expect(testRoot.query('svg')).toBeNull();
  });

  it('renders the powernap fixture end to end', () => {
    render(<ScheduleChart schedule={parseSchedule(loadFixture('powernap.gnaural'))} currentTime={600} />);

    expect(seriesPaths()).toHaveLength(2);
    expect(testRoot.query('.schedule-chart__playhead')).not.toBeNull();
    expect(testRoot.text()).toContain('20:00');
  });

  /**
   * The editing surface is opt-in, so the player's chart must be exactly what it was. Both halves of
   * that matter: no node markers (45 of them in one `airplanetravelaid` voice would be noise where
   * none can be touched), and a drag still scrubs rather than being reserved for a gesture.
   */
  it('stays read-only without an interaction prop', () => {
    const onSeek = vi.fn();
    render(<ScheduleChart schedule={makeSchedule([makeVoice({ id: 0 })])} onSeek={onSeek} />);

    const svg = testRoot.query('svg')!;
    stubRect(svg, TEST_WIDTH, 280);

    expect(testRoot.queryAll('circle.schedule-chart__node')).toHaveLength(0);
    expect(testRoot.queryAll('path.schedule-chart__series--wrap')).toHaveLength(0);
    expect(testRoot.query('.schedule-chart--editing')).toBeNull();

    pointer(svg, 'pointerdown', { x: 200, y: 60 });
    pointer(svg, 'pointermove', { x: 320, y: 60 });
    expect(onSeek).toHaveBeenCalledTimes(2);
    expect(onSeek.mock.calls[1][0]).toBeGreaterThan(onSeek.mock.calls[0][0]);
  });
});

/**
 * The gestures the chart recognises but does not own.
 *
 * It has the layout and the element's rect, so it is the only thing that can turn two fingers or a
 * wheel into a factor and an anchor; the *window* belongs to the caller, which is what keeps this
 * component controlled and lets the caller rate-limit a redraw that costs 10.7 ms at four lanes.
 */
describe('ScheduleChart gestures', () => {
  function mountEditable(handlers: Record<string, unknown> = {}) {
    const zooms: { factor: number; anchor: number }[] = [];
    const pans: number[] = [];
    const cancels: number[] = [];

    render(
      <ScheduleChart
        schedule={makeSchedule([makeVoice({})])}
        interaction={{
          onZoom: (factor, anchor) => zooms.push({ factor, anchor }),
          onPan: (seconds) => pans.push(seconds),
          onGestureCancel: () => cancels.push(1),
          ...handlers,
        }}
      />,
    );

    const svg = testRoot.query('svg') as SVGSVGElement;
    stubRect(svg, TEST_WIDTH, 280);
    return { svg, zooms, pans, cancels };
  }

  /**
   * happy-dom's `WheelEvent` constructor ignores the `MouseEvent` half of its init dict —
   * `ctrlKey`, `metaKey` and `clientX` all come back undefined — so they are defined on the
   * instance instead. Same class of harness gap as step 5's overridable `getBoundingClientRect`,
   * and worth knowing before writing another modifier-driven test.
   */
  function wheel(init: Partial<WheelEvent>): WheelEvent {
    const event = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaX: init.deltaX ?? 0,
      deltaY: init.deltaY ?? 0,
    });
    for (const [key, value] of Object.entries(init)) {
      if (key === 'deltaX' || key === 'deltaY') continue;
      Object.defineProperty(event, key, { value, configurable: true });
    }
    return event;
  }

  /** A trackpad pinch arrives as ctrl+wheel, which is why this branch is the important one. */
  it('zooms on ctrl+wheel, about the time under the pointer', () => {
    const { svg, zooms } = mountEditable();

    act(() => {
      svg.dispatchEvent(wheel({ ctrlKey: true, deltaY: -100, clientX: 300 }));
    });

    expect(zooms).toHaveLength(1);
    expect(zooms[0].factor).toBeGreaterThan(1);
    expect(zooms[0].anchor).toBeGreaterThan(0);
  });

  it('pans on a horizontal wheel and leaves a plain vertical one to the page', () => {
    const { svg, pans, zooms } = mountEditable();

    act(() => {
      svg.dispatchEvent(wheel({ deltaX: 40, clientX: 300 }));
    });
    expect(pans).toHaveLength(1);
    expect(pans[0]).toBeGreaterThan(0);

    const scroll = wheel({ deltaY: 100, clientX: 300 });
    act(() => {
      svg.dispatchEvent(scroll);
    });
    expect(pans).toHaveLength(1);
    expect(zooms).toHaveLength(0);
    expect(scroll.defaultPrevented).toBe(false);
  });

  /**
   * Two fingers are the chart's own gesture: `touch-action: none` is on the plot while editing, so
   * if this component does not implement the pinch, nothing does.
   */
  it('turns two fingers apart into a zoom and two fingers moving into a pan', () => {
    const { svg, zooms, pans, cancels } = mountEditable();

    pointer(svg, 'pointerdown', { x: 200, y: 60, id: 1 });
    pointer(svg, 'pointerdown', { x: 300, y: 60, id: 2 });
    // The one-finger gesture that was in flight is dropped rather than half-committed.
    expect(cancels).toHaveLength(1);

    pointer(svg, 'pointermove', { x: 200, y: 60, id: 1 });
    pointer(svg, 'pointermove', { x: 400, y: 60, id: 2 });

    expect(zooms.at(-1)?.factor).toBeGreaterThan(1);
    expect(pans.length).toBeGreaterThan(0);
  });

  it('does not end a drag with the finger that ends a pinch', () => {
    const ups: number[] = [];
    const { svg } = mountEditable({ onPointerUp: () => ups.push(1) });

    pointer(svg, 'pointerdown', { x: 200, y: 60, id: 1 });
    pointer(svg, 'pointerdown', { x: 300, y: 60, id: 2 });
    pointer(svg, 'pointerup', { x: 300, y: 60, id: 2 });

    // A pointerup the caller acted on here would commit an edit nobody made.
    expect(ups).toHaveLength(0);
  });
});

/** The view window, as the chart draws it. */
describe('ScheduleChart with a view window', () => {
  it('draws only the window, and hides a playhead that is outside it', () => {
    const schedule = makeSchedule([makeVoice({})]);

    render(<ScheduleChart schedule={schedule} currentTime={2} view={{ start: 12, end: 18 }} />);
    expect(testRoot.query('line.schedule-chart__playhead')).toBeNull();

    render(<ScheduleChart schedule={schedule} currentTime={15} view={{ start: 12, end: 18 }} />);
    expect(testRoot.query('line.schedule-chart__playhead')).not.toBeNull();
  });

  it('clips each lane, so a culled neighbour cannot draw over the axis labels', () => {
    render(<ScheduleChart schedule={makeSchedule([makeVoice({})])} view={{ start: 12, end: 18 }} />);
    expect(testRoot.queryAll('clipPath').length).toBeGreaterThan(0);
  });
});

/**
 * The beat lane labels its y-axis with the EEG band boundaries (§1) rather than round numbers,
 * because that is what the value means. Those boundaries are **geometric** (0.5, 4, 8, 13, 30, 100)
 * and the lane is linear, so a domain reaching into Gamma pushes the low ones into the bottom few
 * pixels of the lane.
 *
 * Found by a browser pass, not by these tests: at 390px over a 0–60 Hz domain the five labels sat
 * 3.8, 4.5, 5.5 and 18.9 px apart in a 15px line box, so four of the five overprinted into an
 * illegible smear. The assertion is on the *pixel spacing* rather than on which ticks survive —
 * naming the survivors would pin the arithmetic instead of the property that matters.
 */
describe('ScheduleChart beat-lane ticks', () => {
  function tickPixels() {
    return testRoot
      .queryAll('text.schedule-chart__tick')
      .map((tick) => ({ text: tick.textContent ?? '', y: Number(tick.getAttribute('y')) }))
      .filter(({ text }) => /^[\d.]+$/.test(text))
      .map(({ y }) => y);
  }

  it('never places two y-axis labels closer than a label box apart', () => {
    // A beat curve reaching into Gamma is what crowds the low boundaries together.
    render(
      <ScheduleChart
        schedule={makeSchedule([
          makeVoice({
            entries: [
              makeEntry({ duration: 10, baseFreq: 200, beatFreq: 1 }),
              makeEntry({ duration: 10, baseFreq: 200, beatFreq: 60 }),
            ],
          }),
        ])}
      />,
    );

    const ys = [...new Set(tickPixels())].sort((a, b) => a - b);
    expect(ys.length).toBeGreaterThan(1);

    const gaps = ys.slice(1).map((y, i) => y - ys[i]);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(15);
  });

  it('still labels the band boundaries when the lane has room for them', () => {
    // 2–25 Hz puts three boundaries (4, 8, 13) inside the domain, far enough apart to all survive.
    // Note the pre-existing floor this sits above: a domain holding fewer than two boundaries falls
    // back to round numbers rather than labelling a lone band edge.
    render(
      <ScheduleChart
        schedule={makeSchedule([
          makeVoice({
            entries: [
              makeEntry({ duration: 10, baseFreq: 200, beatFreq: 2 }),
              makeEntry({ duration: 10, baseFreq: 200, beatFreq: 25 }),
            ],
          }),
        ])}
      />,
    );

    const labels = testRoot.queryAll('text.schedule-chart__tick').map((t) => t.textContent);
    // 8 and 13 are band boundaries and are not values `niceTicks` would choose for this domain, so
    // their presence is what says the lane is still labelled by band rather than by round number.
    expect(labels).toContain('8');
    expect(labels).toContain('13');
  });
});
