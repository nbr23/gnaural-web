import {
  PauseIcon,
  PlayIcon,
  SeekBackIcon,
  SeekForwardIcon,
  StopIcon,
} from '../app/icons';
import { SEEK_STEP_SECONDS } from './usePlayer';
import './Controls.css';

/**
 * The controls every view that plays something carries: the transport, the volume and the wake
 * lock.
 *
 * Shared rather than duplicated because the wake-lock copy is load-bearing — it says playback
 * survives the screen going off, which is the thing people most need told and the thing §5.3
 * spent a hardware session confirming. Two copies of that sentence would eventually disagree. The
 * transport is here for the same reason one step down: four surfaces press play (the player, the
 * editor, Live and the now-playing bar) and they must not disagree about what the icon means.
 *
 * **Icons with the word underneath.** The glyph is what you see; a `visually-hidden` span carries
 * the name, so the accessible name is still "Play" rather than nothing, and `title` puts it in a
 * tooltip — which is the only place a seek button can say *how far* it seeks now that it no longer
 * says "−30s" on its face.
 */

export function PlayPauseButton({
  playing,
  disabled,
  onClick,
}: {
  playing: boolean;
  disabled?: boolean;
  onClick(): void;
}) {
  const label = playing ? 'Pause' : 'Play';
  return (
    <button
      type="button"
      className="button button--icon button--primary"
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {playing ? <PauseIcon /> : <PlayIcon />}
      <span className="visually-hidden">{label}</span>
    </button>
  );
}

export function StopButton({ onClick }: { onClick(): void }) {
  return (
    <button type="button" className="button button--icon" title="Stop" onClick={onClick}>
      <StopIcon />
      <span className="visually-hidden">Stop</span>
    </button>
  );
}

/** Built from `SEEK_STEP_SECONDS`, so the tooltip cannot come to disagree with the jump. */
export function SeekButton({
  direction,
  onClick,
}: {
  direction: 'back' | 'forward';
  onClick(): void;
}) {
  const label =
    direction === 'back'
      ? `Back ${SEEK_STEP_SECONDS} seconds`
      : `Forward ${SEEK_STEP_SECONDS} seconds`;

  return (
    <button type="button" className="button button--icon" title={label} onClick={onClick}>
      {direction === 'back' ? <SeekBackIcon /> : <SeekForwardIcon />}
      <span className="visually-hidden">{label}</span>
    </button>
  );
}

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
