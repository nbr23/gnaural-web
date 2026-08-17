import { useMemo } from 'react';
import { Panel } from '../app/Panel';
import { LIBRARY, navigate } from '../app/routing';
import { useCoarsePointer, useWideLayout } from '../app/useMediaQuery';
import type { Schedule } from '../document/types';
import type { ScheduleWarning } from '../document/warnings';
import { scheduleWarnings } from '../document/warnings';
import type { NoiseLayerSettings } from '../engine/engine';
import { ScheduleChart } from '../viz/ScheduleChart';
import { WarningList } from './WarningList';
import {
  PlayPauseButton,
  SeekButton,
  StopButton,
  VolumeSlider,
  WakeLockToggle,
} from './Controls';
import { ExportPanel } from './ExportPanel';
import { NoisePanel } from './NoisePanel';
import { Readout } from './Readout';
import { Timeline } from './Timeline';
import { VoiceList } from './VoiceList';
import type { Player } from './usePlayer';
import { SEEK_STEP_SECONDS } from './usePlayer';
import './PlayerView.css';

/**
 * How tall the plot is drawn, in px — a number rather than a rule, since the SVG is laid out from
 * it. Short enough on a phone that the transport stays on the same screen as the chart, taller
 * where the chart sits in a column of its own.
 */
const CHART_HEIGHT = { narrow: 200, wide: 320 };

export interface PlayerViewProps {
  schedule: Schedule;
  /** What the *file* contained (§3.4). What the *program* does is derived here from the model. */
  warnings: ScheduleWarning[];
  subtitle?: string;
  player: Player;
  masterGain: number;
  onMasterGainChange(value: number): void;
  noise: NoiseLayerSettings;
  onNoiseChange(noise: NoiseLayerSettings): void;
  /** True for the four presets that lost their ambient bed — see `NoisePanel`. */
  lostAmbientBed?: boolean;
  exportSampleRate: number;
  onExportSampleRateChange(rate: number): void;
  wakeLock: boolean;
  onWakeLockChange(enabled: boolean): void;
  /** Offered only for a program the library does not already hold — today, a shared link. */
  onSaveToLibrary?: () => void;
  /** Fork this program into a draft and open the editor (§6.1). Never edits it in place. */
  onEdit: () => void;
}

export function PlayerView({
  schedule,
  warnings,
  subtitle,
  player,
  masterGain,
  onMasterGainChange,
  noise,
  onNoiseChange,
  lostAmbientBed,
  exportSampleRate,
  onExportSampleRateChange,
  wakeLock,
  onWakeLockChange,
  onSaveToLibrary,
  onEdit,
}: PlayerViewProps) {
  const title = schedule.title.trim() || 'Untitled program';

  // The file's own oddities (§3.4, produced at parse time) and what the program will actually do
  // (§3.3, §3.7, derived here) are the same statement to a listener, so they read as one list.
  const all = useMemo(() => [...warnings, ...scheduleWarnings(schedule)], [warnings, schedule]);
  const silent = all.some((warning) => warning.kind === 'nothing-to-play');

  const coarse = useCoarsePointer();
  const wide = useWideLayout();

  return (
    <div className="player">
      {/* Everything about *listening*. On a wide screen this column stays where it is while the
          panels beside it scroll, so the chart and the transport are never scrolled away from. */}
      <div className="player__stage">
        <header className="player__header">
          <button type="button" className="back-link" onClick={() => navigate(LIBRARY)}>
            ← Library
          </button>
          <h1 className="player__title">{title}</h1>
          {(schedule.author || subtitle) && (
            <p className="player__byline">{subtitle ?? schedule.author}</p>
          )}
        </header>

        {/* With the program rather than with the panels, and never inside one: a file that will
            not play the way it reads has to say so where the Play button is. */}
        <WarningList warnings={all} />

        {/* No seek on touch: a plot wide enough to read is wide enough to brush past, and the
            timeline below is the deliberate way to move the playhead. See `useCoarsePointer`. */}
        <ScheduleChart
          schedule={schedule}
          currentTime={player.offset}
          height={wide ? CHART_HEIGHT.wide : CHART_HEIGHT.narrow}
          onSeek={coarse ? undefined : player.seek}
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

        {/* Sticky to the bottom of the viewport on a phone: the panels below run long, and the one
            control nobody should have to scroll for is the one that stops the sound. */}
        <div className="player__transport">
          <SeekButton
            direction="back"
            onClick={() => player.seek(player.offset - SEEK_STEP_SECONDS)}
          />
          {/* Nothing renderable means Play would produce silence for the schedule's full length.
              The warning above says why; a disabled button is what stops it being a mystery. */}
          <PlayPauseButton
            playing={player.playing}
            disabled={silent}
            onClick={() => (player.playing ? player.pause() : player.play())}
          />
          <SeekButton
            direction="forward"
            onClick={() => player.seek(player.offset + SEEK_STEP_SECONDS)}
          />
          <StopButton onClick={player.stop} />
          {/* The elapsed time is on the timeline directly above, where it sits against the
              duration it is a fraction of. Volume takes the space it used to: it belongs with the
              controls you reach for while listening, and on a phone that row is the fixed one. */}
          <VolumeSlider value={masterGain} onChange={onMasterGainChange} />
        </div>

        {/* Below the transport, because it is not what anyone came here to look at: the chart
            above already draws every one of these curves for the whole program, and this only
            says where on them the playhead is. Last in the column on a phone, where the transport
            is fixed to the viewport and this scrolls under nothing. */}
        <Readout schedule={schedule} offset={player.offset} gates={player.voiceGates} />
      </div>

      {/* Everything *about* the program. Folded away by default on a phone, where the page would
          otherwise be several screens of controls nobody asked for yet. */}
      <div className="player__aside">
        {schedule.description.trim() && (
          <p className="player__description">{schedule.description.trim()}</p>
        )}

        <div className="player__actions">
          {onSaveToLibrary && (
            <button type="button" className="button" onClick={onSaveToLibrary}>
              Add to library
            </button>
          )}
          {/* A copy, always: a bundled program is read-only by nature, and editing an imported one
              in place would rewrite the file someone brought in. */}
          <button type="button" className="button" onClick={onEdit}>
            Edit a copy
          </button>
        </div>

        {schedule.voices.length > 1 && (
          <Panel title="Voices" badge={schedule.voices.length} defaultOpen={wide}>
            <VoiceList
              schedule={schedule}
              gates={player.voiceGates}
              onToggleMute={player.toggleMute}
              onToggleSolo={player.toggleSolo}
            />
          </Panel>
        )}

        <Panel title="Sound" badge={noise.gain > 0 ? 'noise on' : undefined} defaultOpen={wide}>
          <NoisePanel noise={noise} onChange={onNoiseChange} lostAmbientBed={lostAmbientBed} />
          <WakeLockToggle enabled={wakeLock} onChange={onWakeLockChange} />
        </Panel>

        <Panel title="Export & share" defaultOpen={wide}>
          <ExportPanel
            schedule={schedule}
            sampleRate={exportSampleRate}
            onSampleRateChange={onExportSampleRateChange}
            noise={noise}
          />
        </Panel>

        <p className="player__note">Headphones required — the beat only exists between two ears.</p>
      </div>
    </div>
  );
}
