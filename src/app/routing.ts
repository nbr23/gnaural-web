import { useEffect, useState } from 'react';

/**
 * Hash routing, hand-rolled: the fragment rather than a path since there's no server to configure,
 * and no router dependency since there's a library and a player and nothing else. It also means
 * Android's back button returns to the library instead of leaving the app.
 */
export type Route =
  | { view: 'library' }
  /** Live mode — sliders, no program to name, so the route carries nothing. */
  | { view: 'live' }
  /** A bundled program, by the id in `src/library/programs.ts`. */
  | { view: 'program'; id: string }
  /** A program the user imported, by its IndexedDB key. */
  | { view: 'imported'; id: string }
  /** A draft being authored, by its IndexedDB key. */
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

  // base64url by construction, so the payload is taken verbatim.
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

/**
 * Whether the next route change is one the app made, rather than the back button. Changing the
 * fragment doesn't move the scroll position, so navigating scrolls to top explicitly; going back
 * should restore the previous scroll position, which the browser already does.
 */
let pushed = false;

export function navigate(route: Route): void {
  const next = formatHash(route);
  if (window.location.hash === next) return;

  pushed = true;
  window.location.hash = next;
}

/** Replaces the current entry instead of pushing — for redirecting away from a dead route. */
export function redirect(route: Route): void {
  window.history.replaceState(null, '', formatHash(route));
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));

  useEffect(() => {
    const onChange = () => {
      setRoute(parseHash(window.location.hash));
      if (!pushed) return;
      pushed = false;
      window.scrollTo?.(0, 0);
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return route;
}
