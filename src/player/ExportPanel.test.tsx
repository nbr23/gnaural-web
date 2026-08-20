import { describe, expect, it } from 'vitest';
import type { Entry, Schedule, Voice } from '../document/types';
import { VoiceType } from '../document/types';
import { setupRoot } from '../test-utils';
import { ExportPanel } from './ExportPanel';
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

const AUDIBLE: VoiceGate = { muted: false, soloed: false };
const MUTED: VoiceGate = { muted: true, soloed: false };

const testRoot = setupRoot();

function mount(schedule: Schedule, gates: VoiceGate[]): void {
  testRoot.render(
    <ExportPanel
      schedule={schedule}
      sampleRate={44100}
      onSampleRateChange={() => undefined}
      gates={gates}
    />,
  );
}

function button(label: string): HTMLButtonElement | undefined {
  return testRoot.byText('.button', label) as HTMLButtonElement | undefined;
}

describe('ExportPanel', () => {
  it('offers the WAV while any voice is still audible', () => {
    mount(scheduleOf([makeVoice(), makeVoice({ id: 1 })]), [AUDIBLE, MUTED]);

    expect(button('Export WAV')?.disabled).toBe(false);
    expect(testRoot.text()).not.toContain('Nothing is audible');
  });

  it('blocks the WAV when everything is muted, and says why', () => {
    mount(scheduleOf([makeVoice(), makeVoice({ id: 1 })]), [MUTED, MUTED]);

    expect(button('Export WAV')?.disabled).toBe(true);
    expect(testRoot.text()).toContain('Nothing is audible');
  });

  it('keeps the link and the .gnaural file, which carry the whole program', () => {
    mount(scheduleOf([makeVoice()]), [MUTED]);

    expect(button('Share link')?.disabled).toBe(false);
    expect(button('Export .gnaural')?.disabled).toBe(false);
  });

  it('blocks the WAV for a program with no renderable voice at all', () => {
    mount(scheduleOf([makeVoice({ type: VoiceType.Pcm })]), [AUDIBLE]);

    expect(button('Export WAV')?.disabled).toBe(true);
  });
});
