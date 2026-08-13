import { describe, expect, it } from 'vitest';
import { entryStartTimes } from '../document/timing';
import type { Entry, Schedule, Voice } from '../document/types';
import { VoiceType } from '../document/types';
import { TEST_WIDTH } from '../test-setup';
import { pointer, setInputValue, setupRoot, stubRect, wait } from '../test-utils';
import type { ChartMark, LaneId } from '../viz/geometry';
import { timeGridStep } from '../viz/scales';
import { EditSurface } from './EditSurface';
import type { Selection } from './history';

/**
 * A pointer drag over an SVG, in a DOM with no layout engine.
 *
 * happy-dom implements `PointerEvent` and `setPointerCapture` (a safe no-op), and lets
 * `getBoundingClientRect` be replaced on the instance — which is the missing piece, since the chart
 * scales client coordinates through that rect and a DOM that lays nothing out reports zeros.
 * `ResizeObserver` is already stubbed to report `TEST_WIDTH`.
 *
 * Node positions are read off the rendered marks rather than recomputed here, so what is under test
 * is the whole round trip: layout -> marker -> hit-test -> transform.
 */

const HEIGHT = 260;

function makeEntry(partial: Partial<Entry>): Entry {
  return { duration: 10, baseFreq: 200, beatFreq: 8, volumeLeft: 0.5, volumeRight: 0.5, preserved: {}, ...partial };
}

function makeVoice(entries: Entry[], id = 0): Voice {
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

/** Four evenly spaced nodes, far enough apart that a 12 px hit radius cannot be ambiguous. */
function fourNodes(): Schedule {
  return {
    title: 'Drag me',
    description: '',
    author: '',
    loops: 1,
    masterVolume: { left: 1, right: 1 },
    stereoSwap: false,
    voices: [
      makeVoice([
        makeEntry({ duration: 10, beatFreq: 4 }),
        makeEntry({ duration: 10, beatFreq: 12 }),
        makeEntry({ duration: 10, beatFreq: 6 }),
        makeEntry({ duration: 10, beatFreq: 10 }),
      ]),
    ],
    preserved: {},
  };
}

const testRoot = setupRoot();

interface Harness {
  commits: { schedule: Schedule; label: string }[];
  /** Commits that also say where the selection should land — an insert or a delete. */
  commitsAt: { schedule: Schedule; label: string; selection: Selection }[];
  previews: Schedule[];
  selections: Selection[];
  seeks: number[];
}

function mount(
  schedule: Schedule,
  selected: Selection = [],
  lanes: LaneId[] = ['beat', 'base'],
  marks: ChartMark[] = [],
) {
  const harness: Harness = { commits: [], commitsAt: [], previews: [], selections: [], seeks: [] };

  testRoot.render(
    <EditSurface
      schedule={schedule}
      lanes={lanes}
      height={HEIGHT}
      selected={selected}
      mode="squeeze"
      snap={false}
      marks={marks}
      onSelect={(next) => harness.selections.push(next)}
      onCommit={(next, label) => harness.commits.push({ schedule: next, label })}
      onCommitAt={(next, label, selection) => harness.commitsAt.push({ schedule: next, label, selection })}
      onPreview={(next) => harness.previews.push(next)}
      onSeek={(time) => harness.seeks.push(time)}
    />,
  );

  const svg = testRoot.query('svg') as SVGSVGElement;
  stubRect(svg, TEST_WIDTH, HEIGHT);
  return { harness, svg };
}

/**
 * The drawn marks for the beat lane's entries, in document order.
 *
 * Read off the DOM rather than recomputed, so a test exercises the same pixels a finger would land
 * on. Lanes render top to bottom, so the first `entries.length` markers are the beat lane's.
 */
function beatNodes(): { x: number; y: number }[] {
  return testRoot
    .queryAll('circle.schedule-chart__node')
    .slice(0, 4)
    .map((node) => ({
      x: Number(node.getAttribute('cx')),
      y: Number(node.getAttribute('cy')),
    }));
}

function seriesPaths(): (string | null)[] {
  return testRoot.queryAll('path.schedule-chart__series').map((path) => path.getAttribute('d'));
}

/** Every validation mark, as the position it was drawn at (§6.1). */
function markPositions(): string[] {
  return testRoot
    .queryAll('circle.schedule-chart__mark')
    .map((mark) => `${mark.getAttribute('cx')},${mark.getAttribute('cy')}`);
}

describe('EditSurface', () => {
  it('draws a marker on every entry and a hollow ring on §3.5s wrap point', () => {
    mount(fourNodes());

    // Two lanes x four entries, and one wrap ring per lane.
    expect(testRoot.queryAll('circle.schedule-chart__node')).toHaveLength(8);
    expect(testRoot.queryAll('circle.schedule-chart__wrap-node')).toHaveLength(2);
    // The segment into the wrap point is dashed, because it is generated rather than authored.
    expect(testRoot.queryAll('path.schedule-chart__series--wrap')).toHaveLength(2);
  });

  it('selects the node under the pointer and commits one edit for the whole gesture', () => {
    const schedule = fourNodes();
    const { harness, svg } = mount(schedule);
    const node = beatNodes()[1];

    pointer(svg, 'pointerdown', node);
    expect(harness.selections).toEqual([[{ voice: 0, entry: 1 }]]);

    pointer(svg, 'pointermove', { x: node.x + 40, y: node.y - 20 });
    pointer(svg, 'pointermove', { x: node.x + 60, y: node.y - 30 });
    expect(harness.commits).toHaveLength(0);

    pointer(svg, 'pointerup', { x: node.x + 60, y: node.y - 30 });
    expect(harness.commits).toHaveLength(1);
    expect(harness.commits[0].label).toBe('Move node');

    // Later in time and higher in beat frequency, which is up the lane.
    const after = harness.commits[0].schedule;
    expect(entryStartTimes(after.voices[0])[1]).toBeGreaterThan(10);
    expect(after.voices[0].entries[1].beatFreq).toBeGreaterThan(12);
  });

  /**
   * The re-render budget, which is the hard constraint on this whole surface.
   *
   * `StaticPlot` is memoised on its layout, and the layout comes from the *committed* document — so
   * a gesture must not push its in-flight document back into the chart. If it ever does, these paths
   * change during the drag, `polylinePath` runs over every breakpoint of every voice on every
   * `pointermove`, and the defect measured at 1220 ms of scripting per 5 s of playback is back.
   */
  it('does not redraw the static curves while a finger is down', () => {
    const { svg } = mount(fourNodes());
    const node = beatNodes()[1];
    const before = seriesPaths();

    pointer(svg, 'pointerdown', node);
    pointer(svg, 'pointermove', { x: node.x + 30, y: node.y - 20 });
    const during = seriesPaths();
    pointer(svg, 'pointermove', { x: node.x + 60, y: node.y - 40 });

    expect(during).toEqual(before);
    expect(seriesPaths()).toEqual(before);
    // What moves instead is the overlay, which is a fixed handful of marks per lane.
    expect(testRoot.queryAll('path.schedule-chart__overlay-series').length).toBeGreaterThan(0);
  });

  /**
   * §6.1's validation marks are held to the same rule, and for the same reason: they are derived
   * from the committed document, so a drag that has committed nothing must not move them. The layer
   * is `memo`'d exactly as `StaticPlot` is, and this is what says so.
   */
  it('does not redraw the validation marks while a finger is down either', () => {
    const marks: ChartMark[] = [{ voice: 0, entry: 2, lanes: ['beat'], label: 'Beat is too high' }];
    const { svg } = mount(fourNodes(), [], ['beat', 'base'], marks);
    const node = beatNodes()[1];
    const before = markPositions();

    expect(before).toHaveLength(1);

    pointer(svg, 'pointerdown', node);
    pointer(svg, 'pointermove', { x: node.x + 30, y: node.y - 20 });
    expect(markPositions()).toEqual(before);
    pointer(svg, 'pointermove', { x: node.x + 60, y: node.y - 40 });
    expect(markPositions()).toEqual(before);
  });

  it('marks a node in every lane when the rule is not about one of them', () => {
    mount(fourNodes(), [], ['beat', 'base'], [
      { voice: 0, entry: 1, lanes: null, label: 'Negative duration' },
    ]);

    expect(markPositions()).toHaveLength(2);
  });

  /**
   * Lanes are collapsible session state, so a mark whose own lane is closed would be a warning
   * nobody ever sees. It falls back to the lanes that are open rather than vanishing.
   */
  it('draws a mark whose lane is closed in the lanes that are open', () => {
    mount(fourNodes(), [], ['beat', 'base'], [
      { voice: 0, entry: 1, lanes: ['volumeLeft', 'volumeRight'], label: 'Volume out of range' },
    ]);

    expect(markPositions()).toHaveLength(2);
  });

  it('pushes the in-flight document at the engine, rate-limited, and always the last value', async () => {
    const { harness, svg } = mount(fourNodes());
    const node = beatNodes()[1];

    pointer(svg, 'pointerdown', node);
    for (let step = 1; step <= 10; step++) {
      pointer(svg, 'pointermove', { x: node.x + step * 4, y: node.y - step });
    }

    // Leading edge only so far: ten moves inside one throttle interval are one push.
    expect(harness.previews).toHaveLength(1);

    // The trailing edge is the correctness condition — a dropped final value would leave the audio
    // somewhere the picture does not say.
    await wait(150);
    expect(harness.previews).toHaveLength(2);
    expect(harness.previews[1].voices[0].entries[1].beatFreq).toBeGreaterThan(
      harness.previews[0].voices[0].entries[1].beatFreq,
    );
  });

  /**
   * Step 5's rule refined rather than reversed: the *hit* still decides once, at pointerdown, and a
   * miss is still transport rather than editing — but what a miss means now waits for the pointer to
   * say whether it moved, because a move that begins on empty space is the marquee. A tap therefore
   * seeks on pointerup instead of on pointerdown, so starting a marquee no longer jumps the playhead.
   */
  it('seeks and deselects on a tap that hits no node', () => {
    const { harness, svg } = mount(fourNodes(), [{ voice: 0, entry: 2 }]);
    const node = beatNodes()[1];

    pointer(svg, 'pointerdown', { x: node.x, y: node.y - 60 });
    expect(harness.seeks).toHaveLength(0);

    pointer(svg, 'pointerup', { x: node.x, y: node.y - 60 });
    expect(harness.selections).toEqual([[]]);
    expect(harness.seeks).toHaveLength(1);
    expect(harness.commits).toHaveLength(0);
  });

  it('does not commit for a tap that never moved', () => {
    const { harness, svg } = mount(fourNodes());
    const node = beatNodes()[2];

    pointer(svg, 'pointerdown', node);
    pointer(svg, 'pointerup', node);

    expect(harness.selections).toEqual([[{ voice: 0, entry: 2 }]]);
    expect(harness.commits).toHaveLength(0);
  });

  /** Squeeze holds the voice's total length, which §3.7 makes the schedule's length. */
  it('squeezes by default: the neighbours and the voice length hold still', () => {
    const schedule = fourNodes();
    const { harness, svg } = mount(schedule);
    const node = beatNodes()[1];

    pointer(svg, 'pointerdown', node);
    pointer(svg, 'pointermove', { x: node.x + 50, y: node.y });
    pointer(svg, 'pointerup', { x: node.x + 50, y: node.y });

    const after = harness.commits[0].schedule.voices[0];
    const starts = entryStartTimes(after);
    expect(starts[1]).toBeGreaterThan(10);
    expect(starts[2]).toBe(20);
    expect(after.entries.reduce((sum, e) => sum + e.duration, 0)).toBeCloseTo(40, 6);
  });

  /** Alt is the momentary override, since a standing control is what a phone gets instead. */
  it('ripples when Alt is held as the pointer lands', () => {
    const schedule = fourNodes();
    const { harness, svg } = mount(schedule);
    const node = beatNodes()[1];

    pointer(svg, 'pointerdown', { ...node, altKey: true });
    pointer(svg, 'pointermove', { x: node.x + 50, y: node.y });
    pointer(svg, 'pointerup', { x: node.x + 50, y: node.y });

    const after = harness.commits[0].schedule.voices[0];
    expect(entryStartTimes(after)[2]).toBeGreaterThan(20);
    expect(after.entries.reduce((sum, e) => sum + e.duration, 0)).toBeGreaterThan(40);
  });

  /** A node may reach its neighbour and stop. The presets' 0.001 s entries make this the common case. */
  it('clamps a drag at its neighbour rather than letting a node pass it', () => {
    const { harness, svg } = mount(fourNodes());
    const node = beatNodes()[1];

    pointer(svg, 'pointerdown', node);
    pointer(svg, 'pointermove', { x: node.x + 10_000, y: node.y });
    pointer(svg, 'pointerup', { x: node.x + 10_000, y: node.y });

    const after = harness.commits[0].schedule.voices[0];
    expect(entryStartTimes(after)[1]).toBeCloseTo(20, 6);
    expect(after.entries[1].duration).toBeCloseTo(0, 6);
  });

  /** Entry 0's start is the sum of no durations. Only its value can move. */
  it('drags the first node in value alone', () => {
    const { harness, svg } = mount(fourNodes());
    const node = beatNodes()[0];

    pointer(svg, 'pointerdown', node);
    pointer(svg, 'pointermove', { x: node.x + 80, y: node.y - 30 });
    pointer(svg, 'pointerup', { x: node.x + 80, y: node.y - 30 });

    const after = harness.commits[0].schedule.voices[0];
    expect(entryStartTimes(after)).toEqual([0, 10, 20, 30]);
    expect(after.entries[0].beatFreq).toBeGreaterThan(4);
  });

  it('finishes the gesture when the platform cancels the pointer', () => {
    const { harness, svg } = mount(fourNodes());
    const node = beatNodes()[1];

    pointer(svg, 'pointerdown', node);
    pointer(svg, 'pointermove', { x: node.x + 40, y: node.y });
    pointer(svg, 'pointercancel', { x: node.x + 40, y: node.y });

    expect(harness.commits).toHaveLength(1);
    expect(testRoot.queryAll('path.schedule-chart__overlay-series')).toHaveLength(0);
  });

  it('ignores a second pointer while one is already dragging', () => {
    const { harness, svg } = mount(fourNodes());
    const node = beatNodes()[1];

    pointer(svg, 'pointerdown', { ...node, id: 1 });
    pointer(svg, 'pointermove', { x: node.x + 40, y: node.y, id: 7 });
    pointer(svg, 'pointerup', { x: node.x + 40, y: node.y, id: 7 });

    expect(harness.commits).toHaveLength(0);
  });

  /** §6.1 asks for volume L and R lanes; each writes its own field, never the other's. */
  it('drags a volume node into that channel alone', () => {
    const { harness, svg } = mount(fourNodes(), [], ['volumeLeft', 'volumeRight']);
    const node = beatNodes()[1];

    pointer(svg, 'pointerdown', node);
    pointer(svg, 'pointermove', { x: node.x, y: node.y + 25 });
    pointer(svg, 'pointerup', { x: node.x, y: node.y + 25 });

    const after = harness.commits[0].schedule.voices[0].entries[1];
    expect(harness.commits[0].label).toBe('Move volume node');
    expect(after.volumeLeft).toBeLessThan(0.5);
    expect(after.volumeRight).toBe(0.5);
    // The fixed 0-1 domain is the clamp, so a drag can never author a negative volume.
    expect(after.volumeLeft).toBeGreaterThanOrEqual(0);
  });

  it('rings the selected node in every lane it appears in', () => {
    mount(fourNodes(), [{ voice: 0, entry: 2 }]);
    expect(testRoot.queryAll('circle.schedule-chart__selected')).toHaveLength(2);
  });
});

/**
 * Keyboard operation: navigation on the chart, values in the panel.
 *
 * Nudging a value from here would have to pick one of up to four lanes and there is nothing in a
 * selection that says which; the numeric panel is ordinary form fields and is already the answer
 * §6.1 gives for exact values.
 */
describe('EditSurface by keyboard', () => {
  function key(svg: Element, name: string) {
    testRoot.act(() => {
      svg.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
    });
  }

  it('gets onto the surface, walks the nodes, and lets go', () => {
    const schedule = fourNodes();
    schedule.voices.push(makeVoice([makeEntry({}), makeEntry({})], 1));
    const { harness, svg } = mount(schedule);

    key(svg, 'ArrowRight');
    expect(harness.selections.at(-1)).toEqual([{ voice: 0, entry: 0 }]);

    testRoot.render(surfaceWith(schedule, [{ voice: 0, entry: 0 }], harness));
    key(testRoot.query('svg')!, 'ArrowRight');
    expect(harness.selections.at(-1)).toEqual([{ voice: 0, entry: 1 }]);

    testRoot.render(surfaceWith(schedule, [{ voice: 0, entry: 1 }], harness));
    key(testRoot.query('svg')!, 'ArrowDown');
    expect(harness.selections.at(-1)).toEqual([{ voice: 1, entry: 1 }]);

    testRoot.render(surfaceWith(schedule, [{ voice: 1, entry: 1 }], harness));
    key(testRoot.query('svg')!, 'Escape');
    expect(harness.selections.at(-1)).toEqual([]);
  });

  it('clamps at the ends rather than wrapping to another voice', () => {
    const schedule = fourNodes();
    const harness: Harness = { commits: [], commitsAt: [], previews: [], selections: [], seeks: [] };
    testRoot.render(surfaceWith(schedule, [{ voice: 0, entry: 0 }], harness));

    key(testRoot.query('svg')!, 'ArrowLeft');
    expect(harness.selections.at(-1)).toEqual([{ voice: 0, entry: 0 }]);
  });

  /** §6.1's "select and delete". Backspace too, since that is the key half the world reaches for. */
  it('deletes the selected node and leaves the neighbour selected, so a second press repeats', () => {
    const schedule = fourNodes();
    const harness: Harness = { commits: [], commitsAt: [], previews: [], selections: [], seeks: [] };
    testRoot.render(surfaceWith(schedule, [{ voice: 0, entry: 2 }], harness));

    key(testRoot.query('svg')!, 'Delete');

    expect(harness.commitsAt).toHaveLength(1);
    expect(harness.commitsAt[0].label).toBe('Delete node');
    expect(harness.commitsAt[0].schedule.voices[0].entries).toHaveLength(3);
    expect(harness.commitsAt[0].selection).toEqual([{ voice: 0, entry: 1 }]);

    testRoot.render(surfaceWith(schedule, [{ voice: 0, entry: 1 }], harness));
    key(testRoot.query('svg')!, 'Backspace');
    expect(harness.commitsAt).toHaveLength(2);
  });

  /** Silently, because there is no control here to grey out; the panel says why on the node. */
  it('does nothing when the selected node is the only one in its voice', () => {
    const schedule = fourNodes();
    schedule.voices = [makeVoice([makeEntry({})], 0)];
    const harness: Harness = { commits: [], commitsAt: [], previews: [], selections: [], seeks: [] };
    testRoot.render(surfaceWith(schedule, [{ voice: 0, entry: 0 }], harness));

    key(testRoot.query('svg')!, 'Delete');
    expect(harness.commitsAt).toHaveLength(0);
  });

  /** With nothing selected the read-only crosshair readout is what the arrows still do. */
  it('leaves the crosshair alone for a caller that has selected nothing', () => {
    const { svg } = mount(fourNodes());
    key(svg, 'End');
    expect(testRoot.query('.schedule-chart__tooltip')).not.toBeNull();
  });
});

function surfaceWith(schedule: Schedule, selected: Selection, harness: Harness) {
  return (
    <EditSurface
      schedule={schedule}
      lanes={['beat', 'base']}
      height={HEIGHT}
      selected={selected}
      mode="squeeze"
      snap={false}
      onSelect={(next) => harness.selections.push(next)}
      onCommit={(next, label) => harness.commits.push({ schedule: next, label })}
      onCommitAt={(next, label, selection) => harness.commitsAt.push({ schedule: next, label, selection })}
      onPreview={(next) => harness.previews.push(next)}
      onSeek={(time) => harness.seeks.push(time)}
    />
  );
}

/**
 * §6.1's marquee. A drag that begins on empty space selects what it encloses — across voices,
 * because empty space cannot name one, and across lanes, because a node is the same node in each.
 */
describe('EditSurface marquee', () => {
  function twoVoices(): Schedule {
    const schedule = fourNodes();
    schedule.voices.push(
      makeVoice(
        [
          makeEntry({ duration: 10, beatFreq: 5 }),
          makeEntry({ duration: 10, beatFreq: 11 }),
          makeEntry({ duration: 10, beatFreq: 7 }),
          makeEntry({ duration: 10, beatFreq: 9 }),
        ],
        1,
      ),
    );
    return schedule;
  }

  /** A box from just left of the plot to `x`, covering the full height of both lanes. */
  function sweep(svg: SVGSVGElement, from: { x: number; y: number }, to: { x: number; y: number }) {
    pointer(svg, 'pointerdown', from);
    pointer(svg, 'pointermove', to);
    pointer(svg, 'pointerup', to);
  }

  it('selects every node the box encloses, in every voice', () => {
    const { harness, svg } = mount(twoVoices());
    const nodes = beatNodes();

    // Empty space above the curves, sweeping down and right across the first two nodes.
    sweep(svg, { x: nodes[0].x - 20, y: 2 }, { x: nodes[1].x + 4, y: HEIGHT - 40 });

    const selected = harness.selections.at(-1)!;
    expect(selected).toContainEqual({ voice: 0, entry: 0 });
    expect(selected).toContainEqual({ voice: 0, entry: 1 });
    expect(selected).toContainEqual({ voice: 1, entry: 0 });
    expect(selected.every((node) => node.entry <= 1)).toBe(true);
  });

  it('draws the box only once the pointer has actually moved', () => {
    const { svg } = mount(twoVoices());
    const nodes = beatNodes();

    pointer(svg, 'pointerdown', { x: nodes[0].x - 20, y: 2 });
    expect(testRoot.query('rect.schedule-chart__marquee')).toBeNull();

    pointer(svg, 'pointermove', { x: nodes[1].x, y: HEIGHT - 40 });
    expect(testRoot.query('rect.schedule-chart__marquee')).not.toBeNull();

    pointer(svg, 'pointerup', { x: nodes[1].x, y: HEIGHT - 40 });
    expect(testRoot.query('rect.schedule-chart__marquee')).toBeNull();
  });

  it('adds to the selection when Shift is held, and replaces it otherwise', () => {
    const existing = [{ voice: 0, entry: 3 }];
    const { harness, svg } = mount(twoVoices(), existing);
    const nodes = beatNodes();

    pointer(svg, 'pointerdown', { x: nodes[0].x - 20, y: 2, shiftKey: true });
    pointer(svg, 'pointermove', { x: nodes[0].x + 4, y: HEIGHT - 40 });
    pointer(svg, 'pointerup', { x: nodes[0].x + 4, y: HEIGHT - 40 });

    expect(harness.selections.at(-1)).toContainEqual({ voice: 0, entry: 3 });
    expect(harness.selections.at(-1)).toContainEqual({ voice: 0, entry: 0 });
  });

  it('commits nothing — a marquee is a selection, not an edit', () => {
    const { harness, svg } = mount(twoVoices());
    const nodes = beatNodes();

    sweep(svg, { x: nodes[0].x - 20, y: 2 }, { x: nodes[2].x, y: HEIGHT - 40 });

    expect(harness.commits).toHaveLength(0);
    expect(harness.seeks).toHaveLength(0);
  });
});

/**
 * §6.1's "move a selection as a group", and the invariant that makes it affordable: a group drag
 * must not become O(nodes) per move. The static layer holding still is what says so.
 */
describe('EditSurface group drag', () => {
  const group = [
    { voice: 0, entry: 1 },
    { voice: 0, entry: 2 },
  ];

  it('moves the whole selection when one of its nodes is grabbed', () => {
    const { harness, svg } = mount(fourNodes(), group);
    const node = beatNodes()[1];

    pointer(svg, 'pointerdown', node);
    pointer(svg, 'pointermove', { x: node.x + 30, y: node.y });
    pointer(svg, 'pointerup', { x: node.x + 30, y: node.y });

    expect(harness.commits).toHaveLength(1);
    expect(harness.commits[0].label).toBe('Move nodes');
    const after = harness.commits[0].schedule.voices[0];
    const starts = entryStartTimes(after);
    // Both selected nodes moved by the same amount, and the run's internal spacing is unchanged.
    expect(starts[1]).toBeGreaterThan(10);
    expect(starts[2] - starts[1]).toBeCloseTo(10, 6);
    // Squeeze, so the voice is exactly as long as it was.
    expect(after.entries.reduce((sum, e) => sum + e.duration, 0)).toBeCloseTo(40, 6);
  });

  it('shifts every selected value by one delta, so the shape of the selection survives', () => {
    const { harness, svg } = mount(fourNodes(), group);
    const node = beatNodes()[1];

    pointer(svg, 'pointerdown', node);
    pointer(svg, 'pointermove', { x: node.x, y: node.y - 20 });
    pointer(svg, 'pointerup', { x: node.x, y: node.y - 20 });

    const before = fourNodes().voices[0].entries;
    const after = harness.commits[0].schedule.voices[0].entries;
    const delta = after[1].beatFreq - before[1].beatFreq;

    expect(delta).toBeGreaterThan(0);
    expect(after[2].beatFreq - before[2].beatFreq).toBeCloseTo(delta, 6);
    // Nodes outside the selection are untouched.
    expect(after[3].beatFreq).toBe(before[3].beatFreq);
  });

  /** The re-render budget, extended to the case that looks like it must cost O(nodes). */
  it('does not redraw the static curves while a group is being dragged', () => {
    const { svg } = mount(fourNodes(), group);
    const node = beatNodes()[1];
    const before = seriesPaths();

    pointer(svg, 'pointerdown', node);
    pointer(svg, 'pointermove', { x: node.x + 20, y: node.y - 10 });
    expect(seriesPaths()).toEqual(before);
    pointer(svg, 'pointermove', { x: node.x + 40, y: node.y - 20 });
    expect(seriesPaths()).toEqual(before);

    // What moves instead: the block, drawn once at pointerdown and translated thereafter.
    expect(testRoot.queryAll('path.schedule-chart__overlay-series').length).toBeGreaterThan(0);
  });

  it('drags a node outside the selection on its own, and selects it', () => {
    const { harness, svg } = mount(fourNodes(), group);
    const node = beatNodes()[3];

    pointer(svg, 'pointerdown', node);
    expect(harness.selections).toEqual([[{ voice: 0, entry: 3 }]]);

    pointer(svg, 'pointermove', { x: node.x + 20, y: node.y });
    pointer(svg, 'pointerup', { x: node.x + 20, y: node.y });
    expect(harness.commits[0].label).toBe('Move node');
  });

  it('rings every selected node, in every lane', () => {
    mount(fourNodes(), group);
    // Two nodes x two lanes.
    expect(testRoot.queryAll('circle.schedule-chart__selected')).toHaveLength(4);
  });

  it('deletes a whole group from the keyboard, leaving the node before it selected', () => {
    const harness: Harness = { commits: [], commitsAt: [], previews: [], selections: [], seeks: [] };
    testRoot.render(surfaceWith(fourNodes(), group, harness));

    testRoot.act(() => {
      testRoot
        .query('svg')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    });

    expect(harness.commitsAt).toHaveLength(1);
    expect(harness.commitsAt[0].label).toBe('Delete nodes');
    expect(harness.commitsAt[0].schedule.voices[0].entries).toHaveLength(2);
    expect(harness.commitsAt[0].selection).toEqual([{ voice: 0, entry: 0 }]);
  });

  /** The marquee's keyboard equivalent, without which a group is pointer-only. */
  it('extends the selection with Shift and an arrow', () => {
    const harness: Harness = { commits: [], commitsAt: [], previews: [], selections: [], seeks: [] };
    testRoot.render(surfaceWith(fourNodes(), [{ voice: 0, entry: 1 }], harness));

    testRoot.act(() => {
      testRoot
        .query('svg')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
    });

    expect(harness.selections.at(-1)).toEqual([
      { voice: 0, entry: 1 },
      { voice: 0, entry: 2 },
    ]);
  });
});

/**
 * §6.1's zoom and pan. The window is the editor's session state and reaches the chart as a prop, so
 * what a test can see is the axis it produces: the same nodes, spread further apart.
 */
describe('EditSurface zoom and pan', () => {
  function zoomButton(label: string): HTMLButtonElement {
    return testRoot.byText('.editor__view button', label) as HTMLButtonElement;
  }

  it('spreads the same nodes over more pixels, and says how far in it is', () => {
    const { svg } = mount(fourNodes());
    void svg;
    const before = beatNodes();
    expect(testRoot.query('.editor__zoom')?.textContent).toBe('1.0×');

    testRoot.click(zoomButton('+'));
    expect(testRoot.query('.editor__zoom')?.textContent).toBe('2.0×');

    const after = beatNodes();
    const gapBefore = before[1].x - before[0].x;
    const gapAfter = after.filter((node) => Number.isFinite(node.x));
    expect(gapAfter.length).toBeGreaterThan(1);
    expect(gapAfter[1].x - gapAfter[0].x).toBeCloseTo(gapBefore * 2, 0);
  });

  /** Culling: a node outside the window is not drawn at all, which is where the saving is. */
  it('draws only the nodes inside the window', () => {
    mount(fourNodes());
    expect(testRoot.queryAll('circle.schedule-chart__node')).toHaveLength(8);

    // Zoom twice about the middle: the outer nodes leave the window.
    testRoot.click(zoomButton('+'));
    testRoot.click(zoomButton('+'));
    expect(testRoot.queryAll('circle.schedule-chart__node').length).toBeLessThan(8);
  });

  it('offers a pan rail only once there is something to pan, and Fit puts it back', () => {
    mount(fourNodes());
    expect(testRoot.query('input.editor__pan')).toBeNull();

    testRoot.click(zoomButton('+'));
    expect(testRoot.query('input.editor__pan')).not.toBeNull();

    testRoot.click(zoomButton('Fit'));
    expect(testRoot.query('input.editor__pan')).toBeNull();
    expect(testRoot.queryAll('circle.schedule-chart__node')).toHaveLength(8);
  });

  it('pans the window with the rail', () => {
    const { harness: railHarness, svg: railSvg } = mount(fourNodes());
    testRoot.click(zoomButton('+'));

    // Zooming about the middle leaves the window at 10-30s; the rail moves its start.
    const rail = testRoot.query('input.editor__pan') as HTMLInputElement;
    expect(Number(rail.value)).toBeCloseTo(10, 6);

    // What moved is checked by asking what is now under the left edge: entry 1 before the pan,
    // entry 2 after it. Comparing pixels alone could not tell a pan from a redraw.
    const { harness, svg } = { harness: railHarness, svg: railSvg };
    pointer(svg, 'pointerdown', beatNodes()[0]);
    expect(harness.selections.at(-1)).toEqual([{ voice: 0, entry: 1 }]);
    pointer(svg, 'pointerup', beatNodes()[0]);

    testRoot.act(() => setInputValue(rail, '20'));

    pointer(svg, 'pointerdown', beatNodes()[0]);
    expect(harness.selections.at(-1)).toEqual([{ voice: 0, entry: 2 }]);
  });

  /**
   * Hit-testing follows the window, or a zoomed chart would edit a different node from the one under
   * the finger. Zoomed in, the first *drawn* node is no longer entry 0 — which is the point.
   */
  it('drags the node that is under the pointer at the current zoom', () => {
    const { harness, svg } = mount(fourNodes());
    testRoot.click(zoomButton('+'));

    const node = beatNodes()[0];
    pointer(svg, 'pointerdown', node);
    expect(harness.selections.at(-1)).toEqual([{ voice: 0, entry: 1 }]);

    pointer(svg, 'pointermove', { x: node.x + 20, y: node.y });
    pointer(svg, 'pointerup', { x: node.x + 20, y: node.y });

    expect(harness.commits).toHaveLength(1);
    // 20 px at 2x covers half the time it would at 1x, so the node lands nearer than it looks.
    expect(entryStartTimes(harness.commits[0].schedule.voices[0])[1]).toBeGreaterThan(10);
  });
});

/** §6.1's snap-to-grid, with the grid following the zoom and Shift inverting the control. */
describe('EditSurface snapping', () => {
  function mountSnapped(snap: boolean, selected: Selection = []) {
    const harness: Harness = { commits: [], commitsAt: [], previews: [], selections: [], seeks: [] };
    testRoot.render(
      <EditSurface
        schedule={fourNodes()}
        lanes={['beat', 'base']}
        height={HEIGHT}
        selected={selected}
        mode="squeeze"
        snap={snap}
        onSelect={(next) => harness.selections.push(next)}
        onCommit={(next, label) => harness.commits.push({ schedule: next, label })}
        onCommitAt={(next, label, selection) => harness.commitsAt.push({ schedule: next, label, selection })}
        onPreview={(next) => harness.previews.push(next)}
        onSeek={(time) => harness.seeks.push(time)}
      />,
    );
    const svg = testRoot.query('svg') as SVGSVGElement;
    stubRect(svg, TEST_WIDTH, HEIGHT);
    return { harness, svg };
  }

  it('draws the grid only when it is snapping to it', () => {
    mountSnapped(false);
    expect(testRoot.queryAll('line.schedule-chart__snap-grid')).toHaveLength(0);

    mountSnapped(true);
    expect(testRoot.queryAll('line.schedule-chart__snap-grid').length).toBeGreaterThan(0);
  });

  /** The step the grid is on at this width and zoom — what is drawn is what is snapped to. */
  function step(): number {
    return timeGridStep(40, TEST_WIDTH - 74);
  }

  it('lands a drag on a round time rather than wherever the finger stopped', () => {
    const { harness, svg } = mountSnapped(true);
    const node = beatNodes()[1];

    pointer(svg, 'pointerdown', node);
    pointer(svg, 'pointermove', { x: node.x + 37, y: node.y });
    pointer(svg, 'pointerup', { x: node.x + 37, y: node.y });

    const start = entryStartTimes(harness.commits[0].schedule.voices[0])[1];
    expect(start).not.toBe(10);
    expect(start % step()).toBeCloseTo(0, 6);
  });

  it('is inverted by Shift held as the pointer lands, exactly as Alt inverts the mode', () => {
    const { harness, svg } = mountSnapped(true);
    const node = beatNodes()[1];

    pointer(svg, 'pointerdown', { ...node, shiftKey: true });
    pointer(svg, 'pointermove', { x: node.x + 37, y: node.y });
    pointer(svg, 'pointerup', { x: node.x + 37, y: node.y });

    const start = entryStartTimes(harness.commits[0].schedule.voices[0])[1];
    expect(start % step()).not.toBeCloseTo(0, 6);
  });
});
