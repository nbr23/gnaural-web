import { LIBRARY, navigate } from '../app/routing';
import type { Schedule } from '../document/types';
import { ScheduleChart } from '../viz/ScheduleChart';
import { ExportPanel } from './ExportPanel';
import { Readout } from './Readout';
import { Timeline } from './Timeline';
import { VoiceList } from './VoiceList';
import type { Player } from './usePlayer';
import './PlayerView.css';

const SEEK_STEP_SECONDS = 30;

export interface PlayerViewProps {
  schedule: Schedule;
  subtitle?: string;
  player: Player;
  masterGain: number;
  onMasterGainChange(value: number): void;
  exportSampleRate: number;
  onExportSampleRateChange(rate: number): void;
  wakeLock: boolean;
  onWakeLockChange(enabled: boolean): void;
  /** Offered only for a program the library does not already hold — today, a shared link. */
  onSaveToLibrary?: () => void;
}

export function PlayerView({
  schedule,
  subtitle,
  player,
  masterGain,
  onMasterGainChange,
  exportSampleRate,
  onExportSampleRateChange,
  wakeLock,
  onWakeLockChange,
  onSaveToLibrary,
}: PlayerViewProps) {
  const title = schedule.title.trim() || 'Untitled program';

  return (
    <div className="player">
      <header className="player__header">
        <button type="button" className="player__back" onClick={() => navigate(LIBRARY)}>
          ← Library
        </button>
        <h1 className="player__title">{title}</h1>
        {(schedule.author || subtitle) && (
          <p className="player__byline">{subtitle ?? schedule.author}</p>
        )}
        {onSaveToLibrary && (
          <button type="button" className="button" onClick={onSaveToLibrary}>
            Add to library
          </button>
        )}
      </header>

      {schedule.description.trim() && (
        <p className="player__description">{schedule.description.trim()}</p>
      )}

      <Readout schedule={schedule} offset={player.offset} />

      <ScheduleChart
        schedule={schedule}
        currentTime={player.offset}
        onSeek={player.seek}
        className="player__chart"
      />

      <Timeline offset={player.offset} duration={player.duration} onSeek={player.seek} />

      <div className="player__transport">
        <button
          type="button"
          className="button"
          onClick={() => player.seek(player.offset - SEEK_STEP_SECONDS)}
        >
          −{SEEK_STEP_SECONDS}s
        </button>
        <button
          type="button"
          className="button button--primary"
          onClick={() => (player.playing ? player.pause() : player.play())}
        >
          {player.playing ? 'Pause' : 'Play'}
        </button>
        <button
          type="button"
          className="button"
          onClick={() => player.seek(player.offset + SEEK_STEP_SECONDS)}
        >
          +{SEEK_STEP_SECONDS}s
        </button>
        <button type="button" className="button" onClick={player.stop}>
          Stop
        </button>
      </div>

      <label className="player__volume">
        <span>Volume</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={masterGain}
          onChange={(event) => onMasterGainChange(Number(event.target.value))}
        />
      </label>

      <label className="player__wake-lock">
        <input
          type="checkbox"
          checked={wakeLock}
          onChange={(event) => onWakeLockChange(event.target.checked)}
        />
        <span>
          Keep the screen on
          <small> — off by default; playback continues with the screen off either way.</small>
        </span>
      </label>

      {schedule.voices.length > 1 && (
        <VoiceList
          schedule={schedule}
          gates={player.voiceGates}
          onToggleMute={player.toggleMute}
          onToggleSolo={player.toggleSolo}
        />
      )}

      <ExportPanel
        schedule={schedule}
        sampleRate={exportSampleRate}
        onSampleRateChange={onExportSampleRateChange}
      />

      <p className="player__note">Headphones required — the beat only exists between two ears.</p>
    </div>
  );
}
