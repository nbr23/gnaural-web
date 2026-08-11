import { encodeWav } from '../engine/wav';

/**
 * A silent, looping `<audio>` element that runs alongside the Web Audio graph.
 *
 * Chrome raises its media notification — the lock-screen controls PLAN.md §5.3 makes a
 * condition of done — off `HTMLMediaElement` playback. A page whose only output is Web Audio
 * takes audio focus but does not reliably get that notification, so `MediaSession` metadata and
 * action handlers have nothing to appear in. An element playing silence is the standard way
 * round it, and it has a second benefit on the target platform: it keeps the page foregrounded
 * with the screen off, which is exactly the risk §9's table names.
 *
 * **No audio asset ships for this.** The WAV is a second of zeroes encoded at runtime by the same
 * `encodeWav` the export path uses, so §4.6's "the app synthesises everything" still holds
 * literally — there is nothing to license, cache, or lazy-load.
 *
 * A plain class rather than a hook, owned by `usePlayer` through a ref: the same ownership shape
 * as `PlaybackEngine`, and for the same reason (§4 — no component lifecycle hook may create or
 * destroy audio resources).
 */

/** Long enough that the loop point is not a stream of tiny requests, short enough to be trivial:
 *  one second of stereo zeroes at 8 kHz is 32 KB, and its content is silence either way. */
const SAMPLE_RATE = 8000;

export class SilentKeepalive {
  private element: HTMLAudioElement | null = null;
  private url: string | null = null;

  /**
   * Must be called from inside a user gesture, like the `AudioContext` it accompanies (§4.4).
   * Resolves nothing and rejects nothing: a browser that refuses playback costs us the
   * notification, not the audio.
   */
  start(): void {
    if (!this.element) {
      // `AudioBuffer` is directly constructible, so this needs no context of its own — and must
      // not borrow the engine's, which may not exist yet.
      this.url = URL.createObjectURL(
        encodeWav(new AudioBuffer({ numberOfChannels: 2, length: SAMPLE_RATE, sampleRate: SAMPLE_RATE })),
      );

      const element = new Audio(this.url);
      element.loop = true;
      // Deliberately not muted: a muted element raises no media session, which is the whole point.
      element.volume = 1;
      this.element = element;
    }

    void this.element.play().catch(() => undefined);
  }

  stop(): void {
    this.element?.pause();
  }

  dispose(): void {
    this.element?.pause();
    this.element = null;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
  }
}
