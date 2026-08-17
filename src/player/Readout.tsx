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
  /** Session mute/solo. Omit where there is no engine to ask — `voice.muted` is then the whole
   *  answer. */
  gates?: VoiceGate[];
}

/**
 * What the listener is hearing right now: beat frequency, base frequency, and the EEG band the
 * beat falls in.
 *
 * A band belongs to a voice, not to a program — two tonal voices ramping through different
 * frequencies are in different bands, so every audible tonal voice gets its own line, keyed with
 * the same colour the chart draws it in. "Audible" is the engine's mute/solo gate rather than
 * `voice.hidden`, which only affects the chart. A beat off the ends of the table (under Delta,
 * over Gamma) names no band, so that voice goes without one.
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
          {/* The empty slot keeps a bandless voice's figures in the same columns as every other
              line's. */}
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
  /** Index into `schedule.voices` — the key both the gates and the palette use. */
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

