import { useMemo } from 'react';
import { Panel } from '../app/Panel';
import { LIBRARY, navigate } from '../app/routing';
import { useWideLayout } from '../app/useMediaQuery';
import type { Schedule } from '../document/types';
import { isAmbientType } from '../document/types';
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

/** Short enough on a phone that the transport stays on screen with the chart. */
const CHART_HEIGHT = { narrow: 200, wide: 320 };

export interface PlayerViewProps {
  schedule: Schedule;
  /** What the *file* contained. What the *program* does is derived here from the model. */
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
  /** Fork this program into a draft and open the editor. Never edits it in place. */
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

  // The file's own oddities and what the program will actually do are the same statement to a
  // listener, so they read as one list.
  const all = useMemo(() => [...warnings, ...scheduleWarnings(schedule)], [warnings, schedule]);
  const silent = all.some((warning) => warning.kind === 'nothing-to-play');

  const wide = useWideLayout();

  // The program's own bed of noise, if it carries one. A hidden voice counts — `hidden` is editor
  // presentation state and the engine plays it regardless — but one muted in the document doesn't
  // sound at all, so it is not a bed anybody is hearing.
  const bedVoices = useMemo(
    () =>
      schedule.voices
        .map((voice, index) => ({ voice, index }))
        .filter(({ voice }) => isAmbientType(voice.type) && !voice.muted),
    [schedule],
  );

  const { voiceGates, toggleMute } = player;
  const ownBed = useMemo(() => {
    if (bedVoices.length === 0) return undefined;

    const muted = bedVoices.every(({ index }) => voiceGates[index]?.muted ?? false);
    return {
      label: bedLabel(bedVoices.map(({ voice, index }) => voiceName(voice.description, index))),
      muted,
      // Session mute, one voice at a time, through the same gate the voice list uses. Only the
      // voices not already in the target state are touched.
      onToggleMute: () => {
        for (const { index } of bedVoices) {
          if ((voiceGates[index]?.muted ?? false) === muted) toggleMute(index);
        }
      },
    };
  }, [bedVoices, toggleMute, voiceGates]);

  return (
    <div className="player">
      {/* On a wide screen this column stays put while the panels beside it scroll, so the chart
          and transport are never scrolled away from. */}
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

        {/* Outside any panel: a file that won't play the way it reads has to say so where the
            Play button is. */}
        <WarningList warnings={all} />

        {/* The plot reads values out; it never moves the playhead. A picture wide enough to read is
            wide enough to brush past, so the timeline below is the only way to seek. */}
        <ScheduleChart
          schedule={schedule}
          currentTime={player.offset}
          height={wide ? CHART_HEIGHT.wide : CHART_HEIGHT.narrow}
          className="player__chart"
        />

        <Timeline offset={player.offset} duration={player.duration} onSeek={player.seek} />

        {/* The timeline plots one pass; a repeating schedule replays it rather than extending it.
            Which pass you're on is the part the timeline can't show. */}
        {schedule.loops <= 0 ? (
          <p className="player__passes">Repeats until stopped — pass {player.pass + 1}</p>
        ) : (
          player.passCount > 1 && (
            <p className="player__passes">
              Pass {player.pass + 1} of {player.passCount}
            </p>
          )
        )}

        {/* Sticky to the bottom of the viewport on a phone: the one control nobody should have to
            scroll for is the one that stops the sound. */}
        <div className="player__transport">
          <SeekButton
            direction="back"
            onClick={() => player.seek(player.offset - SEEK_STEP_SECONDS)}
          />
          {/* Nothing renderable means Play would produce silence for the schedule's full length. */}
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
          <VolumeSlider value={masterGain} onChange={onMasterGainChange} />
        </div>

        {/* Below the transport: the chart above already draws these curves for the whole program,
            and this only says where on them the playhead is. */}
        <Readout schedule={schedule} offset={player.offset} gates={player.voiceGates} />
      </div>

      {/* Folded away by default on a phone, where this would otherwise be several screens of
          controls nobody asked for yet. */}
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
          {/* Always a copy: editing an imported program in place would rewrite the file someone
              brought in. */}
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
          <NoisePanel
            noise={noise}
            onChange={onNoiseChange}
            lostAmbientBed={lostAmbientBed}
            ownBed={ownBed}
          />
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

function voiceName(description: string, index: number): string {
  return description.trim() || `Voice ${index + 1}`;
}

/** The bed's voices, quoted, so the panel's sentence names what it is talking about. */
function bedLabel(names: readonly string[]): string {
  const quoted = names.map((name) => `“${name}”`);
  if (quoted.length <= 1) return quoted[0] ?? '';
  return `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}
