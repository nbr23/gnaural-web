import { useEffect, useRef } from 'react';
import type { Player } from './usePlayer';

/** How far the notification's skip buttons move the playhead — the player's own step (§5.1). */
export const MEDIA_SEEK_STEP = 30;

/**
 * Lock-screen metadata and controls on Android (PLAN.md §5.1, and a condition of §5.3's done).
 *
 * Purely an observer of `usePlayer`, in both directions: it reads the player's state to publish
 * it, and its action handlers call the player's existing verbs. No `AudioContext`, no nodes, no
 * new transport primitives — §4's rule that the UI never touches audio applies just as much to a
 * handler the OS invokes as to a button someone taps.
 *
 * **The playhead is read through a ref, never depended on.** `player.offset` changes 60 times a
 * second while playing; an effect that depended on it would re-register eight action handlers and
 * republish the position on every frame. Instead, position is published on `player.transport` —
 * every deliberate move of the playhead and nothing else — and between those the OS extrapolates
 * from `playbackRate`. `title`/`artist` are passed as strings for the same reason: an object
 * would be a new dependency on every render.
 *
 * The notification itself is raised by the silent keepalive element in `keepalive.ts`; see there
 * for why Web Audio alone is not enough.
 */
export function useMediaSession(player: Player, title: string | null, artist?: string): void {
  const { playing, duration, transport, play, pause, stop, seek } = player;

  const offset = useRef(player.offset);
  offset.current = player.offset;

  useEffect(() => {
    const session = navigator.mediaSession;
    if (!session) return;

    if (title === null) {
      session.metadata = null;
      session.playbackState = 'none';
      return;
    }

    session.metadata = new MediaMetadata({
      title: title.trim() || 'Untitled program',
      artist,
      album: 'Gnaural Web',
      artwork: [
        { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
        { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
      ],
    });
  }, [artist, title]);

  useEffect(() => {
    const session = navigator.mediaSession;
    if (!session || title === null) return;

    session.playbackState = playing ? 'playing' : 'paused';
  }, [playing, title]);

  useEffect(() => {
    const session = navigator.mediaSession;
    if (!session?.setActionHandler) return;

    // `previoustrack`/`nexttrack` are skips, not track changes: there is one program, and a
    // notification that offers them should move within it rather than do nothing.
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => play()],
      ['pause', () => pause()],
      ['stop', () => stop()],
      ['seekbackward', (details) => seek(offset.current - (details.seekOffset ?? MEDIA_SEEK_STEP))],
      ['seekforward', (details) => seek(offset.current + (details.seekOffset ?? MEDIA_SEEK_STEP))],
      ['previoustrack', () => seek(offset.current - MEDIA_SEEK_STEP)],
      ['nexttrack', () => seek(offset.current + MEDIA_SEEK_STEP)],
      ['seekto', (details) => seek(details.seekTime ?? offset.current)],
    ];

    for (const [action, handler] of handlers) set(session, action, handler);
    return () => {
      for (const [action] of handlers) set(session, action, null);
    };
  }, [pause, play, seek, stop]);

  useEffect(() => {
    const session = navigator.mediaSession;
    if (!session?.setPositionState || title === null || duration <= 0) return;

    session.setPositionState({
      duration,
      position: Math.min(Math.max(offset.current, 0), duration),
      // Always 1, never 0: the spec forbids a zero rate and Chrome throws on one. `playbackState`
      // is what tells the OS the playhead is standing still.
      playbackRate: 1,
    });
  }, [duration, playing, title, transport]);
}

/** Registering an action the browser does not know throws rather than being ignored. */
function set(
  session: MediaSession,
  action: MediaSessionAction,
  handler: MediaSessionActionHandler | null,
): void {
  try {
    session.setActionHandler(action, handler);
  } catch {
    /* unsupported action */
  }
}
