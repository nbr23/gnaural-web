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
 * Shared across every view that plays something (player, editor, Live, now-playing bar), so their
 * transport and wake-lock copy can't drift out of sync.
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
