import { useMemo } from 'react';
import { formatHzFixed } from '../app/format';
import type { Schedule } from '../document/types';
import { isTonalType } from '../document/types';
import type { AutomationEvent } from '../engine/compiler';
import { compileVoice, eventBaseFreq, eventBeatFreq, valueAtTime } from '../engine/compiler';
import { bandFor } from '../viz/bands';
import { bandColor, seriesColor } from '../viz/palette';
import type { VoiceGate } from './usePlayer';
import './Readout.css';

export interface ReadoutProps {
  schedule: Schedule;
  offset: number;
  /**
   * Session mute/solo, so a voice the listener has silenced stops being reported as something they
   * are hearing. Omit where there is no engine to ask — the document's own `voice.muted` is then
   * the whole answer.
   */
  gates?: VoiceGate[];
}

/**
 * What the listener is hearing right now: beat frequency, base frequency, and the EEG band the
 * beat falls in (PLAN.md §5.1).
 *
 * **A band belongs to a voice, not to a program.** Two tonal voices ramping through different
 * frequencies are in two different bands, and one set of figures cannot answer "which band am I
 * in" for both — so every audible tonal voice gets its own line, keyed with the colour the chart
 * and the voice list already draw it in. One voice keeps the large tiles: there is nothing to
 * disambiguate, and those figures are the ones worth reading across a room.
 *
 * "Audible" is the engine's gate rather than `voice.hidden`, which only says whether the chart
 * draws the voice. Reporting a band for a muted voice states the listener is hearing something
 * they silenced.
 *
 * A beat off the ends of the table — under Delta, over Gamma — names no band, and that voice
 * simply goes without one: the frequencies are still true, and there is no band to report.
 *
 * "Tonal" rather than "binaural" because an isochronic voice reads both fields just as literally:
 * its base is the tone and its beat is the rate that tone is pulsed at, which is exactly what these
 * two figures and the band name are for.
 */
export function Readout({ schedule, offset, gates }: ReadoutProps) {
  const voices = useMemo(() => audibleVoices(schedule, gates), [schedule, gates]);
  const readings = voices.map((voice) => read(voice, offset));

  if (readings.length === 0) return null;

  if (readings.length === 1) {
    const [only] = readings;
    return (
      <div className="readout">
        <Tile label="Beat" value={`${formatHzFixed(only.beat)} Hz`} />
        <Tile label="Base" value={`${formatHzFixed(only.base)} Hz`} />
        {only.band && (
          <Tile label="Band" value={only.band.name} accent={bandColor(only.band.name)} />
        )}
      </div>
    );
  }

  return (
    <ul className="readout readout--voices">
      {readings.map((reading) => (
        <li className="readout__voice" key={reading.index}>
          <span className="readout__key" style={{ color: seriesColor(reading.index) }} />
          <span className="readout__name">{reading.label}</span>
          {/* The empty slot keeps the figures of a bandless voice in the same columns as every
              other line's, which is the whole reason they are columns. */}
          {reading.band ? (
            <span className="readout__band">
              <span
                className="readout__dot"
                style={{ background: bandColor(reading.band.name) }}
                aria-hidden="true"
              />
              {reading.band.name}
            </span>
          ) : (
            <span className="readout__band readout__band--none" aria-hidden="true" />
          )}
          <span className="readout__figure">
            {formatHzFixed(reading.beat)} Hz <span className="readout__unit">beat</span>
          </span>
          <span className="readout__figure">
            {formatHzFixed(reading.base)} Hz <span className="readout__unit">base</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function Tile({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="readout__tile">
      <span className="readout__label">{label}</span>
      <span className="readout__value">
        {accent && (
          <span className="readout__dot" style={{ background: accent }} aria-hidden="true" />
        )}
        {value}
      </span>
    </div>
  );
}

interface AudibleVoice {
  /** Index into `schedule.voices` — the key both the gates and the palette are addressed by. */
  index: number;
  label: string;
  events: AutomationEvent[];
}

function audibleVoices(schedule: Schedule, gates?: VoiceGate[]): AudibleVoice[] {
  return schedule.voices.flatMap((voice, index) => {
    if (!isTonalType(voice.type)) return [];
    if (gates?.[index]?.muted ?? voice.muted) return [];

    const events = compileVoice(voice);
    if (events.length === 0) return [];

    return [{ index, label: voice.description.trim() || `Voice ${voice.id}`, events }];
  });
}

function read(voice: AudibleVoice, offset: number) {
  const values = valueAtTime(voice.events, offset);
  const beat = eventBeatFreq(values);

  return { ...voice, beat, base: eventBaseFreq(values), band: bandFor(beat) };
}

