import { useEffect, useRef } from 'react';
import type { Player } from '../player/usePlayer';
import { SEEK_STEP_SECONDS } from '../player/usePlayer';

/**
 * Whether a key event landed in a field the user is filling in.
 *
 * Shared with the editor's undo shortcuts, which need exactly the same answer for a different key:
 * a document-level shortcut must never fire inside a text field, where the browser's own editing
 * behaviour is the better one.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  const tag = element?.tagName;
  return (
    tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element?.isContentEditable === true
  );
}

/**
 * Additionally, a focused button already owns Space — it is how a button is pressed. Taking it
 * would mean Space on the Stop button paused instead of stopping, which is worse than no shortcut.
 * The arrows are covered by `isTypingTarget`: the timeline and the volume are range *inputs*.
 */
function ownsTheKey(target: EventTarget | null): boolean {
  return isTypingTarget(target) || (target as HTMLElement | null)?.tagName === 'BUTTON';
}

/**
 * Space to play or pause, arrows to seek — the transport, from anywhere in the app.
 *
 * On the window rather than on a focused element, for the reason the editor's undo is: playback is
 * a property of the app, not of whatever happens to have focus. Space is `preventDefault`ed only
 * when it actually fires, so a page that is merely being scrolled with it still scrolls.
 *
 * Deliberately does nothing on a program that cannot play — `player.play()` on an empty schedule is
 * already a no-op — and nothing about seeking a live session, where ±30 s of a constant hold
 * changes nothing anyone can hear. That is the same reasoning `LiveView` uses to omit the buttons.
 */
export function useKeyboardShortcuts(player: Player, seekable: boolean): void {
  const { playing, play, pause, seek } = player;

  // Read through a ref, never depended on: `offset` moves ten times a second, and an effect that
  // depended on it would tear down and re-register the listener at that rate. `useMediaSession`
  // reads the playhead the same way, for the same reason.
  const offset = useRef(player.offset);
  offset.current = player.offset;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || ownsTheKey(event.target)) return;

      switch (event.key) {
        case ' ':
          event.preventDefault();
          if (playing) pause();
          else play();
          return;
        case 'ArrowLeft':
          if (!seekable) return;
          event.preventDefault();
          seek(offset.current - SEEK_STEP_SECONDS);
          return;
        case 'ArrowRight':
          if (!seekable) return;
          event.preventDefault();
          seek(offset.current + SEEK_STEP_SECONDS);
          return;
        default:
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [pause, play, playing, seek, seekable]);
}
