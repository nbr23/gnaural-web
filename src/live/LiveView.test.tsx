import { describe, expect, it, vi } from 'vitest';
import type { Schedule } from '../document/types';
import { SILENT_NOISE_LAYER } from '../engine/engine';
import type { Player } from '../player/usePlayer';
import { setInputValue, setupRoot, wait } from '../test-utils';
import { LiveView } from './LiveView';
import { BASE_RANGE, BEAT_RANGE } from './liveSchedule';
import { ENGINE_UPDATE_INTERVAL_MS } from '../app/useThrottled';

const root = setupRoot();

function fakePlayer(overrides: Partial<Player> = {}): Player {
  return {
    playing: false,
    offset: 0,
    duration: 0,
    pass: 0,
    passCount: 1,
    transport: 0,
    voiceGates: [],
    play: vi.fn(),
    pause: vi.fn(),
    stop: vi.fn(),
    seek: vi.fn(),
    update: vi.fn(),
    toggleMute: vi.fn(),
    toggleSolo: vi.fn(),
    ...overrides,
  };
}

interface Harness {
  player: Player;
  values: { baseFreq: number; beatFreq: number }[];
  kept: { schedule: Schedule; sourceName: string }[];
}

function render(options: { player?: Player; stored?: { base: number; beat: number }; hydrated?: boolean } = {}): Harness {
  const player = options.player ?? fakePlayer();
  const values: Harness['values'] = [];
  const kept: Harness['kept'] = [];

  root.render(
    <LiveView
      player={player}
      storedBaseFreq={options.stored?.base ?? 200}
      storedBeatFreq={options.stored?.beat ?? 10}
      hydrated={options.hydrated ?? true}
      onValuesChange={(next) => values.push(next)}
      masterGain={1}
      onMasterGainChange={() => undefined}
      noise={SILENT_NOISE_LAYER}
      onNoiseChange={() => undefined}
      wakeLock={false}
      onWakeLockChange={() => undefined}
      onKeep={(schedule, sourceName) => kept.push({ schedule, sourceName })}
    />,
  );

  return { player, values, kept };
}

const sliders = () => root.queryAll('.live__slider input') as HTMLInputElement[];
const baseSlider = () => sliders()[0];
const beatSlider = () => sliders()[1];

/** What the sliders currently say, read off the engine's most recent document. */
function pushedEntry(player: Player) {
  const last = (player.update as ReturnType<typeof vi.fn>).mock.calls.at(-1);
  if (!last) throw new Error('the engine was never told what the sliders say');
  return (last[0] as Schedule).voices[0].entries[0];
}

describe('LiveView', () => {
  it('shows no timeline and no chart (§6.1)', () => {
    render();

    expect(root.query('.schedule-chart')).toBeNull();
    expect(root.query('.timeline')).toBeNull();
    // Nor an export panel: a WAV of a live session is what "keep this as a program" is for.
    expect(root.query('.export')).toBeNull();
  });

  it('moves the readout with the slider, without waiting for the throttle', () => {
    // The engine is rate-limited; the readout must not be. A number on screen that lags the finger
    // is the failure this separation exists to prevent.
    render();
    root.act(() => setInputValue(beatSlider(), '0'));

    expect(root.query('.readout')?.textContent).toContain('0.5');
    expect(root.query('.readout')?.textContent).toContain('Delta');
  });

  it('names the EEG band the beat landed in, without snapping to it', () => {
    render();
    root.act(() => setInputValue(beatSlider(), '0.7'));

    const beat = Number(root.queryAll('.readout__value')[0].textContent?.replace(' Hz', ''));
    expect(beat).not.toBe(13); // not pulled onto a boundary
    expect(beat).toBeGreaterThan(8);
    expect(root.query('.readout')?.textContent).toContain('Alpha');
  });

  it('jumps to a band when its chip is pressed', () => {
    render();
    root.click(root.byText('.live__band', 'Theta'));

    const beat = Number(root.queryAll('.readout__value')[0].textContent?.replace(' Hz', ''));
    expect(beat).toBeGreaterThanOrEqual(4);
    expect(beat).toBeLessThan(8);
    expect(root.byText('.live__band', 'Theta')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('pushes the sliders through `update`, never through a reload', async () => {
    const { player } = render();
    root.act(() => setInputValue(baseSlider(), '1'));
    await wait(ENGINE_UPDATE_INTERVAL_MS * 2);

    expect(pushedEntry(player).baseFreq).toBe(BASE_RANGE.max);
  });

  it('rate-limits the engine but always delivers the last value', async () => {
    const { player } = render();

    root.act(() => {
      for (let i = 0; i <= 20; i++) setInputValue(beatSlider(), String(i / 20));
    });
    await wait(ENGINE_UPDATE_INTERVAL_MS * 2);

    const calls = (player.update as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(calls).toBeLessThan(21);
    expect(pushedEntry(player).beatFreq).toBe(BEAT_RANGE.max);
  });

  it('seeds from the stored values once the settings read lands', async () => {
    const { player, values } = render({ stored: { base: 320, beat: 4.5 }, hydrated: true });
    await wait(ENGINE_UPDATE_INTERVAL_MS * 2);

    expect(root.query('.readout')?.textContent).toContain('320');
    expect(pushedEntry(player).beatFreq).toBe(4.5);
    // Seeding is not a change, so nothing is written back — writing would mark the key touched in
    // `useSettings` and make a default win over the value the read is delivering.
    expect(values).toEqual([]);
  });

  it('persists a value someone actually moved', async () => {
    const { values } = render();
    root.act(() => setInputValue(baseSlider(), '0'));
    await wait(ENGINE_UPDATE_INTERVAL_MS * 2);

    expect(values.at(-1)).toEqual({ baseFreq: BASE_RANGE.min, beatFreq: 10 });
  });

  it('keeps a session as a program of the length asked for, not the session length', () => {
    const { kept } = render();

    root.act(() => setInputValue(root.query('.live__field input') as HTMLInputElement, '5'));
    root.click(root.byText('.button', 'Keep'));

    expect(kept).toHaveLength(1);
    expect(kept[0].sourceName).toBe('Live session');
    expect(kept[0].schedule.voices[0].entries[0].duration).toBe(300);
    expect(kept[0].schedule.title).toContain('10 Hz beat at 200 Hz base');
  });

  it('refuses a length outside what a program can sensibly be', () => {
    const { kept } = render();

    root.act(() => setInputValue(root.query('.live__field input') as HTMLInputElement, '0'));
    root.click(root.byText('.button', 'Keep'));

    expect(kept).toEqual([]);
  });

  it('drives the transport it has, and offers no seek', () => {
    const { player } = render({ player: fakePlayer({ playing: true, offset: 65 }) });

    expect(root.query('.live__elapsed')?.textContent).toBe('1:05');
    root.click(root.byText('.button', 'Pause'));
    expect(player.pause).toHaveBeenCalled();

    expect(root.byText('.button', '+30s')).toBeUndefined();
  });
});
