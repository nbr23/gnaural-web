import { useMemo } from 'react';
import { formatHz } from '../app/format';
import type { Schedule, Voice } from '../document/types';
import { isTonalType } from '../document/types';
import { compileVoice, eventBaseFreq, eventBeatFreq, valueAtTime } from '../engine/compiler';
import { bandFor } from '../viz/bands';
import './Readout.css';

export interface ReadoutProps {
  schedule: Schedule;
  offset: number;
}

/**
 * What the listener is hearing right now: beat frequency, base frequency, and the EEG band the
 * beat falls in (PLAN.md §5.1).
 *
 * A schedule can hold several voices, so this reports the *primary* one — the first audible voice
 * whose two frequencies describe a tone — and names it when there is more than one. Per-voice
 * values are already available from the chart's crosshair, so repeating all of them here would be
 * noise.
 *
 * "Tonal" rather than "binaural" because an isochronic voice reads both fields just as literally:
 * its base is the tone and its beat is the rate that tone is pulsed at, which is exactly what these
 * two tiles and the band name are for.
 */
export function Readout({ schedule, offset }: ReadoutProps) {
  const primary = useMemo(() => primaryVoice(schedule), [schedule]);
  const events = useMemo(() => (primary ? compileVoice(primary.voice) : []), [primary]);

  if (!primary || events.length === 0) return null;

  const values = valueAtTime(events, offset);
  const beat = eventBeatFreq(values);
  const band = bandFor(beat);

  return (
    <div className="readout">
      <Tile label="Beat" value={`${formatHz(beat)} Hz`} />
      <Tile label="Base" value={`${formatHz(eventBaseFreq(values))} Hz`} />
      <Tile label="Band" value={band?.name ?? '—'} />
      {primary.multiple && <p className="readout__source">for {primary.label}</p>}
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="readout__tile">
      <span className="readout__label">{label}</span>
      <span className="readout__value">{value}</span>
    </div>
  );
}

interface PrimaryVoice {
  voice: Voice;
  label: string;
  multiple: boolean;
}

function primaryVoice(schedule: Schedule): PrimaryVoice | null {
  const candidates = schedule.voices.filter(
    (voice) => isTonalType(voice.type) && !voice.hidden && voice.entries.length > 0,
  );
  const voice = candidates[0];
  if (!voice) return null;

  return {
    voice,
    label: voice.description.trim() || `Voice ${voice.id}`,
    multiple: candidates.length > 1,
  };
}
