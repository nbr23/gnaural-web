import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatClock, formatHz } from '../app/format';
import { LIBRARY, navigate } from '../app/routing';
import type { Schedule } from '../document/types';
import type { NoiseLayerSettings } from '../engine/engine';
import { VolumeSlider, WakeLockToggle } from '../player/Controls';
import { NoisePanel } from '../player/NoisePanel';
import { Readout } from '../player/Readout';
import type { Player } from '../player/usePlayer';
import type { LiveValues } from './liveSchedule';
import { BASE_RANGE, BEAT_RANGE, buildLiveSchedule, clampValues, describeLive } from './liveSchedule';
import { SLIDER_STEP, bandTargets, beatBandTicks, positionToValue, valueToPosition } from './sliders';
import { useThrottled } from './useThrottled';
import './LiveView.css';

/** §1: "sessions run 15–60 minutes", and the length of `powernap`, which is the canonical one. */
const DEFAULT_KEEP_MINUTES = 20;
const KEEP_MINUTES_RANGE = { min: 1, max: 180 };

export interface LiveViewProps {
  player: Player;
  /** Where the sliders were last left. Seeded once the settings read lands, then owned here. */
  storedBaseFreq: number;
  storedBeatFreq: number;
  hydrated: boolean;
  onValuesChange(values: LiveValues): void;
  masterGain: number;
  onMasterGainChange(value: number): void;
  noise: NoiseLayerSettings;
  onNoiseChange(noise: NoiseLayerSettings): void;
  wakeLock: boolean;
  onWakeLockChange(enabled: boolean): void;
  /** Hands a finished document to the library by exactly the path an imported file takes. */
  onKeep(schedule: Schedule, sourceName: string): void;
}

/**
 * Live mode (PLAN.md §6.1): "no timeline at all, just sliders for base freq / beat freq / noise."
 *
 * **Its own view rather than a configured `PlayerView`.** §6.1 asks for no timeline, and
 * `ScheduleChart` is the component measured at 1220 ms of scripting per 5 s of playback before
 * `StaticPlot` existed — putting a document that changes ten times a second behind it is the most
 * direct way to rebuild the Android crackling. What is reused is what carries no such cost:
 * `Readout`, `NoisePanel`, `usePlayer` and the engine underneath them. Left behind with the chart:
 * the timeline (a 12-hour bar of nothing), the ±30 s seeks (meaningless on a constant hold), the
 * warning list and voice list (one synthesised voice, no warning reachable), and export — the
 * route to a WAV is to keep the session as a program first, which is also the honest one, since
 * what gets exported is then a document someone chose the length of.
 *
 * The sliders' state lives here rather than in `App`'s settings, and reaches both the engine and
 * the settings store on one throttled tick. Binding a slider straight to app-wide state would
 * re-render the whole tree on every pixel of a drag, which is the defect `CLOCK_INTERVAL_MS` and
 * `StaticPlot` exist to prevent, in a new place.
 */
export function LiveView({
  player,
  storedBaseFreq,
  storedBeatFreq,
  hydrated,
  onValuesChange,
  masterGain,
  onMasterGainChange,
  noise,
  onNoiseChange,
  wakeLock,
  onWakeLockChange,
  onKeep,
}: LiveViewProps) {
  const [values, setValues] = useState<LiveValues>(() =>
    clampValues({ baseFreq: storedBaseFreq, beatFreq: storedBeatFreq }),
  );

  /** Whether anyone has actually moved a slider, which is what makes a value worth persisting. */
  const touched = useRef(false);
  const seeded = useRef(false);

  const schedule = useMemo(() => buildLiveSchedule(values), [values]);

  // Not memoised: `useThrottled` always calls the most recent action it was given, which is what
  // keeps a pending edit from reaching a player this render has already replaced.
  const push = useThrottled((next: { values: LiveValues; schedule: Schedule }) => {
    player.update(next.schedule);
    // Writing on mount would mark the key touched in `useSettings` and make the default win over
    // the stored value the read is about to deliver.
    if (touched.current) onValuesChange(next.values);
  });

  // One path for the seed, the mount and every change: whatever the sliders say, the engine is
  // told. Before the first play there is no context, and `update()` stores the document and
  // returns — so a slider moved before pressing Play is still what plays.
  useEffect(() => {
    push({ values, schedule });
  }, [push, schedule, values]);

  // The stored values arrive after the first render (`useSettings` hydrates asynchronously). Seed
  // once, and never over the top of someone who has already moved something.
  useEffect(() => {
    if (seeded.current || !hydrated) return;
    seeded.current = true;
    if (touched.current) return;
    setValues(clampValues({ baseFreq: storedBaseFreq, beatFreq: storedBeatFreq }));
  }, [hydrated, storedBaseFreq, storedBeatFreq]);

  const change = useCallback((next: LiveValues) => {
    touched.current = true;
    setValues(clampValues(next));
  }, []);

  return (
    <div className="live">
      <header className="live__header">
        <button type="button" className="back-link" onClick={() => navigate(LIBRARY)}>
          ← Library
        </button>
        <h1 className="live__title">Live</h1>
        <p className="live__lede">
          Sliders instead of a timeline. Move them while it plays — nothing is being recorded, and
          nothing here is saved unless you keep it below.
        </p>
      </header>

      {/* A constant hold has the same value at every offset, so there is nothing for the playhead
          to say here — and passing 0 keeps this off the 10 Hz clock. */}
      <Readout schedule={schedule} offset={0} />

      <div className="live__transport">
        {/* Play/Pause and Stop only: ±30 s on a constant hold moves the clock and changes nothing
            anyone can hear. */}
        <button
          type="button"
          className="button button--primary"
          onClick={() => (player.playing ? player.pause() : player.play())}
        >
          {player.playing ? 'Pause' : 'Play'}
        </button>
        <button type="button" className="button" onClick={player.stop}>
          Stop
        </button>
        <span className="live__elapsed">{formatClock(player.offset)}</span>
      </div>

      <label className="live__slider">
        <span className="live__slider-label">
          Base frequency <strong>{formatHz(values.baseFreq)} Hz</strong>
        </span>
        <input
          type="range"
          min={0}
          max={1}
          step={SLIDER_STEP}
          value={valueToPosition(BASE_RANGE, values.baseFreq)}
          aria-valuetext={`${formatHz(values.baseFreq)} hertz`}
          onChange={(event) =>
            change({ ...values, baseFreq: positionToValue(BASE_RANGE, Number(event.target.value)) })
          }
        />
      </label>

      <div className="live__beat">
        <label className="live__slider">
          <span className="live__slider-label">
            Beat frequency <strong>{formatHz(values.beatFreq)} Hz</strong>
          </span>
          <input
            type="range"
            min={0}
            max={1}
            step={SLIDER_STEP}
            list="live-beat-bands"
            value={valueToPosition(BEAT_RANGE, values.beatFreq)}
            aria-valuetext={`${formatHz(values.beatFreq)} hertz`}
            onChange={(event) =>
              change({
                ...values,
                beatFreq: positionToValue(BEAT_RANGE, Number(event.target.value)),
              })
            }
          />
        </label>

        {/* Tick marks at the band boundaries, so where they fall is visible without the slider
            snapping to them. */}
        <datalist id="live-beat-bands">
          {beatBandTicks().map((hz) => (
            <option key={hz} value={valueToPosition(BEAT_RANGE, hz)} />
          ))}
        </datalist>

        <div className="live__bands">
          {bandTargets().map(({ band, beatFreq }) => (
            <button
              key={band.name}
              type="button"
              className="live__band"
              aria-pressed={values.beatFreq >= band.min && values.beatFreq < band.max}
              onClick={() => change({ ...values, beatFreq })}
            >
              {band.name}
            </button>
          ))}
        </div>
      </div>

      <VolumeSlider value={masterGain} onChange={onMasterGainChange} />

      <NoisePanel noise={noise} onChange={onNoiseChange} />

      <WakeLockToggle enabled={wakeLock} onChange={onWakeLockChange} />

      <KeepPanel values={values} onKeep={onKeep} />

      <p className="live__note">Headphones required — the beat only exists between two ears.</p>
    </div>
  );
}

interface KeepPanelProps {
  values: LiveValues;
  onKeep(schedule: Schedule, sourceName: string): void;
}

/**
 * Turn what is playing into a program in the library.
 *
 * **The duration asked for here is not the live session's.** A live session runs until it is
 * stopped; a program is a file with a length, and that length is a choice nobody has made yet.
 * Conflating the two would put a 12-hour program in the library.
 *
 * What it saves is the sliders as they stand — a constant hold, per §3.5 — and not the sweep that
 * led to them. Recording a session as a curve is a real feature and it is not this one: it needs
 * the command stack and structural edits.
 */
function KeepPanel({ values, onKeep }: KeepPanelProps) {
  const [minutes, setMinutes] = useState(String(DEFAULT_KEEP_MINUTES));
  const [title, setTitle] = useState('');

  const length = Number(minutes);
  const valid = Number.isFinite(length) && length >= KEEP_MINUTES_RANGE.min && length <= KEEP_MINUTES_RANGE.max;

  const keep = () => {
    if (!valid) return;
    onKeep(
      buildLiveSchedule(values, {
        title: title.trim() || `Live — ${describeLive(values)}`,
        durationSeconds: Math.round(length * 60),
      }),
      'Live session',
    );
  };

  return (
    <section className="live__keep">
      <h2>Keep this as a program</h2>
      <p className="live__keep-note">
        Saves the current settings as a constant {formatHz(values.beatFreq)} Hz beat, in your
        library alongside anything you have opened — with a share link and a WAV export like any
        other program. The background noise layer is the app&rsquo;s, not the program&rsquo;s, so it
        is not part of it.
      </p>

      <div className="live__keep-row">
        <label className="live__field">
          <span>Length</span>
          <input
            type="number"
            inputMode="numeric"
            min={KEEP_MINUTES_RANGE.min}
            max={KEEP_MINUTES_RANGE.max}
            step={1}
            value={minutes}
            onChange={(event) => setMinutes(event.target.value)}
          />
          <span className="live__field-unit">min</span>
        </label>

        <label className="live__field live__field--grow">
          <span>Title</span>
          <input
            type="text"
            value={title}
            placeholder={`Live — ${describeLive(values)}`}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>

        <button type="button" className="button" disabled={!valid} onClick={keep}>
          Keep
        </button>
      </div>
    </section>
  );
}
