import { afterEach, describe, expect, it, vi } from 'vitest';
import { SilentKeepalive } from './keepalive';

/**
 * The element is appended to the document by design (Chrome raises a media notification far more
 * consistently for an attached one), which also means a test can reach it without the class
 * exposing it.
 */
function element(): HTMLAudioElement {
  const found = document.querySelector('audio');
  if (!found) throw new Error('the keepalive element was never created');
  return found;
}

const keepalives: SilentKeepalive[] = [];

function create(): SilentKeepalive {
  const keepalive = new SilentKeepalive();
  keepalives.push(keepalive);
  return keepalive;
}

afterEach(() => {
  for (const keepalive of keepalives.splice(0)) keepalive.dispose();
});

describe('platform transport events', () => {
  it('reports a pause that the platform initiated', () => {
    const onPlatformPause = vi.fn();
    const keepalive = create();
    keepalive.onPlatformPause = onPlatformPause;
    keepalive.start(48000);

    // What Android's notification does to the element when its pause button is pressed.
    element().dispatchEvent(new Event('pause'));

    expect(onPlatformPause).toHaveBeenCalledTimes(1);
  });

  it('reports a play that the platform initiated — the case action handlers missed', () => {
    const onPlatformPlay = vi.fn();
    const keepalive = create();
    keepalive.onPlatformPlay = onPlatformPlay;
    keepalive.start(48000);

    element().dispatchEvent(new Event('play'));

    expect(onPlatformPlay).toHaveBeenCalled();
  });

  it('survives having no handlers attached', () => {
    const keepalive = create();
    keepalive.start(48000);

    expect(() => element().dispatchEvent(new Event('play'))).not.toThrow();
  });

  it('stops reporting once disposed', () => {
    const onPlatformPause = vi.fn();
    const keepalive = create();
    keepalive.onPlatformPause = onPlatformPause;
    keepalive.start(48000);
    const audio = element();

    keepalive.dispose();
    onPlatformPause.mockClear();
    audio.dispatchEvent(new Event('pause'));

    expect(onPlatformPause).not.toHaveBeenCalled();
  });
});
