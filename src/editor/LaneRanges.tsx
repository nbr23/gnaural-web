import type { LaneDomains, LaneId } from '../viz/geometry';

export interface LaneRangesProps {
  lanes: readonly LaneId[];
  labels: Record<LaneId, string>;
  domains: LaneDomains;
  fitted: Partial<Record<LaneId, readonly [number, number]>>;
  onChange(domains: LaneDomains): void;
}

// Manual override for a lane's axis: a drag can only reach what's drawn, and a lane fitted to its
// own data may sit far from where a value needs to go, so typing the range is the general answer.
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

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
