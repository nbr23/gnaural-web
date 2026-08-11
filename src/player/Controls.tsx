import './Controls.css';

/**
 * The two listening controls both the player and Live mode carry.
 *
 * Shared rather than duplicated because the wake-lock copy is load-bearing — it says playback
 * survives the screen going off, which is the thing people most need told and the thing §5.3
 * spent a hardware session confirming. Two copies of that sentence would eventually disagree.
 */

export function VolumeSlider({
  value,
  onChange,
}: {
  value: number;
  onChange(value: number): void;
}) {
  return (
    <label className="volume">
      <span>Volume</span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

export function WakeLockToggle({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange(enabled: boolean): void;
}) {
  return (
    <label className="wake-lock">
      <input
        type="checkbox"
        checked={enabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        Keep the screen on
        <small> — off by default; playback continues with the screen off either way.</small>
      </span>
    </label>
  );
}
