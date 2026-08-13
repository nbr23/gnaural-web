import type { LaneDomains, LaneId } from '../viz/geometry';

export interface LaneRangesProps {
  /** The open lanes, in the order they are drawn. A closed lane has no axis to override. */
  lanes: readonly LaneId[];
  labels: Record<LaneId, string>;
  domains: LaneDomains;
  /** The fitted domain the chart would use, so a field shows what it is overriding. */
  fitted: Partial<Record<LaneId, readonly [number, number]>>;
  onChange(domains: LaneDomains): void;
}

/**
 * §6.1's "vertical axis auto-scales to content with a manual override".
 *
 * **The override is what makes a value reachable by dragging at all.** A drag can only reach what is
 * drawn, and a lane is fitted to its own data: step 5 raised `EDITOR_DOMAIN_PADDING` to 0.35 as an
 * interim answer, but a voice sitting at 200–210 Hz still cannot be dragged to 400 whatever the
 * padding is. Typing the range is the general answer, and the numeric panel remains the exact one.
 *
 * Session state, outside the history stack, like the open lanes and the view window: what is on
 * screen is a property of the person editing, not of the document.
 */
export function LaneRanges({ lanes, labels, domains, fitted, onChange }: LaneRangesProps) {
  const set = (lane: LaneId, index: 0 | 1, raw: string) => {
    const current = domains[lane] ?? fitted[lane] ?? [0, 1];
    const value = Number(raw);
    if (!Number.isFinite(value)) return;

    const next: [number, number] = [current[0], current[1]];
    next[index] = value;
    // A collapsed or inverted range would divide by zero in `linearScale`; refuse it rather than
    // draw a lane nobody can use.
    if (next[1] <= next[0]) return;
    onChange({ ...domains, [lane]: next });
  };

  const fit = (lane: LaneId) => {
    const { [lane]: _dropped, ...rest } = domains;
    onChange(rest);
  };

  return (
    <div className="editor__ranges">
      <span className="editor__lanes-label">Range</span>
      {lanes.map((lane) => {
        const shown = domains[lane] ?? fitted[lane] ?? [0, 1];
        return (
          <span className="editor__range" key={lane}>
            <span className="editor__range-name">{labels[lane]}</span>
            <input
              type="number"
              inputMode="decimal"
              aria-label={`${labels[lane]} minimum`}
              value={round(shown[0])}
              onChange={(event) => set(lane, 0, event.target.value)}
            />
            <input
              type="number"
              inputMode="decimal"
              aria-label={`${labels[lane]} maximum`}
              value={round(shown[1])}
              onChange={(event) => set(lane, 1, event.target.value)}
            />
            <button
              type="button"
              className="button"
              disabled={!domains[lane]}
              onClick={() => fit(lane)}
            >
              Fit
            </button>
          </span>
        );
      })}
    </div>
  );
}

/** Enough digits to be honest about a fitted domain without showing a float's full tail. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}
