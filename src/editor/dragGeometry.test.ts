import { describe, expect, it } from 'vitest';
import type { Entry, Schedule, Voice } from '../document/types';
import { VoiceType } from '../document/types';
import { buildChartModel, layoutChart } from '../viz/geometry';
import { clamp, dragAnchors, dragOverlay } from './dragGeometry';

function entry(partial: Partial<Entry>): Entry {
  return { duration: 10, baseFreq: 200, beatFreq: 8, volumeLeft: 0.5, volumeRight: 0.5, preserved: {}, ...partial };
}

function schedule(): Schedule {
  const voice: Voice = {
    id: 0,
    description: 'Glide',
    type: VoiceType.Binaural,
    muted: false,
    hidden: false,
    mono: false,
    entries: [
      entry({ beatFreq: 4 }),
      entry({ beatFreq: 12 }),
      entry({ beatFreq: 6 }),
      entry({ beatFreq: 10 }),
    ],
    preserved: {},
  };
  return {
    title: 'T',
    description: '',
    author: '',
    loops: 1,
    masterVolume: { left: 1, right: 1 },
    stereoSwap: false,
    voices: [voice],
    preserved: {},
  };
}

const doc = schedule();
const layout = layoutChart(buildChartModel(doc, ['beat', 'base']), 640, 280);

function anchorsFor(index: number, mode: 'squeeze' | 'ripple' = 'squeeze') {
  return dragAnchors(doc, layout, 'beat', 0, index, mode, '#fff');
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
    expect(anchors.maxTime).toBe(layout.model.duration);
  });

  /** No following segment to squeeze into, so the mode does not get a say. */
  it('treats the last node as a ripple whatever the mode says', () => {
    const anchors = anchorsFor(3)!;
    expect(anchors.maxTime).toBe(layout.model.duration);
  });

  /** Entry 0's start is the sum of no durations. The drag is value-only, not refused. */
  it('pins the first node in time', () => {
    const anchors = anchorsFor(0)!;
    expect(anchors.minTime).toBe(0);
    expect(anchors.maxTime).toBe(0);
    expect(anchors.lanes[0].previous).toBeNull();
  });

  it('takes its value clamp from the lane that was grabbed', () => {
    const anchors = anchorsFor(1)!;
    expect(anchors.minValue).toBe(layout.lanes[0].model.domain[0]);
    expect(anchors.maxValue).toBe(layout.lanes[0].model.domain[1]);
  });

  it('freezes anchors for every lane, not only the grabbed one', () => {
    const anchors = anchorsFor(1)!;
    expect(anchors.lanes.map((lane) => lane.laneId)).toEqual(['beat', 'base']);
    expect(anchors.lanes[1].node.y).not.toBe(anchors.lanes[0].node.y);
  });

  it('returns null for a node the document does not have', () => {
    expect(dragAnchors(doc, layout, 'beat', 0, 99, 'squeeze', '#fff')).toBeNull();
    expect(dragAnchors(doc, layout, 'beat', 3, 0, 'squeeze', '#fff')).toBeNull();
  });
});

describe('dragOverlay', () => {
  it('changes the value only in the lane that was grabbed', () => {
    const anchors = anchorsFor(1)!;
    const [beat, base] = dragOverlay(anchors, layout, anchors.time, anchors.value + 5, 'squeeze', false);

    expect(beat.node.y).not.toBe(anchors.lanes[0].node.y);
    expect(base.node.y).toBe(anchors.lanes[1].node.y);
    // Both follow in time, because the entry moves for every parameter it carries.
    expect(base.node.x).toBe(beat.node.x);
  });

  /** A squeeze leaves everything past the following node alone, so there is nothing to translate. */
  it('carries no tail under a squeeze', () => {
    const anchors = anchorsFor(1)!;
    const [beat] = dragOverlay(anchors, layout, 15, anchors.value, 'squeeze', false);

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
    const [beat] = dragOverlay(anchors, layout, 15, anchors.value, 'ripple', false);
    const dx = layout.timeScale.toPixel(15) - anchors.lanes[0].node.x;

    expect(beat.tail?.dx).toBeCloseTo(dx, 6);
    expect(beat.tail?.d).toBe(anchors.lanes[0].tail);
    expect(beat.tail?.d).not.toMatch(/NaN/);
  });

  it('has no incoming segment for the first node, which nothing precedes', () => {
    const anchors = anchorsFor(0)!;
    const [beat] = dragOverlay(anchors, layout, 0, anchors.value + 2, 'squeeze', false);
    expect(beat.incoming).toBeNull();
    expect(beat.outgoing).not.toBeNull();
  });
});

describe('clamp', () => {
  it('bounds on both sides and passes anything between through', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
});
