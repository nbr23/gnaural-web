import { describe, expect, it } from 'vitest';
import type { Entry, Schedule, Voice } from '../document/types';
import { VoiceType } from '../document/types';
import { setupRoot } from '../test-utils';
import { Readout } from './Readout';
import type { VoiceGate } from './usePlayer';

function makeEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    duration: 300,
    baseFreq: 200,
    beatFreq: 10,
    volumeLeft: 0.5,
    volumeRight: 0.5,
    preserved: {},
    ...overrides,
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

function mount(schedule: Schedule, gates?: VoiceGate[], offset = 0) {
  testRoot.render(<Readout schedule={schedule} offset={offset} gates={gates} />);
}

function lines(): Element[] {
  return testRoot.queryAll('.readout__voice');
}

const AUDIBLE: VoiceGate = { muted: false, soloed: false };

const THETA = makeVoice({ id: 1, description: 'Drift', entries: [makeEntry({ beatFreq: 6 })] });

describe('Readout', () => {
  it('reads one voice as tiles, with no voice to name', () => {
    mount(scheduleOf([makeVoice()]));

    expect(lines()).toHaveLength(0);
    expect(testRoot.text()).toContain('Beat');
    expect(testRoot.text()).toContain('Alpha');
    expect(testRoot.text()).not.toContain('Carrier');
  });

  it('gives every audible voice its own band', () => {
    mount(scheduleOf([makeVoice(), THETA]), [AUDIBLE, AUDIBLE]);

    expect(lines()).toHaveLength(2);
    expect(lines()[0].textContent).toContain('Carrier');
    expect(lines()[0].textContent).toContain('Alpha');
    expect(lines()[1].textContent).toContain('Drift');
    expect(lines()[1].textContent).toContain('Theta');
  });

  it('drops a voice the session has muted', () => {
    mount(scheduleOf([makeVoice(), THETA]), [AUDIBLE, { muted: true, soloed: false }]);

    expect(lines()).toHaveLength(0);
    expect(testRoot.text()).toContain('Alpha');
    expect(testRoot.text()).not.toContain('Theta');
  });

  it('falls back to the document mute when there are no gates', () => {
    mount(scheduleOf([makeVoice({ muted: true }), THETA]));

    expect(testRoot.text()).toContain('Theta');
    expect(testRoot.text()).not.toContain('Alpha');
  });

  /** `hidden` says whether the chart draws a voice, not whether it sounds. */
  it('reports a voice hidden from the chart', () => {
    mount(scheduleOf([makeVoice({ hidden: true }), THETA]), [AUDIBLE, AUDIBLE]);

    expect(lines()).toHaveLength(2);
  });

  it('ignores voices whose frequencies are not a tone', () => {
    const noise = makeVoice({ id: 1, description: 'Bed', type: VoiceType.PinkNoise });
    mount(scheduleOf([makeVoice(), noise]), [AUDIBLE, AUDIBLE]);

    expect(lines()).toHaveLength(0);
    expect(testRoot.text()).not.toContain('Bed');
  });

  it('renders nothing when no tonal voice is audible', () => {
    mount(scheduleOf([makeVoice({ type: VoiceType.PinkNoise })]));

    expect(testRoot.query('.readout')).toBeNull();
  });

  it('drops the band of a voice whose beat is off the table, keeping its figures', () => {
    const slow = makeVoice({ id: 1, description: 'Deep', entries: [makeEntry({ beatFreq: 0.2 })] });
    mount(scheduleOf([makeVoice(), slow]), [AUDIBLE, AUDIBLE]);

    expect(lines()).toHaveLength(2);
    expect(lines()[1].textContent).toContain('Deep');
    expect(lines()[1].textContent).toContain('0.20 Hz');
    expect(lines()[1].querySelector('.readout__band--none')).not.toBeNull();
    expect(lines()[1].querySelector('.readout__dot')).toBeNull();
  });

  it('drops the band tile of a lone voice with no band', () => {
    mount(scheduleOf([makeVoice({ entries: [makeEntry({ beatFreq: 0.2 })] })]));

    expect(testRoot.queryAll('.readout__tile')).toHaveLength(2);
    expect(testRoot.text()).toContain('Beat');
    expect(testRoot.text()).not.toContain('Band');
  });

  it('follows a ramping beat across a band boundary', () => {
    const ramp = makeVoice({
      entries: [makeEntry({ duration: 100, beatFreq: 10 }), makeEntry({ beatFreq: 4 })],
    });

    mount(scheduleOf([ramp]), undefined, 0);
    expect(testRoot.text()).toContain('Alpha');

    mount(scheduleOf([ramp]), undefined, 100);
    expect(testRoot.text()).toContain('Theta');
  });
});
