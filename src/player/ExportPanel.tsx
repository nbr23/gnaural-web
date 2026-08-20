import { useMemo, useState } from 'react';
import { formatBytes } from '../app/format';
import type { Schedule } from '../document/types';
import type { NoiseLayerSettings } from '../engine/engine';
import { useExport } from './useExport';
import type { VoiceGate } from './usePlayer';

/** Half rate loses nothing audible — everything here is synthesised well below 1 kHz. */
const SAMPLE_RATES = [
  { value: 44100, label: '44.1 kHz' },
  { value: 22050, label: '22.05 kHz' },
];

export interface ExportPanelProps {
  schedule: Schedule;
  sampleRate: number;
  onSampleRateChange(rate: number): void;
  /** The app's noise layer as it is set right now — offered to the WAV when it is audible. */
  noise?: NoiseLayerSettings;
  gates: VoiceGate[];
}

/**
 * Getting a program out of the app: as a link, as `.gnaural`, or as audio.
 *
 * Link and `.gnaural` are instant; the WAV row follows because it's a render that can run to
 * hundreds of megabytes, hence the size estimate shown up front. Playback keeps running during a
 * render — it's a separate offline context.
 *
 * The noise bed checkbox defaults unticked: a WAV export can carry the app's ambient bed, but the
 * default export stays exactly the program as authored.
 *
 * The WAV follows the player's mute and solo, since it is audio and the point of muting a voice is
 * to decide what should be heard. A link and a `.gnaural` are the program rather than a recording of
 * it, so they carry every voice the document has, muted or not.
 */
export function ExportPanel({
  schedule,
  sampleRate,
  onSampleRateChange,
  noise,
  gates,
}: ExportPanelProps) {
  const [includeNoise, setIncludeNoise] = useState(false);
  const colour = noise?.colour;
  const gain = noise?.gain ?? 0;
  const noiseActive = gain > 0;

  // Rebuilt from the two values rather than passed through, so a re-render doesn't hand
  // `useExport` a fresh object on every frame.
  const bed = useMemo(
    () => (colour && gain > 0 && includeNoise ? { colour, gain } : undefined),
    [colour, gain, includeNoise],
  );

  const exporter = useExport(schedule, sampleRate, bed, gates);
  const busy = exporter.status !== 'idle';

  return (
    <section className="export">
      <h2>Export &amp; share</h2>

      <div className="export__row">
        <button type="button" className="button" onClick={exporter.share} disabled={busy}>
          Share link
        </button>

        <button type="button" className="button" onClick={exporter.exportGnaural} disabled={busy}>
          Export .gnaural
        </button>
      </div>

      <div className="export__row">
        <button
          type="button"
          className="button"
          onClick={exporter.exportWav}
          disabled={busy || exporter.nothingAudible}
        >
          Export WAV
        </button>

        <label className="export__rate">
          <span className="export__label">Quality</span>
          <select
            value={sampleRate}
            disabled={busy}
            onChange={(event) => onSampleRateChange(Number(event.target.value))}
          >
            {SAMPLE_RATES.map((rate) => (
              <option key={rate.value} value={rate.value}>
                {rate.label}
              </option>
            ))}
          </select>
        </label>

        <span className="export__estimate">≈ {formatBytes(exporter.estimatedBytes)}</span>
      </div>

      {exporter.nothingAudible && (
        <p className="export__notice">
          Nothing is audible right now, so the WAV would be silence. Unmute a voice to export one —
          the link and the .gnaural file still carry the whole program.
        </p>
      )}

      {/* A WAV covers one pass — repetition isn't part of the program's audio, and a schedule
          that repeats forever isn't a file anyone can write. */}
      {Math.floor(schedule.loops) !== 1 && (
        <p className="export__notice">
          The WAV covers one pass. This program{' '}
          {schedule.loops <= 0 ? 'repeats until stopped' : `repeats ${Math.floor(schedule.loops)} times`}{' '}
          when played.
        </p>
      )}

      {/* The bed is a listening preference, not part of the program, so it's offered here rather
          than carried silently — and unticked, since noise is added only when someone asks for it. */}
      {noiseActive && (
        <label className="export__include">
          <input
            type="checkbox"
            checked={includeNoise}
            disabled={busy}
            onChange={(event) => setIncludeNoise(event.target.checked)}
          />
          <span>
            Include background noise
            <small>
              {includeNoise
                ? ' — the WAV only, at the level and colour set under Sound; a loud bed over a loud program can clip.'
                : ' — the WAV will be the program as authored.'}
            </small>
          </span>
        </label>
      )}

      {busy && (
        <div className="export__row">
          <progress className="export__progress" value={exporter.progress} max={1} />
          <span className="export__status">
            {exporter.status === 'saving' ? 'Saving…' : `Rendering ${Math.round(exporter.progress * 100)}%`}
          </span>
          <button type="button" className="button" onClick={exporter.cancel}>
            Cancel
          </button>
        </div>
      )}

      {exporter.notice && <p className="export__notice">{exporter.notice}</p>}

      {exporter.error && (
        <p className="export__error" role="alert">
          {exporter.error}
        </p>
      )}
    </section>
  );
}
