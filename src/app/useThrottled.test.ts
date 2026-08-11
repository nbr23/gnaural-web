import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '../test-utils';
import { ENGINE_UPDATE_INTERVAL_MS, useThrottled } from './useThrottled';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe('useThrottled', () => {
  it('delivers the first value immediately', () => {
    const seen: number[] = [];
    const hook = renderHook(() => useThrottled((value: number) => seen.push(value)));

    act(() => hook.current(1));

    expect(seen).toEqual([1]);
  });

  it('collapses a burst into one leading and one trailing call', () => {
    const seen: number[] = [];
    const hook = renderHook(() => useThrottled((value: number) => seen.push(value)));

    act(() => {
      for (let i = 1; i <= 30; i++) hook.current(i);
    });

    expect(seen).toEqual([1]);

    advance(ENGINE_UPDATE_INTERVAL_MS);

    // **The last value is the one that must not be dropped**: it is what the sliders are showing,
    // and an engine left on an intermediate value is audibly not what the readout says.
    expect(seen).toEqual([1, 30]);
  });

  it('keeps delivering through a drag that outlives several intervals', () => {
    const seen: number[] = [];
    const hook = renderHook(() => useThrottled((value: number) => seen.push(value)));

    for (let tick = 0; tick < 5; tick++) {
      act(() => {
        hook.current(tick * 10);
        hook.current(tick * 10 + 1);
      });
      advance(ENGINE_UPDATE_INTERVAL_MS);
    }

    // One call per interval, never one per event — and the run ends on the final value.
    expect(seen.length).toBeLessThanOrEqual(6);
    expect(seen.at(-1)).toBe(41);
  });

  it('flushes what is pending when the view goes away mid-drag', () => {
    const seen: number[] = [];
    const hook = renderHook(() => useThrottled((value: number) => seen.push(value)));

    act(() => {
      hook.current(1);
      hook.current(2);
    });
    expect(seen).toEqual([1]);

    hook.unmount();

    expect(seen).toEqual([1, 2]);
  });

  it('calls the latest action, not the one captured when the throttle was created', () => {
    // The action closes over the player and the settings setter; a stale one would push an edit
    // into a disposed engine.
    let target = 'first';
    const seen: string[] = [];
    const hook = renderHook(() => useThrottled(() => seen.push(target)));

    act(() => hook.current(undefined));
    expect(seen).toEqual(['first']);

    target = 'second';
    hook.rerender();
    advance(ENGINE_UPDATE_INTERVAL_MS);
    act(() => hook.current(undefined));

    expect(seen).toEqual(['first', 'second']);
  });
});
