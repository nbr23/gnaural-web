import { useEffect, useState } from 'react';

/**
 * Hash routing, hand-rolled.
 *
 * The fragment rather than a path because there is no server to configure (PLAN.md §2 — no
 * backend), and hand-rolled rather than a router dependency because there is a library and a
 * player and nothing else. It buys one thing that matters on the target platform: Android's back
 * button returns to the library instead of leaving the app.
 *
 * Three kinds of program, three prefixes. Only `#/s/` carries its program with it; the other two
 * are references, one into the bundle and one into IndexedDB.
 */
export type Route =
  | { view: 'library' }
  /** Live mode (§6.1) — sliders, no program to name, so the route carries nothing. */
  | { view: 'live' }
  /** A bundled program, by the id in `src/library/programs.ts`. */
  | { view: 'program'; id: string }
  /** A program the user imported, by its IndexedDB key. */
  | { view: 'imported'; id: string }
  /** A draft being authored (§6.1), by its IndexedDB key. */
  | { view: 'editor'; id: string }
  /** A shared program, compressed into the fragment itself — self-contained, so reload-safe. */
  | { view: 'shared'; payload: string };

export const LIBRARY: Route = { view: 'library' };
export const LIVE: Route = { view: 'live' };

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#\/?/, '');

  if (path === 'live') return LIVE;

  const program = /^p\/(.+)$/.exec(path);
  if (program) return { view: 'program', id: decodeURIComponent(program[1]) };

  const imported = /^i\/(.+)$/.exec(path);
  if (imported) return { view: 'imported', id: decodeURIComponent(imported[1]) };

  const editor = /^e\/(.+)$/.exec(path);
  if (editor) return { view: 'editor', id: decodeURIComponent(editor[1]) };

  // base64url by construction, so the payload is taken verbatim — percent-encoding it would only
  // make an already-long fragment longer.
  const shared = /^s\/([A-Za-z0-9\-_]+)$/.exec(path);
  if (shared) return { view: 'shared', payload: shared[1] };

  return LIBRARY;
}

export function formatHash(route: Route): string {
  switch (route.view) {
    case 'live':
      return '#/live';
    case 'program':
      return `#/p/${encodeURIComponent(route.id)}`;
    case 'imported':
      return `#/i/${encodeURIComponent(route.id)}`;
    case 'editor':
      return `#/e/${encodeURIComponent(route.id)}`;
    case 'shared':
      return `#/s/${route.payload}`;
    default:
      return '#/';
  }
}

export function navigate(route: Route): void {
  const next = formatHash(route);
  if (window.location.hash !== next) window.location.hash = next;
}

/** Replaces the current entry instead of pushing — for redirecting away from a dead route. */
export function redirect(route: Route): void {
  window.history.replaceState(null, '', formatHash(route));
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));

  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return route;
}
