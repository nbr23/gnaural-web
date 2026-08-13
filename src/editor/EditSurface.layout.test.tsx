import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entry, Schedule, Voice } from '../document/types';
import { VoiceType } from '../document/types';
import { TEST_WIDTH } from '../test-setup';
import { pointer, setupRoot, stubRect } from '../test-utils';
import { EditSurface } from './EditSurface';

/**
 * The re-render budget, checked by counting the *work* rather than by comparing the output.
 *
 * Step 5's invariant test asserts that every static series path is byte-identical across a drag,
 * and step 7 extended it to the validation marks. Both compare what came out — which is exactly why
 * neither could see the defect this file exists for: `EditSurface` built its view window as a fresh
 * object on every render, so `layoutChart` re-ran and `StaticPlot`, `IssueMarks` and `SelectionRing`
 * were all rebuilt on every `pointermove`, producing byte-identical paths each time. Measured at
 * 4.0 ms per move against 0.6 ms before the memo was added.
 *
 * So this counts calls into the geometry layer instead. A drag may rebuild nothing; a zoom must
 * rebuild exactly once.
 */
const layoutCalls = vi.fn();
const modelCalls = vi.fn();

vi.mock('../viz/geometry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../viz/geometry')>();
  return {
    ...actual,
    layoutChart: (...args: Parameters<typeof actual.layoutChart>) => {
      layoutCalls();
      return actual.layoutChart(...args);
    },
    buildChartModel: (...args: Parameters<typeof actual.buildChartModel>) => {
      modelCalls();
      return actual.buildChartModel(...args);
    },
  };
});

const testRoot = setupRoot();
const HEIGHT = 260;

function makeEntry(partial: Partial<Entry>): Entry {
  return { duration: 10, baseFreq: 200, beatFreq: 8, volumeLeft: 0.5, volumeRight: 0.5, preserved: {}, ...partial };
}

function schedule(): Schedule {
  const voice: Voice = {
    id: 0,
    description: 'Voice 0',
    type: VoiceType.Binaural,
    muted: false,
    hidden: false,
    mono: false,
    entries: [
      makeEntry({ beatFreq: 4 }),
      makeEntry({ beatFreq: 12 }),
      makeEntry({ beatFreq: 6 }),
      makeEntry({ beatFreq: 10 }),
    ],
    preserved: {},
  };
  return {
    title: 'Budget',
    description: '',
    author: '',
    loops: 1,
    masterVolume: { left: 1, right: 1 },
    stereoSwap: false,
    voices: [voice],
    preserved: {},
  };
}

function mount() {
  testRoot.render(
    <EditSurface
      schedule={schedule()}
      lanes={['beat', 'base']}
      height={HEIGHT}
      selected={[]}
      mode="squeeze"
      snap={false}
      onSelect={() => {}}
      onCommit={() => {}}
      onCommitAt={() => {}}
      onPreview={() => {}}
      onSeek={() => {}}
    />,
  );
  const svg = testRoot.query('svg') as SVGSVGElement;
  stubRect(svg, TEST_WIDTH, HEIGHT);
  return svg;
}

function nodeAt(index: number) {
  const marker = testRoot.queryAll('circle.schedule-chart__node')[index];
  return { x: Number(marker.getAttribute('cx')), y: Number(marker.getAttribute('cy')) };
}

describe('the editing surface re-render budget', () => {
  beforeEach(() => {
    layoutCalls.mockClear();
    modelCalls.mockClear();
  });

  it('lays the chart out again for no part of a drag', () => {
    const svg = mount();
    const node = nodeAt(1);

    pointer(svg, 'pointerdown', node);
    layoutCalls.mockClear();
    modelCalls.mockClear();

    for (let step = 1; step <= 8; step++) {
      pointer(svg, 'pointermove', { x: node.x + step * 6, y: node.y - step * 2 });
    }

    expect(layoutCalls).not.toHaveBeenCalled();
    expect(modelCalls).not.toHaveBeenCalled();
  });

  it('lays it out again for no part of a marquee either', () => {
    const svg = mount();
    const node = nodeAt(1);

    pointer(svg, 'pointerdown', { x: node.x, y: 2 });
    layoutCalls.mockClear();

    pointer(svg, 'pointermove', { x: node.x + 40, y: HEIGHT - 40 });
    pointer(svg, 'pointermove', { x: node.x + 80, y: HEIGHT - 40 });

    expect(layoutCalls).not.toHaveBeenCalled();
  });

  /**
   * A zoom is the one gesture that legitimately rebuilds the picture — once, which is why the
   * continuous forms of it are rate-limited. It must not rebuild the compiled *model*: that is per
   * voice and per entry, and a window is not a property of the document.
   */
  it('lays it out once for a zoom, and never recompiles the voices', () => {
    mount();
    layoutCalls.mockClear();
    modelCalls.mockClear();

    testRoot.click(testRoot.byText('.editor__view button', '+'));

    expect(layoutCalls).toHaveBeenCalledTimes(1);
    expect(modelCalls).not.toHaveBeenCalled();
  });
});
