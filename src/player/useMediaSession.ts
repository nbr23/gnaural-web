import { useEffect, useRef } from 'react';
import type { Player } from './usePlayer';
import { SEEK_STEP_SECONDS } from './usePlayer';

/** How far the notification's skip buttons move the playhead — the player's own step. */
export const MEDIA_SEEK_STEP = SEEK_STEP_SECONDS;

/**
 * Lock-screen metadata and controls on Android.
 *
 * Purely an observer of `usePlayer`: it reads the player's state to publish it, and its action
 * handlers call the player's existing verbs. No `AudioContext`, no nodes — the UI never touches
 * audio directly, whether from a button or an OS-invoked handler.
 *
 * The playhead is read through a ref, never depended on: `player.offset` changes 60 times a second
 * while playing, and an effect depending on it would re-register the action handlers and republish
 * position every frame. Position is instead published on `player.transport` — every deliberate
 * move and nothing else — and the OS extrapolates between those from `playbackRate`.
 *
 * The notification itself is raised by the silent keepalive element in `keepalive.ts`.
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

    // `previoustrack`/`nexttrack` are skips, not track changes: there's one program, so a
    // notification offering them should move within it rather than do nothing.
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
      // tells the OS the playhead is standing still instead.
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
