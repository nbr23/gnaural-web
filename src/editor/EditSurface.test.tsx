import { describe, expect, it } from 'vitest';
import { entryStartTimes } from '../document/timing';
import type { Entry, Schedule, Voice } from '../document/types';
import { VoiceType } from '../document/types';
import { TEST_WIDTH } from '../test-setup';
import { pointer, setupRoot, stubRect, wait } from '../test-utils';
import type { LaneId } from '../viz/geometry';
import { EditSurface } from './EditSurface';
import type { NodeRef } from './history';

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
  commitsAt: { schedule: Schedule; label: string; selection: NodeRef | null }[];
  previews: Schedule[];
  selections: (NodeRef | null)[];
  seeks: number[];
}

function mount(
  schedule: Schedule,
  selected: NodeRef | null = null,
  lanes: LaneId[] = ['beat', 'base'],
) {
  const harness: Harness = { commits: [], commitsAt: [], previews: [], selections: [], seeks: [] };

  testRoot.render(
    <EditSurface
      schedule={schedule}
      lanes={lanes}
      height={HEIGHT}
      selected={selected}
      mode="squeeze"
      onSelect={(node) => harness.selections.push(node)}
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
    expect(harness.selections).toEqual([{ voice: 0, entry: 1 }]);

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
   * D5: the hit decides once, at pointerdown, and the gesture follows that decision. A miss seeks
   * and clears the selection; it deliberately does not scrub, because a move that began on empty
   * space is step 8's marquee.
   */
  it('seeks and deselects on a pointer that hits no node', () => {
    const { harness, svg } = mount(fourNodes(), { voice: 0, entry: 2 });
    const node = beatNodes()[1];

    pointer(svg, 'pointerdown', { x: node.x, y: node.y - 60 });
    expect(harness.selections).toEqual([null]);
    expect(harness.seeks).toHaveLength(1);

    pointer(svg, 'pointermove', { x: node.x + 100, y: node.y - 60 });
    pointer(svg, 'pointerup', { x: node.x + 100, y: node.y - 60 });
    expect(harness.seeks).toHaveLength(1);
    expect(harness.commits).toHaveLength(0);
  });

  it('does not commit for a tap that never moved', () => {
    const { harness, svg } = mount(fourNodes());
    const node = beatNodes()[2];

    pointer(svg, 'pointerdown', node);
    pointer(svg, 'pointerup', node);

    expect(harness.selections).toEqual([{ voice: 0, entry: 2 }]);
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
    const { harness, svg } = mount(fourNodes(), null, ['volumeLeft', 'volumeRight']);
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
    mount(fourNodes(), { voice: 0, entry: 2 });
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
    expect(harness.selections.at(-1)).toEqual({ voice: 0, entry: 0 });

    testRoot.render(surfaceWith(schedule, { voice: 0, entry: 0 }, harness));
    key(testRoot.query('svg')!, 'ArrowRight');
    expect(harness.selections.at(-1)).toEqual({ voice: 0, entry: 1 });

    testRoot.render(surfaceWith(schedule, { voice: 0, entry: 1 }, harness));
    key(testRoot.query('svg')!, 'ArrowDown');
    expect(harness.selections.at(-1)).toEqual({ voice: 1, entry: 1 });

    testRoot.render(surfaceWith(schedule, { voice: 1, entry: 1 }, harness));
    key(testRoot.query('svg')!, 'Escape');
    expect(harness.selections.at(-1)).toBeNull();
  });

  it('clamps at the ends rather than wrapping to another voice', () => {
    const schedule = fourNodes();
    const harness: Harness = { commits: [], commitsAt: [], previews: [], selections: [], seeks: [] };
    testRoot.render(surfaceWith(schedule, { voice: 0, entry: 0 }, harness));

    key(testRoot.query('svg')!, 'ArrowLeft');
    expect(harness.selections.at(-1)).toEqual({ voice: 0, entry: 0 });
  });

  /** §6.1's "select and delete". Backspace too, since that is the key half the world reaches for. */
  it('deletes the selected node and leaves the neighbour selected, so a second press repeats', () => {
    const schedule = fourNodes();
    const harness: Harness = { commits: [], commitsAt: [], previews: [], selections: [], seeks: [] };
    testRoot.render(surfaceWith(schedule, { voice: 0, entry: 2 }, harness));

    key(testRoot.query('svg')!, 'Delete');

    expect(harness.commitsAt).toHaveLength(1);
    expect(harness.commitsAt[0].label).toBe('Delete node');
    expect(harness.commitsAt[0].schedule.voices[0].entries).toHaveLength(3);
    expect(harness.commitsAt[0].selection).toEqual({ voice: 0, entry: 1 });

    testRoot.render(surfaceWith(schedule, { voice: 0, entry: 1 }, harness));
    key(testRoot.query('svg')!, 'Backspace');
    expect(harness.commitsAt).toHaveLength(2);
  });

  /** Silently, because there is no control here to grey out; the panel says why on the node. */
  it('does nothing when the selected node is the only one in its voice', () => {
    const schedule = fourNodes();
    schedule.voices = [makeVoice([makeEntry({})], 0)];
    const harness: Harness = { commits: [], commitsAt: [], previews: [], selections: [], seeks: [] };
    testRoot.render(surfaceWith(schedule, { voice: 0, entry: 0 }, harness));

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

function surfaceWith(schedule: Schedule, selected: NodeRef | null, harness: Harness) {
  return (
    <EditSurface
      schedule={schedule}
      lanes={['beat', 'base']}
      height={HEIGHT}
      selected={selected}
      mode="squeeze"
      onSelect={(node) => harness.selections.push(node)}
      onCommit={(next, label) => harness.commits.push({ schedule: next, label })}
      onCommitAt={(next, label, selection) => harness.commitsAt.push({ schedule: next, label, selection })}
      onPreview={(next) => harness.previews.push(next)}
      onSeek={(time) => harness.seeks.push(time)}
    />
  );
}
