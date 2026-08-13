import { describe, expect, it } from 'vitest';
import type { VoiceEdit } from '../document/edit';
import { scheduleDuration, voiceDuration } from '../document/timing';
import type { Entry, Schedule, Voice } from '../document/types';
import { VoiceType } from '../document/types';
import type { VoiceGate } from '../player/usePlayer';
import { setInputValue, setupRoot } from '../test-utils';
import { VoiceRows } from './VoiceRows';
import type { NodeRef } from './history';

function makeEntry(partial: Partial<Entry> = {}): Entry {
  return {
    duration: 300,
    baseFreq: 200,
    beatFreq: 8,
    volumeLeft: 0.5,
    volumeRight: 0.5,
    preserved: {},
    ...partial,
  };
}

function makeVoice(overrides: Partial<Voice> = {}): Voice {
  return {
    id: 0,
    description: 'Voice 1',
    type: VoiceType.Binaural,
    muted: false,
    hidden: false,
    mono: false,
    entries: [makeEntry(), makeEntry()],
    preserved: {},
    ...overrides,
  };
}

function twoVoices(): Schedule {
  return {
    title: 'Draft',
    description: '',
    author: '',
    loops: 1,
    masterVolume: { left: 1, right: 1 },
    stereoSwap: false,
    voices: [makeVoice(), makeVoice({ id: 1, description: 'Second' })],
    preserved: {},
  };
}

const testRoot = setupRoot();

interface Harness {
  commits: { schedule: Schedule; label: string }[];
  structural: { edit: VoiceEdit; label: string; selection?: NodeRef | null }[];
  solos: number[];
}

function mount(schedule: Schedule, gates: VoiceGate[] = []) {
  const harness: Harness = { commits: [], structural: [], solos: [] };

  testRoot.render(
    <VoiceRows
      schedule={schedule}
      gates={gates}
      onCommit={(next, label) => harness.commits.push({ schedule: next, label })}
      onStructural={(edit, label, selection) =>
        harness.structural.push({ edit, label, selection })
      }
      onToggleSolo={(index) => harness.solos.push(index)}
    />,
  );

  return harness;
}

function rows() {
  return testRoot.queryAll('.voice-rows__row');
}

function control(rowIndex: number, label: string): HTMLButtonElement {
  const found = [...rows()[rowIndex].querySelectorAll('button')].find(
    (button) => button.textContent === label,
  );
  if (!found) throw new Error(`no ${label} control on row ${rowIndex}`);
  return found as HTMLButtonElement;
}

describe('VoiceRows', () => {
  it('lists every voice with its type, node count and its own length', () => {
    mount({
      ...twoVoices(),
      voices: [makeVoice(), makeVoice({ id: 1, type: VoiceType.PinkNoise })],
    });

    expect(rows()).toHaveLength(2);
    expect(rows()[1].textContent).toContain('noise');
    expect(rows()[0].textContent).toContain('2 nodes');
    expect(rows()[0].textContent).toContain('10:00');
  });

  /**
   * The rule the caption states, asserted: everything here is the document except Solo, which the
   * format has no field for.
   */
  it('writes mute and hide into the document and routes solo to the session', () => {
    const schedule = twoVoices();
    const harness = mount(schedule, [
      { muted: false, soloed: false, audible: true },
      { muted: false, soloed: false, audible: true },
    ]);

    testRoot.click(control(0, 'Mute'));
    expect(harness.commits[0].label).toBe('Mute voice');
    expect(harness.commits[0].schedule.voices[0].muted).toBe(true);

    testRoot.click(control(1, 'Hide'));
    expect(harness.commits[1].label).toBe('Hide voice');
    expect(harness.commits[1].schedule.voices[1].hidden).toBe(true);

    testRoot.click(control(0, 'Solo'));
    expect(harness.solos).toEqual([0]);
    // A session control must never reach the document.
    expect(harness.commits).toHaveLength(2);
  });

  it('reflects the session solo state it is given', () => {
    mount(twoVoices(), [
      { muted: false, soloed: false, audible: false },
      { muted: false, soloed: true, audible: true },
    ]);

    expect(control(0, 'Solo').getAttribute('aria-pressed')).toBe('false');
    expect(control(1, 'Solo').getAttribute('aria-pressed')).toBe('true');
  });

  it('renames on blur, like every other committed field', () => {
    const harness = mount(twoVoices());
    const input = rows()[1].querySelector('input') as HTMLInputElement;

    setInputValue(input, 'Carrier');
    testRoot.blur(input);

    expect(harness.commits[0].label).toBe('Rename voice');
    expect(harness.commits[0].schedule.voices[1].description).toBe('Carrier');
  });

  it('reorders with buttons, disabled at the ends of the list', () => {
    const harness = mount(twoVoices());

    expect(control(0, 'Move up').disabled).toBe(true);
    expect(control(1, 'Move down').disabled).toBe(true);

    testRoot.click(control(0, 'Move down'));
    expect(harness.structural[0].label).toBe('Move voice');
    expect(harness.structural[0].edit.voiceMap).toEqual([1, 0]);
    // No explicit selection: it is carried across the map rather than moved to this voice.
    expect(harness.structural[0].selection).toBeUndefined();
  });

  it('deletes a voice and reports the gap it left', () => {
    const harness = mount(twoVoices());

    testRoot.click(control(1, 'Delete'));
    expect(harness.structural[0].label).toBe('Delete voice');
    expect(harness.structural[0].edit.schedule.voices).toHaveLength(1);
    expect(harness.structural[0].edit.voiceMap).toEqual([0, -1]);
  });

  it('adds a voice of any kind, at the length the schedule already plays', () => {
    const schedule = twoVoices();
    const harness = mount(schedule);

    testRoot.click(testRoot.byText('button', 'Add tone voice'));
    const tone = harness.structural[0].edit.schedule.voices[2];
    expect(tone.type).toBe(VoiceType.Binaural);
    expect(voiceDuration(tone)).toBe(scheduleDuration(schedule));
    // The new node is what a person would edit next, so it is selected.
    expect(harness.structural[0].selection).toEqual({ voice: 2, entry: 0 });

    testRoot.click(testRoot.byText('button', 'Add isochronic voice'));
    const pulse = harness.structural[1].edit.schedule.voices[2];
    expect(pulse.type).toBe(VoiceType.IsoPulse);
    expect(voiceDuration(pulse)).toBe(scheduleDuration(schedule));

    testRoot.click(testRoot.byText('button', 'Add noise voice'));
    expect(harness.structural[2].edit.schedule.voices[2].type).toBe(VoiceType.PinkNoise);
  });

  /**
   * Types 3 and 4 differ only in which ear each pulse lands in, so the editor offers one voice with
   * a switch rather than two things to add. The toggle is on that voice's own row, and nowhere else.
   */
  it('switches an isochronic voice between both ears and alternating', () => {
    const schedule = {
      ...twoVoices(),
      voices: [makeVoice(), makeVoice({ id: 1, type: VoiceType.IsoPulse })],
    };
    const harness = mount(schedule);

    expect(rows()[1].textContent).toContain('isochronic');
    expect(() => control(0, 'Alternate ears')).toThrow();

    const toggle = control(1, 'Alternate ears');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    testRoot.click(toggle);
    expect(harness.commits[0].label).toBe('Alternate ears');
    expect(harness.commits[0].schedule.voices[1].type).toBe(VoiceType.IsoPulseAlt);
  });

  it('shows an alternating voice as such, and switches it back', () => {
    const harness = mount({
      ...twoVoices(),
      voices: [makeVoice({ type: VoiceType.IsoPulseAlt })],
    });

    expect(rows()[0].textContent).toContain('isochronic (alternating)');
    expect(control(0, 'Alternate ears').getAttribute('aria-pressed')).toBe('true');

    testRoot.click(control(0, 'Alternate ears'));
    expect(harness.commits[0].label).toBe('Pulse in both ears');
    expect(harness.commits[0].schedule.voices[0].type).toBe(VoiceType.IsoPulse);
  });

  /**
   * Step 6 put a nothing-to-play line here, scoped to the one state it could newly create.
   * `ValidationPanel` carries it now, so this component must not say it a second time — two
   * surfaces wording the same fact is exactly what taking it from the shared producer avoided.
   */
  it('leaves the empty-schedule message to the validation panel', () => {
    mount({ ...twoVoices(), voices: [] });

    expect(rows()).toHaveLength(0);
    expect(testRoot.query('.editor__hint--warn')).toBeNull();
    expect(testRoot.container.textContent).not.toContain('no voices');
  });
});
