import { useEffect, useRef } from 'react';
import type { Player } from '../player/usePlayer';
import { SEEK_STEP_SECONDS } from '../player/usePlayer';

/**
 * Whether a key event landed in a field the user is filling in — a document-level shortcut must
 * never fire there. Also used by the editor's undo shortcuts.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  const tag = element?.tagName;
  return (
    tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element?.isContentEditable === true
  );
}

/** A focused button already owns Space — it's how the button is pressed. */
function ownsTheKey(target: EventTarget | null): boolean {
  return isTypingTarget(target) || (target as HTMLElement | null)?.tagName === 'BUTTON';
}

/**
 * Space to play or pause, arrows to seek, Escape to leave — the transport, from anywhere in the app.
 * Bound to the window rather than a focused element: playback is a property of the app, not of
 * whatever happens to have focus.
 */
export function useKeyboardShortcuts(
  player: Player,
  seekable: boolean,
  onExit: (() => void) | null,
): void {
  const { playing, play, pause, seek } = player;

  // Read through a ref rather than depended on: `offset` moves ten times a second, and an effect
  // depending on it would tear down and re-register the listener at that rate.
  const offset = useRef(player.offset);
  offset.current = player.offset;

  const exit = useRef(onExit);
  exit.current = onExit;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      // A view that wants Escape for itself (a selection, a crosshair) prevents the default.
      if (event.key === 'Escape') {
        if (event.defaultPrevented || isTypingTarget(event.target)) return;
        exit.current?.();
        return;
      }

      if (ownsTheKey(event.target)) return;

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
