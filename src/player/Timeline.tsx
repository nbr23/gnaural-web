import { useState } from 'react';
import { formatClock } from '../app/format';

export interface TimelineProps {
  offset: number;
  duration: number;
  onSeek: (offset: number) => void;
}

/**
 * A real `<input type="range">` rather than a custom track, for free keyboard operation and touch
 * targets. While dragging, the input holds its own value rather than `offset` — the rAF poll
 * writes `offset` every frame, and letting that win would drag the thumb out from under the finger.
 */
export function Timeline({ offset, duration, onSeek }: TimelineProps) {
  const [scrubbing, setScrubbing] = useState<number | null>(null);
  const value = scrubbing ?? offset;

  return (
    <div className="timeline">
      <input
        className="timeline__range"
        type="range"
        min={0}
        max={duration || 1}
        step={0.1}
        value={value}
        aria-label="Seek"
        aria-valuetext={formatClock(value)}
        onChange={(event) => {
          const next = Number(event.target.value);
          setScrubbing(next);
          onSeek(next);
        }}
        onPointerUp={() => setScrubbing(null)}
        onKeyUp={() => setScrubbing(null)}
        onBlur={() => setScrubbing(null)}
      />
      <div className="timeline__times">
        <span>{formatClock(value)}</span>
        <span>−{formatClock(Math.max(0, duration - value))}</span>
      </div>
    </div>
  );
}
