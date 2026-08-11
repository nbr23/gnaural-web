import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { parseSchedule } from '../document/parser';
import { loadFixture } from '../document/test-fixtures';
import { encodeSharePayload } from '../files/shareLink';
import { PROGRAMS } from '../library/programs';
import { listImported } from '../library/storage';
import { mediaSession, resetDatabase, resetPlatform, wakeLocks } from '../test-setup';
import { flush, setCheckbox, setInputValue, setSelectValue, setupRoot, wait } from '../test-utils';

const root = setupRoot();

/** Comfortably past `useSettings`'s write debounce. */
const WRITE_DEBOUNCE = 400;

beforeEach(() => {
  resetDatabase();
  resetPlatform();
  window.location.hash = '';
});

afterEach(() => {
  window.location.hash = '';
});

describe('library view', () => {
  it('lists every bundled program, grouped by category', () => {
    root.render(<App />);

    expect(root.queryAll('.program-card')).toHaveLength(PROGRAMS.length);
    expect(root.text()).toContain('Gnaural originals');
    expect(root.text()).toContain('OOBE');
  });

  it('shows which build it is running', () => {
    // With `registerType: 'prompt'` an installed PWA can serve a build older than the one just
    // deployed, and this is the only always-visible answer to "which one is this?".
    root.render(<App />);

    expect(root.query('.library__build')?.textContent).toMatch(/^build \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('attributes the bundled descriptions to their authors rather than to the app', () => {
    // Several presets describe what the audio is *for* ("an aid for Attention Deficit
    // Hyperactivity Disorder"). The prose is upstream and preserved verbatim for credit, so §2's
    // no-medical-claims rule is met by saying whose words they are, not by rewriting them.
    root.render(<App />);

    expect(root.query('.library__attribution')?.textContent).toContain("original authors' words");
  });

  it('credits each program on its card', () => {
    root.render(<App />);
    const card = root.byText('.program-card', 'Power Nap');

    expect(card?.textContent).toContain('Gnaural');
    expect(card?.textContent).toContain('20 min');
  });
});

describe('routing', () => {
  it('opens a program from the library and shows its player', async () => {
    root.render(<App />);
    root.click(root.byText('.program-card', 'Power Nap'));
    await flush();

    expect(window.location.hash).toBe('#/p/powernap');
    expect(root.query('.player__title')?.textContent).toBe('Power Nap');
    // The chart and transport come with it.
    expect(root.queryAll('path.schedule-chart__series').length).toBeGreaterThan(0);
    expect(root.byText('.button', 'Play')).toBeDefined();
  });

  it('returns to the library from the player', async () => {
    window.location.hash = '#/p/powernap';
    root.render(<App />);
    await flush();

    root.click(root.byText('.player__back', 'Library'));
    await flush();

    expect(root.queryAll('.program-card')).toHaveLength(PROGRAMS.length);
  });

  it('redirects an unknown program id back to the library', async () => {
    window.location.hash = '#/p/does-not-exist';
    root.render(<App />);
    await flush();

    expect(root.queryAll('.program-card').length).toBeGreaterThan(0);
  });

  it('redirects an imported id that is no longer stored', async () => {
    window.location.hash = '#/i/deleted-long-ago';
    root.render(<App />);
    await flush();

    expect(root.queryAll('.program-card').length).toBeGreaterThan(0);
  });
});

describe('player view', () => {
  it('shows the live readout, timeline and voice controls for a multi-voice program', async () => {
    window.location.hash = '#/p/meditation-schumann-resonance';
    root.render(<App />);
    await flush();

    expect(root.text()).toContain('Beat');
    expect(root.text()).toContain('Band');
    expect(root.query('.timeline__range')).not.toBeNull();
    // Two voices — one binaural, one noise — each listed and labelled by type (§3.3).
    expect(root.queryAll('.voice-list__row')).toHaveLength(2);
    expect(root.text()).toContain('noise');
  });

  it('omits the voice list for a single-voice program', async () => {
    window.location.hash = '#/p/powernap';
    root.render(<App />);
    await flush();

    expect(root.queryAll('.voice-list__row')).toHaveLength(0);
  });

  it('seeks from the timeline without playing', async () => {
    window.location.hash = '#/p/powernap';
    root.render(<App />);
    await flush();

    const range = root.query('.timeline__range') as HTMLInputElement;
    root.act(() => setInputValue(range, '600'));

    expect(root.query('.timeline__times')?.textContent).toContain('10:00');
  });
});

describe('export and share', () => {
  it('offers a link, .gnaural and WAV, with the size a WAV would take', async () => {
    window.location.hash = '#/p/powernap';
    root.render(<App />);
    await flush();

    expect(root.byText('.button', 'Share link')).toBeDefined();
    expect(root.byText('.button', 'Export .gnaural')).toBeDefined();
    expect(root.byText('.button', 'Export WAV')).toBeDefined();
    // 20 minutes of 44.1 kHz stereo — large enough that the estimate is the point of showing it.
    expect(root.query('.export__estimate')?.textContent).toBe('≈ 202 MB');
  });

  it('halves the estimate at the lower sample rate, and remembers the choice', async () => {
    window.location.hash = '#/p/powernap';
    root.render(<App />);
    await flush();

    root.act(() => setSelectValue(root.query('.export__rate select') as HTMLSelectElement, '22050'));
    expect(root.query('.export__estimate')?.textContent).toBe('≈ 101 MB');

    // Remounting is the closest a test gets to a reload: the setting comes back from IndexedDB.
    await wait(WRITE_DEBOUNCE);
    root.remount(<App />);
    await flush();
    expect(root.query('.export__estimate')?.textContent).toBe('≈ 101 MB');
  });

  it('copies a share link to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', Object.create(navigator, { clipboard: { value: { writeText } } }));

    window.location.hash = '#/p/powernap';
    root.render(<App />);
    await flush();
    root.click(root.byText('.button', 'Share link'));
    await flush();

    expect(root.query('.export__notice')?.textContent).toBe('Link copied.');
    expect(writeText.mock.calls[0][0]).toContain('#/s/');
    vi.unstubAllGlobals();
  });
});

describe('share links', () => {
  it('plays a program carried entirely in the fragment', async () => {
    const schedule = parseSchedule(loadFixture('powernap.gnaural'));
    window.location.hash = `#/s/${await encodeSharePayload(schedule)}`;
    root.render(<App />);
    await flush();

    expect(root.query('.player__title')?.textContent).toBe('Power Nap');
    // Not in the library yet, so it offers to keep it — a bundled program does not.
    expect(root.byText('.button', 'Add to library')).toBeDefined();
  });

  it('saves a shared program to the library on request', async () => {
    const schedule = parseSchedule(loadFixture('powernap.gnaural'));
    window.location.hash = `#/s/${await encodeSharePayload(schedule)}`;
    root.render(<App />);
    await flush();

    root.click(root.byText('.button', 'Add to library'));
    await flush();

    expect(window.location.hash).toMatch(/^#\/i\//);
    expect(await listImported()).toHaveLength(1);
    // Now it is one of the user's own, so the offer is gone.
    expect(root.byText('.button', 'Add to library')).toBeUndefined();
  });

  it('reports a fragment that is not a readable program', async () => {
    window.location.hash = '#/s/bm90YXNjaGVkdWxl';
    root.render(<App />);
    await flush();

    expect(root.query('[role="alert"]')?.textContent).toContain('shared link');
    expect(root.queryAll('.program-card').length).toBeGreaterThan(0);
  });
});

describe('opening a file', () => {
  function drop(text: string, name = 'dropped.gnaural') {
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { files: [new File([text], name)] } });
    root.act(() => {
      root.query('.app')?.dispatchEvent(event);
    });
  }

  it('imports a dropped schedule and plays it', async () => {
    root.render(<App />);
    drop(loadFixture('powernap.gnaural'));
    await flush();

    expect(window.location.hash).toMatch(/^#\/i\//);
    expect(root.query('.player__title')?.textContent).toBe('Power Nap');
    // The byline names the file it arrived as, which the library metadata cannot supply.
    expect(root.query('.player__byline')?.textContent).toBe('dropped.gnaural');
  });

  it('keeps an imported program across a reload', async () => {
    root.render(<App />);
    drop(loadFixture('powernap.gnaural'));
    await flush();
    const hash = window.location.hash;

    root.remount(<App />);
    await flush();

    expect(window.location.hash).toBe(hash);
    expect(root.query('.player__title')?.textContent).toBe('Power Nap');
  });

  it('lists imported programs above the bundled ones, and removes them', async () => {
    root.render(<App />);
    drop(loadFixture('powernap.gnaural'), 'mine.gnaural');
    await flush();

    root.click(root.byText('.player__back', 'Library'));
    await flush();
    expect(root.text()).toContain('Imported');
    expect(root.queryAll('.program-card')).toHaveLength(PROGRAMS.length + 1);

    root.click(root.query('.library__remove'));
    await flush();
    expect(root.queryAll('.program-card')).toHaveLength(PROGRAMS.length);
    expect(await listImported()).toHaveLength(0);
  });

  it('does not import the same file twice', async () => {
    root.render(<App />);
    drop(loadFixture('powernap.gnaural'), 'first.gnaural');
    await flush();
    drop(loadFixture('powernap.gnaural'), 'second.gnaural');
    await flush();

    expect(await listImported()).toHaveLength(1);
  });

  it('reports a file it cannot read instead of throwing', async () => {
    root.render(<App />);
    drop('this is not a schedule', 'broken.gnaural');
    await flush();

    expect(root.query('[role="alert"]')?.textContent).toContain('broken.gnaural');
    // And stays on the library rather than half-loading a player.
    expect(root.queryAll('.program-card').length).toBeGreaterThan(0);
    expect(await listImported()).toHaveLength(0);
  });
});

describe('playback outside the player', () => {
  async function openAndPlay(hash = '#/p/powernap') {
    window.location.hash = hash;
    root.render(<App />);
    await flush();
    root.click(root.byText('.button--primary', 'Play'));
    await flush();
  }

  it('keeps playing when you go back to the library, and says what is playing', async () => {
    await openAndPlay();
    root.click(root.byText('.player__back', 'Library'));
    await flush();

    expect(root.queryAll('.program-card').length).toBeGreaterThan(0);
    expect(root.query('.now-playing__title')?.textContent).toBe('Power Nap');
    expect(root.byText('.now-playing .button--primary', 'Pause')).toBeDefined();
  });

  it('returns to the player from the now-playing bar', async () => {
    await openAndPlay();
    root.click(root.byText('.player__back', 'Library'));
    await flush();

    root.click(root.query('.now-playing__open'));
    await flush();

    expect(window.location.hash).toBe('#/p/powernap');
    expect(root.query('.player__title')?.textContent).toBe('Power Nap');
  });

  it('shows no bar for a program that was opened but never started', async () => {
    window.location.hash = '#/p/powernap';
    root.render(<App />);
    await flush();
    root.click(root.byText('.player__back', 'Library'));
    await flush();

    expect(root.query('.now-playing')).toBeNull();
  });

  it('stops from the bar', async () => {
    await openAndPlay();
    root.click(root.byText('.player__back', 'Library'));
    await flush();

    root.click(root.byText('.now-playing .button', 'Stop'));
    await flush();

    expect(root.query('.now-playing')).toBeNull();
  });
});

describe('media session', () => {
  it('publishes the program as lock-screen metadata', async () => {
    window.location.hash = '#/p/powernap';
    root.render(<App />);
    await flush();

    expect(mediaSession.metadata?.title).toBe('Power Nap');
    expect(mediaSession.metadata?.artist).toBe('Gnaural');
    expect(mediaSession.metadata?.album).toBe('Gnaural Web');
  });

  it('tracks playback state and drives the transport from its handlers', async () => {
    window.location.hash = '#/p/powernap';
    root.render(<App />);
    await flush();
    expect(mediaSession.playbackState).toBe('paused');

    root.act(() => mediaSession.handlers.get('play')?.({}));
    await flush();
    expect(mediaSession.playbackState).toBe('playing');
    expect(root.byText('.button--primary', 'Pause')).toBeDefined();

    root.act(() => mediaSession.handlers.get('pause')?.({}));
    await flush();
    expect(mediaSession.playbackState).toBe('paused');
  });

  it('seeks to an absolute position, and publishes it', async () => {
    window.location.hash = '#/p/powernap';
    root.render(<App />);
    await flush();

    root.act(() => mediaSession.handlers.get('seekto')?.({ seekTime: 600 }));
    await flush();

    expect(root.query('.timeline__times')?.textContent).toContain('10:00');
    expect(mediaSession.position?.position).toBeCloseTo(600, 0);
    expect(mediaSession.position?.duration).toBeCloseTo(1200, 0);
    // A zero rate is a TypeError in Chrome; `playbackState` is what stops the OS extrapolating.
    expect(mediaSession.position?.playbackRate).toBe(1);
    expect(mediaSession.playbackState).toBe('paused');
  });

  it('treats the skip actions as ±30s within the one program', async () => {
    window.location.hash = '#/p/powernap';
    root.render(<App />);
    await flush();

    root.act(() => mediaSession.handlers.get('seekto')?.({ seekTime: 600 }));
    root.act(() => mediaSession.handlers.get('nexttrack')?.({}));
    await flush();

    expect(root.query('.timeline__times')?.textContent).toContain('10:30');
  });

  it('publishes nothing while no program is loaded', async () => {
    // A sentinel, so this cannot pass just because the stub started empty.
    mediaSession.metadata = { title: 'left over' };
    mediaSession.playbackState = 'playing';

    root.render(<App />);
    await flush();

    expect(mediaSession.metadata).toBeNull();
    expect(mediaSession.playbackState).toBe('none');
  });

  it('keeps the metadata up while the library is on screen', async () => {
    window.location.hash = '#/p/powernap';
    root.render(<App />);
    await flush();
    root.click(root.byText('.button--primary', 'Play'));
    await flush();

    root.click(root.byText('.player__back', 'Library'));
    await flush();

    expect(mediaSession.metadata?.title).toBe('Power Nap');
    expect(mediaSession.playbackState).toBe('playing');
  });
});

describe('wake lock', () => {
  it('takes none by default, even while playing', async () => {
    window.location.hash = '#/p/powernap';
    root.render(<App />);
    await flush();
    root.click(root.byText('.button--primary', 'Play'));
    await flush();

    expect(wakeLocks).toHaveLength(0);
  });

  it('takes one while playing once enabled, and releases it on pause', async () => {
    window.location.hash = '#/p/powernap';
    root.render(<App />);
    await flush();

    root.act(() =>
      setCheckbox(root.query('.player__wake-lock input') as HTMLInputElement, true),
    );
    // Enabling it alone must not light the screen — only playing does.
    expect(wakeLocks).toHaveLength(0);

    root.click(root.byText('.button--primary', 'Play'));
    await flush();
    expect(wakeLocks).toHaveLength(1);
    expect(wakeLocks[0].released).toBe(false);

    root.click(root.byText('.button--primary', 'Pause'));
    await flush();
    expect(wakeLocks[0].released).toBe(true);
  });

  it('remembers the toggle', async () => {
    window.location.hash = '#/p/powernap';
    root.render(<App />);
    await flush();
    root.act(() =>
      setCheckbox(root.query('.player__wake-lock input') as HTMLInputElement, true),
    );
    await wait(WRITE_DEBOUNCE);

    root.remount(<App />);
    await flush();
    expect((root.query('.player__wake-lock input') as HTMLInputElement).checked).toBe(true);
  });
});

describe('settings', () => {
  it('remembers the master volume', async () => {
    window.location.hash = '#/p/powernap';
    root.render(<App />);
    await flush();

    const volume = root.query('.player__volume input') as HTMLInputElement;
    root.act(() => setInputValue(volume, '0.35'));
    await wait(WRITE_DEBOUNCE);

    root.remount(<App />);
    await flush();
    expect((root.query('.player__volume input') as HTMLInputElement).value).toBe('0.35');
  });
});

describe('the warning surface (§3.3, §3.4, §3.7)', () => {
  function drop(text: string, name = 'odd.gnaural') {
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { files: [new File([text], name)] } });
    root.act(() => {
      root.query('.app')?.dispatchEvent(event);
    });
  }

  /** A voice of the given type, long enough to be a plausible programme. */
  function voiceXml(type: number, description: string, duration: number): string {
    return `<voice><description>${description}</description><id>${type}</id><type>${type}</type>
      <entries><entry duration="${duration}" volume_left="1" volume_right="1" beatfreq="8" basefreq="200"/></entries>
    </voice>`;
  }

  it('says a voice type it cannot render will be silent, and still plays the rest', async () => {
    root.render(<App />);
    drop(`<?xml version="1.0"?><schedule><title>Mixed</title>
      ${voiceXml(0, 'tone', 600)}${voiceXml(3, 'pulse', 600)}</schedule>`);
    await flush();

    expect(root.query('.warnings__list[role="alert"]')?.textContent).toContain('does not render yet');
    // Something is still audible, so the transport stays live.
    expect((root.byText('.button', 'Play') as HTMLButtonElement).disabled).toBe(false);
  });

  it('refuses to offer Play for a schedule with nothing renderable in it', async () => {
    root.render(<App />);
    drop(`<?xml version="1.0"?><schedule><title>Silent</title>${voiceXml(5, 'drops', 600)}</schedule>`);
    await flush();

    expect(root.text()).toContain('would play silence');
    expect((root.byText('.button', 'Play') as HTMLButtonElement).disabled).toBe(true);
  });

  it("folds powernap's stale header away as a note rather than raising an alarm", async () => {
    window.location.hash = '#/p/powernap';
    root.render(<App />);
    await flush();

    // §3.4 tells the parser to ignore the declared counts, so this is transparency, not a fault.
    expect(root.query('.warnings__list[role="alert"]')).toBeNull();
    expect(root.query('.warnings__notices summary')?.textContent).toContain('2 notes');
    expect(root.text()).toContain('says it has 3 voices but contains 1');
  });

  it('shows nothing at all for an ordinary programme', async () => {
    window.location.hash = '#/p/airplanetravelaid';
    root.render(<App />);
    await flush();

    expect(root.query('.warnings')).toBeNull();
  });
});

describe('the headphone notice (§4.4, §5.1)', () => {
  it('appears on a first visit and stays dismissed on the next', async () => {
    root.render(<App />);
    await flush();

    expect(root.query('.headphones')).not.toBeNull();
    root.click(root.byText('.headphones .button', 'Got it'));
    expect(root.query('.headphones')).toBeNull();

    await wait(WRITE_DEBOUNCE);
    root.remount(<App />);
    await flush();
    expect(root.query('.headphones')).toBeNull();
  });

  it('waits for the stored answer rather than flashing the default', () => {
    // Rendered but not flushed: the IndexedDB read has not settled, so nothing is asserted yet
    // about whether this person has already dismissed it.
    root.render(<App />);

    expect(root.query('.headphones')).toBeNull();
  });

  it('says what the audio is, and makes no claim about what it does (§2)', async () => {
    root.render(<App />);
    await flush();

    const text = root.query('.headphones')?.textContent ?? '';
    expect(text).toContain('does not happen at all');
    expect(text).not.toMatch(/sleep better|cure|treat|anxiety|therapy/i);
  });
});

describe('the silent keepalive element', () => {
  function audio(): HTMLAudioElement | null {
    return document.querySelector('audio');
  }

  it('pauses with the player, so the notification has something left to resume', async () => {
    window.location.hash = '#/p/powernap';
    root.render(<App />);
    await flush();

    root.click(root.byText('.button', 'Play'));
    expect(audio()?.paused).toBe(false);

    // 8b left this running across a pause. That made the element look, to the platform, like media
    // that was still playing — so its notification's play button had nothing to do, fired no
    // `play` event, and reached the app not at all. Found on hardware.
    root.click(root.byText('.button', 'Pause'));
    expect(audio()?.paused).toBe(true);

    root.click(root.byText('.button', 'Play'));
    expect(audio()?.paused).toBe(false);
  });

  it('follows the element when the platform starts it, which is how the notification gets in', async () => {
    window.location.hash = '#/p/powernap';
    root.render(<App />);
    await flush();

    root.click(root.byText('.button', 'Play'));
    root.click(root.byText('.button', 'Pause'));
    expect(root.byText('.button', 'Play')).toBeDefined();

    // What Chrome does to the element when the notification's play button is pressed. The app has
    // to notice this directly: the MediaSession `play` action handler was never invoked.
    root.act(() => {
      audio()?.dispatchEvent(new Event('play'));
    });

    expect(root.byText('.button', 'Pause')).toBeDefined();
  });

  it('follows the element when the platform stops it', async () => {
    window.location.hash = '#/p/powernap';
    root.render(<App />);
    await flush();

    root.click(root.byText('.button', 'Play'));
    root.act(() => {
      audio()?.dispatchEvent(new Event('pause'));
    });

    expect(root.byText('.button', 'Play')).toBeDefined();
  });

  it('treats an echo of its own pause as nothing to do, rather than as a loop', async () => {
    window.location.hash = '#/p/powernap';
    root.render(<App />);
    await flush();

    root.click(root.byText('.button', 'Play'));
    root.click(root.byText('.button', 'Pause'));

    // `pause()` stops the element, which fires a `pause` event straight back. The guard is the
    // engine's own flag, set synchronously, so the return trip finds nothing to do.
    root.act(() => {
      audio()?.dispatchEvent(new Event('pause'));
    });

    expect(root.byText('.button', 'Play')).toBeDefined();
    // And a single press still resumes — the echo has not left anything in a half-state.
    root.click(root.byText('.button', 'Play'));
    expect(root.byText('.button', 'Pause')).toBeDefined();
  });
});
