import { describe, expect, it } from 'vitest';
import type { Entry, Schedule, Voice } from '../document/types';
import { VoiceType } from '../document/types';
import { setupRoot } from '../test-utils';
import { VoiceList } from './VoiceList';
import type { VoiceGate } from './usePlayer';

function makeEntry(): Entry {
  return {
    duration: 300,
    baseFreq: 200,
    beatFreq: 8,
    volumeLeft: 0.5,
    volumeRight: 0.5,
    preserved: {},
  };
}

function makeVoice(overrides: Partial<Voice> = {}): Voice {
  return {
    id: 0,
    description: 'Carrier',
    type: VoiceType.Binaural,
    muted: false,
    hidden: false,
    mono: false,
    entries: [makeEntry()],
    preserved: {},
    ...overrides,
  };
}

function scheduleOf(voices: Voice[]): Schedule {
  return {
    title: 'Program',
    description: '',
    author: '',
    loops: 1,
    masterVolume: { left: 1, right: 1 },
    stereoSwap: false,
    voices,
    preserved: {},
  };
}

const testRoot = setupRoot();

interface Harness {
  mutes: number[];
  solos: number[];
}

function mount(schedule: Schedule, gates: VoiceGate[]): Harness {
  const harness: Harness = { mutes: [], solos: [] };

  testRoot.render(
    <VoiceList
      schedule={schedule}
      gates={gates}
      onToggleMute={(index) => harness.mutes.push(index)}
      onToggleSolo={(index) => harness.solos.push(index)}
    />,
  );

  return harness;
}

function rows() {
  return testRoot.queryAll('.voice-list__row');
}

function buttons(rowIndex: number): HTMLButtonElement[] {
  return [...rows()[rowIndex].querySelectorAll('button')] as HTMLButtonElement[];
}

function speaker(rowIndex: number): HTMLButtonElement {
  return buttons(rowIndex)[0];
}

function solo(rowIndex: number): HTMLButtonElement {
  return buttons(rowIndex)[1];
}

const AUDIBLE: VoiceGate = { muted: false, soloed: false };

describe('VoiceList', () => {
  /**
   * Solo silences by muting, so the rows it silenced are muted rows and say so with the same
   * crossed speaker a hand-muted one shows. There is no second cue, because there is no second
   * reason to be quiet.
   */
  it('shows a soloed voice as the only unmuted one', () => {
    const schedule = scheduleOf([makeVoice(), makeVoice({ id: 1, description: 'Bed' })]);
    mount(schedule, [
      { muted: false, soloed: true },
      { muted: true, soloed: false },
    ]);

    expect(rows()[0].className).not.toContain('voice-list__row--silent');
    expect(rows()[1].className).toContain('voice-list__row--silent');

    expect(speaker(0).getAttribute('aria-pressed')).toBe('false');
    expect(speaker(0).getAttribute('title')).toBe('Mute Carrier');
    expect(speaker(1).getAttribute('aria-pressed')).toBe('true');
    expect(speaker(1).getAttribute('title')).toBe('Unmute Bed');
    expect(solo(0).getAttribute('aria-pressed')).toBe('true');
  });

  it('routes both toggles to the player by index', () => {
    const schedule = scheduleOf([makeVoice(), makeVoice({ id: 1 })]);
    const harness = mount(schedule, [AUDIBLE, AUDIBLE]);

    testRoot.click(speaker(1));
    testRoot.click(solo(0));

    expect(harness.mutes).toEqual([1]);
    expect(harness.solos).toEqual([0]);
  });

  /**
   * §3.3: a voice must never be silently dropped. One this app cannot render never sounds, so the
   * row cannot wait for a gate to tell it that — it would otherwise read as audible next to a
   * working voice that was muted.
   */
  it('always shows an unrenderable voice as silent, with its controls disabled', () => {
    const schedule = scheduleOf([
      makeVoice(),
      makeVoice({ id: 1, description: 'Sample', type: VoiceType.Pcm }),
    ]);
    mount(schedule, [AUDIBLE, AUDIBLE]);

    expect(rows()[1].className).toContain('voice-list__row--silent');
    expect(rows()[1].textContent).toContain('cannot be rendered');
    expect(speaker(1).disabled).toBe(true);
    expect(solo(1).disabled).toBe(true);
  });
});
