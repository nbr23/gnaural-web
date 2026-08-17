import { useState } from 'react';
import { formatClock, formatHz, numberOr } from '../app/format';
import type { VoiceEdit, VoiceKind } from '../document/edit';
import {
  NEW_VOICE_SECONDS,
  duplicateVoice,
  insertVoice,
  offsetVoice,
  reverseVoice,
  setScheduleLength,
} from '../document/edit';
import type { GeneratorKind, GeneratorSpec, Tone } from '../document/generators';
import { generateEntries } from '../document/generators';
import { scheduleDuration, voiceDuration } from '../document/timing';
import type { Schedule } from '../document/types';
import { EEG_BANDS, bandCentre } from '../viz/bands';
import type { NodeRef, Selection } from './history';

export interface AuthoringPanelProps {
  schedule: Schedule;
  selected: Selection;
  onCommit(schedule: Schedule, label: string): void;
  onCommitAt(schedule: Schedule, label: string, selection: Selection): void;
  onStructural(edit: VoiceEdit, label: string, selection?: NodeRef | null): void;
}

const GENERATOR_LABELS: Record<GeneratorKind, string> = {
  hold: 'Hold — one steady tone',
  ramp: 'Ramp — glide from one tone to another',
  'sleep-cycle': 'Sleep cycle — repeated descents into delta',
  'wake-up': 'Wake-up ramp — delta up into beta',
};

const GENERATOR_NAMES: Record<GeneratorKind, string> = {
  hold: 'Hold',
  ramp: 'Ramp',
  'sleep-cycle': 'Sleep cycle',
  'wake-up': 'Wake-up ramp',
};

export function AuthoringPanel({
  schedule,
  selected,
  onCommit,
  onCommitAt,
  onStructural,
}: AuthoringPanelProps) {
  const playing = scheduleDuration(schedule);
  const selectedVoice = selected[0]?.voice ?? 0;
  const [target, setTarget] = useState<number | null>(null);
  const voice = Math.min(target ?? selectedVoice, Math.max(0, schedule.voices.length - 1));

  const [length, setLength] = useState('');
  const [offset, setOffset] = useState('60');
  const [kind, setKind] = useState<GeneratorKind>('ramp');
  const [voiceKind, setVoiceKind] = useState<VoiceKind>('tone');
  const [seconds, setSeconds] = useState('');
  const [returnLeg, setReturnLeg] = useState('60');
  const [from, setFrom] = useState<Tone>({ baseFreq: 200, beatFreq: 10 });
  const [to, setTo] = useState<Tone>({ baseFreq: 200, beatFreq: 4 });

  const has = schedule.voices.length > 0;
  // A schedule with no voices plays for zero seconds, so fall back to NEW_VOICE_SECONDS or the
  // first generate on an empty draft would build a zero-length shape and do nothing.
  const fallback = playing || NEW_VOICE_SECONDS;
  const duration = numberOr(seconds, fallback) || fallback;

  const generate = () => {
    const entries = generateEntries(specOf(kind, { from, to, seconds: duration, returnLeg }));
    if (entries.length === 0) return;

    const edit = insertVoice(schedule, {
      kind: voiceKind,
      entries,
      description: GENERATOR_NAMES[kind],
    });
    onStructural(edit, 'Generate voice', { voice: edit.schedule.voices.length - 1, entry: 0 });
  };

  const shift = (seconds: number) => {
    const next = offsetVoice(schedule, { voice, seconds });
    if (next === schedule) return;
    // The rotation renumbers every node in that voice and can add one, so a selection inside it no
    // longer means what it meant; selections in other voices are untouched.
    onCommitAt(
      next,
      'Offset voice',
      selected.filter((node) => node.voice !== voice),
    );
  };

  return (
    <section className="editor__fields authoring">

      <h3 className="editor__subhead">Program length</h3>
      <p className="editor__hint">
        Now {formatClock(playing)}. Scaling stretches or compresses every voice by the same amount,
        so the program keeps its shape and the voices stay in step.
      </p>
      <div className="editor__row">
        <label className="editor__field">
          <span>Target length (s)</span>
          <input
            type="number"
            inputMode="decimal"
            min="0"
            placeholder={String(Math.round(playing))}
            value={length}
            onChange={(event) => setLength(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="button"
          disabled={!has}
          onClick={() => {
            const next = setScheduleLength(schedule, numberOr(length, playing));
            if (next !== schedule) onCommit(next, 'Scale program');
          }}
        >
          Scale program
        </button>
      </div>

      <h3 className="editor__subhead">Voice tools</h3>
      {has ? (
        <>
          <div className="editor__row">
            <label className="editor__field">
              <span>Voice</span>
              <select value={voice} onChange={(event) => setTarget(Number(event.target.value))}>
                {schedule.voices.map((current, index) => (
                  <option key={index} value={index}>
                    {index + 1}. {current.description.trim() || `Voice ${index + 1}`} (
                    {formatClock(voiceDuration(current))})
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="button"
              onClick={() =>
                onStructural(duplicateVoice(schedule, voice), 'Duplicate voice', {
                  voice: voice + 1,
                  entry: 0,
                })
              }
            >
              Duplicate
            </button>
            <button
              type="button"
              className="button"
              onClick={() => {
                const next = reverseVoice(schedule, voice);
                if (next === schedule) return;
                // The mirror of every node in that voice; entry 0 stays where it is.
                const nodes = schedule.voices[voice].entries.length;
                onCommitAt(
                  next,
                  'Reverse voice',
                  selected.map((node) =>
                    node.voice === voice && node.entry > 0
                      ? { voice, entry: nodes - node.entry }
                      : node,
                  ),
                );
              }}
            >
              Reverse
            </button>
          </div>

          <div className="editor__row">
            <label className="editor__field">
              <span>Offset by (s)</span>
              <input
                type="number"
                inputMode="decimal"
                value={offset}
                onChange={(event) => setOffset(event.target.value)}
              />
            </label>
            <button
              type="button"
              className="button"
              onClick={() => shift(-numberOr(offset, 0))}
            >
              Rotate earlier
            </button>
            <button type="button" className="button" onClick={() => shift(numberOr(offset, 0))}>
              Rotate later
            </button>
          </div>

          <p className="editor__hint">
            A voice has no start time of its own, so offsetting rotates it: the end wraps round to
            the beginning and the voice keeps its length.
          </p>
        </>
      ) : (
        <p className="editor__hint">Add a voice first, or generate one below.</p>
      )}

      <h3 className="editor__subhead">Generate a voice</h3>
      <p className="editor__hint">
        Generating never overwrites anything — it adds a voice. The last segment always glides back
        to the first node (§3.5), so each shape spends part of its length getting home.
      </p>

      <div className="editor__row">
        <label className="editor__field">
          <span>Shape</span>
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value as GeneratorKind)}
          >
            {Object.entries(GENERATOR_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="editor__field">
          <span>As</span>
          <select value={voiceKind} onChange={(event) => setVoiceKind(event.target.value as VoiceKind)}>
            <option value="tone">Binaural voice</option>
            <option value="isochronic">Isochronic voice</option>
          </select>
        </label>
        <label className="editor__field">
          <span>Over (s)</span>
          <input
            type="number"
            inputMode="decimal"
            min="0"
            placeholder={String(Math.round(fallback))}
            value={seconds}
            onChange={(event) => setSeconds(event.target.value)}
          />
        </label>
        {kind !== 'sleep-cycle' && (
          <label className="editor__field">
            <span>Return over (s)</span>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              value={returnLeg}
              onChange={(event) => setReturnLeg(event.target.value)}
            />
          </label>
        )}
      </div>

      {kind === 'hold' || kind === 'ramp' ? (
        <>
          <ToneFields
            legend={kind === 'ramp' ? 'From' : 'Tone'}
            tone={from}
            onChange={setFrom}
          />
          {kind === 'ramp' && <ToneFields legend="To" tone={to} onChange={setTo} />}
        </>
      ) : (
        <div className="editor__row">
          <label className="editor__field">
            <span>Base (Hz)</span>
            <input
              type="number"
              inputMode="decimal"
              value={from.baseFreq}
              onChange={(event) =>
                setFrom({ ...from, baseFreq: numberOr(event.target.value, from.baseFreq) })
              }
            />
          </label>
        </div>
      )}

      <div className="editor__row">
        <button type="button" className="button button--primary" onClick={generate}>
          Generate
        </button>
      </div>
    </section>
  );
}

// The band chips use each band's own geometric centre, not Live mode's slider-bounded one — hence
// Gamma reading 54.8 Hz and tripping the validation panel's "not heard as one" warning.
function ToneFields({
  legend,
  tone,
  onChange,
}: {
  legend: string;
  tone: Tone;
  onChange(tone: Tone): void;
}) {
  return (
    <div className="authoring__tone">
      <div className="editor__row">
        <label className="editor__field">
          <span>{legend} base (Hz)</span>
          <input
            type="number"
            inputMode="decimal"
            value={tone.baseFreq}
            onChange={(event) =>
              onChange({ ...tone, baseFreq: numberOr(event.target.value, tone.baseFreq) })
            }
          />
        </label>
        <label className="editor__field">
          <span>{legend} beat (Hz)</span>
          <input
            type="number"
            inputMode="decimal"
            value={tone.beatFreq}
            onChange={(event) =>
              onChange({ ...tone, beatFreq: numberOr(event.target.value, tone.beatFreq) })
            }
          />
        </label>
      </div>
      <div className="authoring__bands">
        {EEG_BANDS.map((band) => (
          <button
            key={band.name}
            type="button"
            className="authoring__band"
            onClick={() => onChange({ ...tone, beatFreq: bandCentre(band) })}
          >
            {band.name} <span aria-hidden="true">{formatHz(bandCentre(band))} Hz</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function specOf(
  kind: GeneratorKind,
  fields: { from: Tone; to: Tone; seconds: number; returnLeg: string },
): GeneratorSpec {
  const seconds = fields.seconds;
  const returnSeconds = numberOr(fields.returnLeg, 60);

  switch (kind) {
    case 'hold':
      return { kind, tone: fields.from, seconds };
    case 'ramp':
      return { kind, from: fields.from, to: fields.to, seconds, returnSeconds };
    case 'sleep-cycle':
      return { kind, baseFreq: fields.from.baseFreq, seconds };
    case 'wake-up':
      return { kind, baseFreq: fields.from.baseFreq, seconds, returnSeconds };
  }
}
