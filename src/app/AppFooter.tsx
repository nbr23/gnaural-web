import { BUILD_ID } from './build';
import './AppFooter.css';

/**
 * The page footer, on every view rather than only on the library.
 *
 * An installed PWA can be running a build older than the one just deployed — with
 * `registerType: 'prompt'` the service worker waits to be told to swap — so "which build is this?"
 * is a real question, and it is asked from wherever the bug was noticed. That is usually the player,
 * which is exactly where this used to be missing.
 *
 * Rendered once by `App`, not by each view: the library, player, editor and Live have four
 * different layouts, and a footer that is a child of the page has to be placed in all four.
 */
export function AppFooter() {
  return (
    <footer className="app-footer">
      <p className="app-footer__build">build {BUILD_ID}</p>
    </footer>
  );
}
