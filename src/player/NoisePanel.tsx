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
  /**
   * The program's own noise bed, when it carries one. Naming it is the point: the layer below mixes
   * on top of it, and several bundled programs call their own voice "Background noise" too. Muting
   * is session state, exactly like the voice list's — it never edits the program.
   */
  ownBed?: {
    label: string;
    muted: boolean;
    onToggleMute(): void;
  };
}

/**
 * The app-level noise layer: a bed of noise under whatever is playing, off by default and
 * persisted across programs as a listening preference rather than a property of a schedule. Never
 * carried by a share link or `.gnaural` file; `ExportPanel` offers to mix it into a WAV.
 */
export function NoisePanel({ noise, onChange, lostAmbientBed, ownBed }: NoisePanelProps) {
  const on = noise.gain > 0;

  return (
    <section className="noise">
      <div className="noise__controls">
        <label className="noise__level">
          {/* Named for whose it is: a program that carries its own bed usually calls that voice
              "Background noise" as well, which is the whole confusion. */}
          <span>App background noise</span>
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

      {ownBed && (
        <div className="noise__own-bed">
          <p className="noise__note">
            This program has a bed of its own ({ownBed.label}), so the layer above plays on top of
            it.
          </p>
          <button type="button" className="button" onClick={ownBed.onToggleMute}>
            {ownBed.muted ? 'Unmute the program’s own' : 'Mute the program’s own'}
          </button>
        </div>
      )}

      {lostAmbientBed && (
        <p className="noise__note">
          This program originally had an ambient background, which was not carried over. This layer
          is the intended stand-in for it.
        </p>
      )}
    </section>
  );
}
