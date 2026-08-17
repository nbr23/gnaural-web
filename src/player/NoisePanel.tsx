import type { NoiseLayerSettings } from '../engine/engine';
import type { NoiseColour } from '../engine/noise';
import { NOISE_COLOURS } from '../engine/noise';
import './NoisePanel.css';

/** `gnaural` first: it's the same generator a schedule's own noise voice uses, so a bed under a
 *  program that has one matches it. */
const COLOUR_LABELS: Record<NoiseColour, string> = {
  gnaural: 'Gnaural (lowpass)',
  white: 'White',
  pink: 'Pink',
  brown: 'Brown',
};

export interface NoisePanelProps {
  noise: NoiseLayerSettings;
  onChange(noise: NoiseLayerSettings): void;
  /** Set for the four presets whose ambient bed did not survive conversion — points at this
   *  control as the remedy rather than enabling anything on the listener's behalf. */
  lostAmbientBed?: boolean;
}

/**
 * The app-level noise layer: a bed of noise under whatever is playing, off by default and
 * persisted across programs as a listening preference rather than a property of a schedule. Never
 * carried by a share link or `.gnaural` file; `ExportPanel` offers to mix it into a WAV.
 */
export function NoisePanel({ noise, onChange, lostAmbientBed }: NoisePanelProps) {
  const on = noise.gain > 0;

  return (
    <section className="noise">
      <div className="noise__controls">
        <label className="noise__level">
          <span>Background noise</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={noise.gain}
            onChange={(event) => onChange({ ...noise, gain: Number(event.target.value) })}
          />
        </label>

        <label className="noise__colour">
          <span className="noise__label">Colour</span>
          <select
            value={noise.colour}
            onChange={(event) => onChange({ ...noise, colour: event.target.value as NoiseColour })}
          >
            {NOISE_COLOURS.map((colour) => (
              <option key={colour} value={colour}>
                {COLOUR_LABELS[colour]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="noise__note">
        {on ? 'Mixed under the program' : 'Off'} — the app&rsquo;s own layer, not part of the
        program, so the share link and the .gnaural file never carry it. A WAV export can, if you
        ask it to.
      </p>

      {lostAmbientBed && (
        <p className="noise__note">
          This program originally had an ambient background, which was not carried over. This layer
          is the intended stand-in for it.
        </p>
      )}
    </section>
  );
}
