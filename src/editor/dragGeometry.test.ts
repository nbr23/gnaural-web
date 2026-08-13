import { describe, expect, it } from 'vitest';
import type { Entry, EntryLocation, Schedule, Voice } from '../document/types';
import { VoiceType } from '../document/types';
import { buildChartModel, layoutChart } from '../viz/geometry';
import { clamp, dragAnchors, dragOverlay } from './dragGeometry';

function entry(partial: Partial<Entry>): Entry {
  return { duration: 10, baseFreq: 200, beatFreq: 8, volumeLeft: 0.5, volumeRight: 0.5, preserved: {}, ...partial };
}

function voiceOf(id: number, beats: number[]): Voice {
  return {
    id,
    description: `Voice ${id}`,
    type: VoiceType.Binaural,
    muted: false,
    hidden: false,
    mono: false,
    entries: beats.map((beatFreq) => entry({ beatFreq })),
    preserved: {},
  };
}

function schedule(voices: Voice[] = [voiceOf(0, [4, 12, 6, 10])]): Schedule {
  return {
    title: 'T',
    description: '',
    author: '',
    loops: 1,
    masterVolume: { left: 1, right: 1 },
    stereoSwap: false,
    voices,
    preserved: {},
  };
}

const doc = schedule();
const layout = layoutChart(buildChartModel(doc, ['beat', 'base']), 640, 280);

function anchorsFor(
  index: number,
  mode: 'squeeze' | 'ripple' = 'squeeze',
  selection: EntryLocation[] = [{ voice: 0, entry: index }],
  document = doc,
  chart = layout,
) {
  return dragAnchors({
    schedule: document,
    layout: chart,
    laneId: 'beat',
    voice: 0,
    entry: index,
    selection,
    mode,
    colourOf: () => '#fff',
  });
}

/** The one block a single-node drag produces, in the grabbed lane. */
function beatLane(anchors: NonNullable<ReturnType<typeof anchorsFor>>) {
  return anchors.blocks[0].lanes[0];
}

describe('dragAnchors', () => {
  it('clamps a squeeze between the two neighbouring nodes', () => {
    const anchors = anchorsFor(1)!;
    expect(anchors.minTime).toBe(0);
    expect(anchors.maxTime).toBe(20);
  });

  it('lets a ripple run to the drawn extent, since nothing after it constrains it', () => {
    const anchors = anchorsFor(1, 'ripple')!;
    expect(anchors.minTime).toBe(0);
    expect(anchors.maxTime).toBe(layout.view.end);
  });

  /** No following segment to squeeze into, so the mode does not get a say. */
  it('treats the last node as a ripple whatever the mode says', () => {
    const anchors = anchorsFor(3)!;
    expect(anchors.maxTime).toBe(layout.view.end);
  });

  /** Entry 0's start is the sum of no durations. The drag is value-only, not refused. */
  it('pins the first node in time', () => {
    const anchors = anchorsFor(0)!;
    expect(anchors.minTime).toBe(0);
    expect(anchors.maxTime).toBe(0);
    expect(beatLane(anchors).previous).toBeNull();
  });

  it('takes its value clamp from the lane that was grabbed', () => {
    const anchors = anchorsFor(1)!;
    expect(anchors.minValue).toBe(layout.lanes[0].model.domain[0]);
    expect(anchors.maxValue).toBe(layout.lanes[0].model.domain[1]);
  });

  it('freezes anchors for every lane, not only the grabbed one', () => {
    const anchors = anchorsFor(1)!;
    expect(beatLane(anchors).laneId).toBe('beat');
    expect(anchors.blocks[0].lanes.map((lane) => lane.laneId)).toEqual(['beat', 'base']);
    expect(anchors.blocks[0].lanes[1].node.y).not.toBe(beatLane(anchors).node.y);
  });

  it('returns null for a node the document does not have', () => {
    expect(anchorsFor(99)).toBeNull();
    expect(
      dragAnchors({
        schedule: doc,
        layout,
        laneId: 'beat',
        voice: 3,
        entry: 0,
        selection: [],
        mode: 'squeeze',
        colourOf: () => '#fff',
      }),
    ).toBeNull();
  });
});

/**
 * A group drag: one block per affected voice, and the block is a path built once at pointerdown.
 * This is what keeps a selection of seventy nodes costing what a selection of one costs.
 */
describe('dragAnchors over a selection', () => {
  it('takes the whole run between the lowest and highest selected node', () => {
    const anchors = anchorsFor(1, 'squeeze', [
      { voice: 0, entry: 1 },
      { voice: 0, entry: 3 },
    ])!;

    expect(anchors.blocks).toHaveLength(1);
    expect(anchors.blocks[0]).toMatchObject({ voice: 0, first: 1, last: 3 });
    // The run reaches the voice's last entry, so it ripples whatever the control says.
    expect(anchors.blocks[0].rippling).toBe(true);
    expect(beatLane(anchors).block).not.toBeNull();
  });

  it('clamps to the tightest of every voice, so the blocks cannot drift apart', () => {
    const twoVoices = schedule([voiceOf(0, [4, 12, 6, 10]), voiceOf(1, [5, 9, 7, 11])]);
    // The second voice's first entry is short, so it is what stops the group moving earlier.
    twoVoices.voices[1].entries[0] = entry({ beatFreq: 5, duration: 2 });
    const chart = layoutChart(buildChartModel(twoVoices, ['beat', 'base']), 640, 280);

    const anchors = anchorsFor(
      1,
      'squeeze',
      [
        { voice: 0, entry: 1 },
        { voice: 1, entry: 1 },
      ],
      twoVoices,
      chart,
    )!;

    expect(anchors.blocks.map((block) => block.voice)).toEqual([0, 1]);
    // Grabbed node starts at 10; voice 1 allows only 2 s of travel back.
    expect(anchors.minTime).toBe(8);
  });

  it('is pinned outright when the selection includes a first node', () => {
    const anchors = anchorsFor(1, 'squeeze', [
      { voice: 0, entry: 0 },
      { voice: 0, entry: 1 },
    ])!;

    expect(anchors.minTime).toBe(anchors.maxTime);
  });

  it('bounds a group value drag by the extremes of the selection, not the grabbed node', () => {
    const single = anchorsFor(1)!;
    const group = anchorsFor(1, 'squeeze', [
      { voice: 0, entry: 1 },
      { voice: 0, entry: 2 },
    ])!;

    // Entry 1 is the highest beat value in the selection, so it may rise no further than the lane
    // top; entry 2 is lower, so the group may fall less far than entry 1 alone could.
    expect(group.maxValue).toBe(single.maxValue);
    expect(group.minValue).toBeGreaterThan(single.minValue);
  });

  it('drags the grabbed node alone when it is not part of the selection', () => {
    const anchors = anchorsFor(1, 'squeeze', [
      { voice: 0, entry: 2 },
      { voice: 0, entry: 3 },
    ])!;

    expect(anchors.blocks).toHaveLength(1);
    expect(anchors.blocks[0]).toMatchObject({ first: 1, last: 1 });
  });
});

describe('dragOverlay', () => {
  it('changes the value only in the lane that was grabbed', () => {
    const anchors = anchorsFor(1)!;
    const [beat, base] = dragOverlay(anchors, layout, anchors.time, anchors.value + 5);

    expect(beat.node.y).not.toBe(beatLane(anchors).node.y);
    expect(base.node.y).toBe(anchors.blocks[0].lanes[1].node.y);
    // Both follow in time, because the entry moves for every parameter it carries.
    expect(base.node.x).toBe(beat.node.x);
  });

  /** A squeeze leaves everything past the following node alone, so there is nothing to translate. */
  it('carries no tail under a squeeze', () => {
    const anchors = anchorsFor(1)!;
    const [beat] = dragOverlay(anchors, layout, 15, anchors.value);

    expect(beat.tail).toBeNull();
    expect(beat.incoming).not.toBeNull();
    expect(beat.outgoing).not.toBeNull();
  });

  /**
   * The reason a ripple is O(1) rather than O(entries): every node after the dragged one moves by
   * the same amount, so the tail is a path built once at pointerdown and translated thereafter.
   */
  it('translates a pre-built tail under a ripple, and by the node’s own delta', () => {
    const anchors = anchorsFor(1, 'ripple')!;
    const [beat] = dragOverlay(anchors, layout, 15, anchors.value);
    const dx = layout.timeScale.toPixel(15) - beatLane(anchors).node.x;

    expect(beat.tail?.dx).toBeCloseTo(dx, 6);
    expect(beat.tail?.d).toBe(beatLane(anchors).tail);
    expect(beat.tail?.d).not.toMatch(/NaN/);
  });

  it('has no incoming segment for the first node, which nothing precedes', () => {
    const anchors = anchorsFor(0)!;
    const [beat] = dragOverlay(anchors, layout, 0, anchors.value + 2);
    expect(beat.incoming).toBeNull();
    expect(beat.outgoing).not.toBeNull();
  });

  /**
   * The group equivalent of the tail trick: the block itself is a path built once and translated,
   * in both axes at once, because a uniform change in value is a uniform change in pixels.
   */
  it('translates the block rather than rebuilding it, in time and in value together', () => {
    const anchors = anchorsFor(1, 'squeeze', [
      { voice: 0, entry: 1 },
      { voice: 0, entry: 2 },
    ])!;
    const [beat, base] = dragOverlay(anchors, layout, 12, anchors.value + 1);

    expect(beat.block?.d).toBe(beatLane(anchors).block);
    expect(beat.block?.dx).toBeCloseTo(
      layout.timeScale.toPixel(12) - layout.timeScale.toPixel(anchors.time),
      6,
    );
    expect(beat.block?.dy).not.toBe(0);
    // Every other lane follows in time alone.
    expect(base.block?.dx).toBe(beat.block?.dx);
    expect(base.block?.dy).toBe(0);
  });

  it('draws one set of marks per voice in a selection that spans them', () => {
    const twoVoices = schedule([voiceOf(0, [4, 12, 6, 10]), voiceOf(1, [5, 9, 7, 11])]);
    const chart = layoutChart(buildChartModel(twoVoices, ['beat']), 640, 280);
    const anchors = anchorsFor(
      1,
      'squeeze',
      [
        { voice: 0, entry: 1 },
        { voice: 1, entry: 1 },
      ],
      twoVoices,
      chart,
    )!;

    const overlays = dragOverlay(anchors, chart, 12, anchors.value);
    expect(overlays.map((overlay) => overlay.voice)).toEqual([0, 1]);
  });
});

describe('clamp', () => {
  it('bounds on both sides and passes anything between through', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
});
