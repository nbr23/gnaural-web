import { useMemo, useState } from 'react';
import { formatBytes } from '../app/format';
import type { Schedule } from '../document/types';
import type { NoiseLayerSettings } from '../engine/engine';
import { useExport } from './useExport';

/** 44.1 kHz for fidelity, half that for programs whose full-rate render is too large to hold —
 *  everything here is synthesised well below 1 kHz, so the lower rate loses nothing audible. */
const SAMPLE_RATES = [
  { value: 44100, label: '44.1 kHz' },
  { value: 22050, label: '22.05 kHz' },
];

export interface ExportPanelProps {
  schedule: Schedule;
  sampleRate: number;
  onSampleRateChange(rate: number): void;
  /** The app's noise layer as it is set right now (§4.5b) — offered to the WAV when it is audible. */
  noise?: NoiseLayerSettings;
}

/**
 * Getting a program out of the app (PLAN.md §5.1's "Export & share"): as a link, as `.gnaural`,
 * or as audio.
 *
 * Link and `.gnaural` lead, and the WAV row follows with its own controls, because the first two
 * are instant and the third is a render measured in hundreds of megabytes.
 *
 * The estimated size is shown before the render starts, because it is large enough to matter: a
 * 20-minute program is a couple of hundred megabytes at 44.1 kHz, and an hours-long one may not
 * fit in memory at all. Playback is left running throughout — the render is a separate offline
 * context, and silently pausing someone's program would be a surprise.
 *
 * The app's noise bed (§4.5b) is the one thing an export can carry that the document does not
 * contain, and the decision is made here rather than anywhere else: a checkbox, shown only when
 * there is a bed to include, and **unticked** — the default export stays the program as authored,
 * so a WAV never picks up a listening preference nobody asked it to carry. It applies to the WAV
 * alone: a link and a `.gnaural` file describe the program, and the bed is not part of it.
 */
export function ExportPanel({ schedule, sampleRate, onSampleRateChange, noise }: ExportPanelProps) {
  const [includeNoise, setIncludeNoise] = useState(false);
  const colour = noise?.colour;
  const gain = noise?.gain ?? 0;
  const noiseActive = gain > 0;

  // Rebuilt from the two values rather than passed through, so an unrelated re-render of the
  // player doesn't hand `useExport` a fresh object on every frame.
  const bed = useMemo(
    () => (colour && gain > 0 && includeNoise ? { colour, gain } : undefined),
    [colour, gain, includeNoise],
  );

  const exporter = useExport(schedule, sampleRate, bed);
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
        <button type="button" className="button" onClick={exporter.exportWav} disabled={busy}>
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

      {/* Repetition is a playback behaviour, not part of the program's audio — and a WAV of a
          schedule that repeats forever is not a file anyone can write. Say so rather than let the
          length come as a surprise. */}
      {Math.floor(schedule.loops) !== 1 && (
        <p className="export__notice">
          The WAV covers one pass. This program{' '}
          {schedule.loops <= 0 ? 'repeats until stopped' : `repeats ${Math.floor(schedule.loops)} times`}{' '}
          when played.
        </p>
      )}

      {/* Offered here rather than decided elsewhere, because this is the one place the choice is
          visible: the bed is this listener's preference rather than part of the program, so an
          export that silently carried it would surprise someone. Unticked, for the same reason the
          layer itself is silent by default (§3.8 item 6) — noise is added because a person asked
          for it, never because a setting was left somewhere. */}
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
