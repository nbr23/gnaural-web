import { useEffect, useState } from 'react';

/**
 * A media query as a boolean, kept live. Guarded on `matchMedia` existing so the test environment
 * (happy-dom, which lays nothing out) gets `false` rather than a crash.
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
 * Whether there is room to put the panels beside the chart instead of below it. Matches the
 * breakpoint the stylesheet switches the two-column grid at — the chart's height is a prop, not a
 * rule, so the two must agree.
 */
export const WIDE_LAYOUT = '(min-width: 1100px)';

export function useWideLayout(): boolean {
  return useMediaQuery(WIDE_LAYOUT);
}
