import { encodeWav } from '../engine/wav';

/**
 * A silent, looping `<audio>` element that runs alongside the Web Audio graph.
 *
 * Chrome raises its lock-screen media notification off `HTMLMediaElement` playback, not off Web
 * Audio — a page whose only output is Web Audio takes audio focus but doesn't reliably get that
 * notification, so `MediaSession` metadata and action handlers have nothing to appear in. An
 * element playing silence is the standard workaround, and on Android it has a second benefit: it
 * keeps the page foregrounded with the screen off.
 *
 * The WAV is zeroes encoded at runtime by the same `encodeWav` the export path uses, so no audio
 * asset ships for this.
 *
 * A plain class rather than a hook, owned by `usePlayer` through a ref — same ownership shape as
 * `PlaybackEngine`, since no component lifecycle hook may create or destroy audio resources.
 */

/** Android's output is 48 kHz essentially everywhere; only used if the engine has no context. */
const FALLBACK_SAMPLE_RATE = 48000;

/** Long enough that the element is not re-seeking every few seconds, short enough to stay small. */
const LOOP_SECONDS = 10;

/** Mono: it is silence, so a second channel is pure cost in a mixer already under pressure. */
const CHANNELS = 1;

export class SilentKeepalive {
  private element: HTMLAudioElement | null = null;
  private url: string | null = null;

  /**
   * Called when *anything* starts or stops the element: a notification button, a headset key,
   * another app taking audio focus — or this class's own `start()`/`stop()`. This element is what
   * Chrome builds its media notification from, so following it observes what the platform actually
   * did rather than depending on being told. Handlers must be idempotent against the caller's own
   * transport state, since these fire for this class's own calls too.
   */
  onPlatformPlay: (() => void) | null = null;
  onPlatformPause: (() => void) | null = null;

  private listeners: [string, EventListener][] = [];

  /**
   * Must be called from inside a user gesture, like the `AudioContext` it accompanies. A browser
   * that refuses playback costs us the notification, not the audio.
   *
   * `sampleRate` should be the graph's own — a mismatch puts a resampler in the output path and,
   * on Android, can make the shared output stream reconfigure underneath the audio that matters.
   */
  start(sampleRate: number | null): void {
    if (!this.element) {
      const rate = sampleRate ?? FALLBACK_SAMPLE_RATE;
      // `AudioBuffer` is directly constructible, so this needs no context of its own — and must
      // not borrow the engine's, whose lifetime it does not share.
      this.url = URL.createObjectURL(
        encodeWav(
          new AudioBuffer({
            numberOfChannels: CHANNELS,
            length: Math.round(rate * LOOP_SECONDS),
            sampleRate: rate,
          }),
        ),
      );

      const element = new Audio(this.url);
      element.loop = true;
      // Kept so `dispose()` can detach them: tearing down calls `pause()`, which fires its own
      // `pause` event, and a disposed keepalive driving a transport action on the way out would
      // turn an unmount into a bug.
      this.listeners = [
        ['play', () => this.onPlatformPlay?.()],
        ['pause', () => this.onPlatformPause?.()],
      ];
      for (const [event, listener] of this.listeners) element.addEventListener(event, listener);
      // Deliberately not muted: a muted element raises no media session, which is the whole point.
      element.volume = 1;
      element.setAttribute('aria-hidden', 'true');
      element.style.display = 'none';
      // Attached, not left floating: Chrome is markedly more consistent about raising a media
      // notification for an element that is in the document.
      document.body.append(element);
      this.element = element;
    }

    void this.element.play().catch(() => undefined);
  }

  /**
   * Called on pause as well as stop. An element left running is media the platform believes is
   * still playing, so its notification's play button would have nothing to do — no state change,
   * no `play` event, no action handler. Stopping it here is what leaves the notification something
   * to resume.
   */
  stop(): void {
    this.element?.pause();
  }

  dispose(): void {
    for (const [event, listener] of this.listeners) this.element?.removeEventListener(event, listener);
    this.listeners = [];
    this.element?.pause();
    this.element?.remove();
    this.element = null;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
  }
}
