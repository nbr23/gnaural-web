import { useEffect, useState } from 'react';

/**
 * Hash routing, hand-rolled.
 *
 * The fragment rather than a path because there is no server to configure (PLAN.md §2 — no
 * backend), and hand-rolled rather than a router dependency because there are two views. It buys
 * one thing that matters on the target platform: Android's back button returns to the library
 * instead of leaving the app.
 *
 * `#/s/…` is deliberately left unclaimed for step 8's share links, which put a compressed
 * schedule in the fragment.
 */
export type Route =
  | { view: 'library' }
  | { view: 'program'; id: string }
  /** A file the user opened this session. Depends on in-memory state, so it survives no reload. */
  | { view: 'opened' };

export const LIBRARY: Route = { view: 'library' };

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#\/?/, '');
  if (path === 'opened') return { view: 'opened' };

  const program = /^p\/(.+)$/.exec(path);
  if (program) return { view: 'program', id: decodeURIComponent(program[1]) };

  return LIBRARY;
}

export function formatHash(route: Route): string {
  switch (route.view) {
    case 'program':
      return `#/p/${encodeURIComponent(route.id)}`;
    case 'opened':
      return '#/opened';
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
