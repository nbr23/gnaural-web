import type { NoiseLayerSettings } from '../engine/engine';
import type { NoiseColour } from '../engine/noise';
import { NOISE_COLOURS } from '../engine/noise';
import './NoisePanel.css';

/**
 * `gnaural` first because it is the sound this app already makes: a schedule's own noise voice
 * (§4.5a) is exactly this generator, so a bed under a program that has one matches it.
 */
const COLOUR_LABELS: Record<NoiseColour, string> = {
  gnaural: 'Gnaural (lowpass)',
  white: 'White',
  pink: 'Pink',
  brown: 'Brown',
};

export interface NoisePanelProps {
  noise: NoiseLayerSettings;
  onChange(noise: NoiseLayerSettings): void;
  /**
   * Set for the four presets whose ambient bed did not survive conversion
   * (`fixtures/presets/README.md`), which names this feature as their remedy. It is a pointer to a
   * control that is already here, not a per-program setting: nothing is enabled on the listener's
   * behalf, and what they choose stays chosen for every program (§3.8 item 6).
   */
  lostAmbientBed?: boolean;
}

/**
 * The app-level noise layer (PLAN.md §4.5b): a bed of noise under whatever is playing, with no
 * sampled audio and nothing added to the document (§4.6).
 *
 * Off unless someone turns it on, and it stays where they put it across programs — it is a
 * preference about listening, not a property of a schedule. Which is also why it is **not in the
 * WAV**: an export is the document as authored, and the same program must produce the same file
 * whoever renders it.
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
          {/* Not disabled while the level is at zero: choosing a colour before turning it up is a
              reasonable order to do this in, and a colour change with no layer built costs
              nothing. */}
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
        program, so it is left out of the WAV and the share link.
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
