import { useEffect, useState } from 'react';

/**
 * A media query as a boolean, kept live.
 *
 * The two views that use it need layout decisions JavaScript has to make — how tall to draw the
 * chart, which is a number the SVG needs rather than a style, and whether a panel starts open — and
 * those cannot be expressed in the stylesheet where the rest of the responsive behaviour lives.
 * Everything that *can* stay in CSS does.
 *
 * Guarded on `matchMedia` existing so the test environment (happy-dom, which lays nothing out) gets
 * the desktop-shaped `false` rather than a crash.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia?.(query).matches ?? false);

  useEffect(() => {
    const list = window.matchMedia?.(query);
    if (!list) return;

    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    setMatches(list.matches);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

/**
 * Whether the primary pointer is a finger rather than a mouse.
 *
 * What it decides: **the chart stops being a scrub surface on touch.** A plot wide enough to read
 * is a plot wide enough to brush past, and a stray touch that jumps the playhead twenty minutes
 * into a sleep programme is not a seek, it is an accident — while the timeline slider beneath it is
 * a native touch target that cannot be hit by mistake. A mouse has neither problem, so it keeps the
 * shortcut.
 *
 * Live rather than read once: a tablet with a keyboard attached changes answer without reloading.
 */
export function useCoarsePointer(): boolean {
  return useMediaQuery('(pointer: coarse)');
}

/**
 * Whether there is room to put the panels beside the chart instead of below it.
 *
 * The same breakpoint the stylesheet switches the two-column grid at — stated here as well because
 * the chart's height is a prop, not a rule, and the two must agree.
 */
export const WIDE_LAYOUT = '(min-width: 1100px)';

export function useWideLayout(): boolean {
  return useMediaQuery(WIDE_LAYOUT);
}
