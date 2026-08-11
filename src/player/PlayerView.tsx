import { useMemo } from 'react';
import { LIBRARY, navigate } from '../app/routing';
import type { Schedule } from '../document/types';
import type { ScheduleWarning } from '../document/warnings';
import { scheduleWarnings } from '../document/warnings';
import { ScheduleChart } from '../viz/ScheduleChart';
import { WarningList } from './WarningList';
import { ExportPanel } from './ExportPanel';
import { Readout } from './Readout';
import { Timeline } from './Timeline';
import { VoiceList } from './VoiceList';
import type { Player } from './usePlayer';
import './PlayerView.css';

const SEEK_STEP_SECONDS = 30;

export interface PlayerViewProps {
  schedule: Schedule;
  /** What the *file* contained (§3.4). What the *program* does is derived here from the model. */
  warnings: ScheduleWarning[];
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
  warnings,
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

  // The file's own oddities (§3.4, produced at parse time) and what the program will actually do
  // (§3.3, §3.7, derived here) are the same statement to a listener, so they read as one list.
  const all = useMemo(() => [...warnings, ...scheduleWarnings(schedule)], [warnings, schedule]);
  const silent = all.some((warning) => warning.kind === 'nothing-to-play');

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

      <WarningList warnings={all} />

      <Readout schedule={schedule} offset={player.offset} />

      <ScheduleChart
        schedule={schedule}
        currentTime={player.offset}
        onSeek={player.seek}
        className="player__chart"
      />

      <Timeline offset={player.offset} duration={player.duration} onSeek={player.seek} />

      {/* The timeline plots one pass, because that is the curve; a repeating schedule replays it
          rather than extending it (§3.2). Which pass you are on is the part the timeline cannot
          show. */}
      {schedule.loops <= 0 ? (
        <p className="player__passes">Repeats until stopped — pass {player.pass + 1}</p>
      ) : (
        player.passCount > 1 && (
          <p className="player__passes">
            Pass {player.pass + 1} of {player.passCount}
          </p>
        )
      )}

      <div className="player__transport">
        <button
          type="button"
          className="button"
          onClick={() => player.seek(player.offset - SEEK_STEP_SECONDS)}
        >
          −{SEEK_STEP_SECONDS}s
        </button>
        {/* Nothing renderable means Play would produce silence for the schedule's full length.
            The warning above says why; a disabled button is what stops it being a mystery. */}
        <button
          type="button"
          className="button button--primary"
          disabled={silent}
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
