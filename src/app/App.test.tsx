import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { parseSchedule } from '../document/parser';
import { loadFixture } from '../document/test-fixtures';
import { DRAFT_SAVE_DEBOUNCE_MS } from '../editor/useDraft';
import { encodeSharePayload } from '../files/shareLink';
import { PROGRAMS } from '../library/programs';
import { listDrafts, listImported } from '../library/storage';
import { TEST_WIDTH, mediaSession, resetDatabase, resetPlatform, wakeLocks } from '../test-setup';
import {
  flush,
  pointer,
  setCheckbox,
  setInputValue,
  setSelectValue,
  setupRoot,
  stubRect,
  wait,
} from '../test-utils';

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

    root.click(root.byText('.back-link', 'Library'));
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

    root.click(root.byText('.back-link', 'Library'));
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
    root.click(root.byText('.back-link', 'Library'));
    await flush();

    expect(root.queryAll('.program-card').length).toBeGreaterThan(0);
    expect(root.query('.now-playing__title')?.textContent).toBe('Power Nap');
    expect(root.byText('.now-playing .button--primary', 'Pause')).toBeDefined();
  });

  it('returns to the player from the now-playing bar', async () => {
    await openAndPlay();
    root.click(root.byText('.back-link', 'Library'));
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
    root.click(root.byText('.back-link', 'Library'));
    await flush();

    expect(root.query('.now-playing')).toBeNull();
  });

  it('stops from the bar', async () => {
    await openAndPlay();
    root.click(root.byText('.back-link', 'Library'));
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

    root.click(root.byText('.back-link', 'Library'));
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
      setCheckbox(root.query('.wake-lock input') as HTMLInputElement, true),
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
      setCheckbox(root.query('.wake-lock input') as HTMLInputElement, true),
    );
    await wait(WRITE_DEBOUNCE);

    root.remount(<App />);
    await flush();
    expect((root.query('.wake-lock input') as HTMLInputElement).checked).toBe(true);
  });
});

describe('settings', () => {
  it('remembers the master volume', async () => {
    window.location.hash = '#/p/powernap';
    root.render(<App />);
    await flush();

    const volume = root.query('.volume input') as HTMLInputElement;
    root.act(() => setInputValue(volume, '0.35'));
    await wait(WRITE_DEBOUNCE);

    root.remount(<App />);
    await flush();
    expect((root.query('.volume input') as HTMLInputElement).value).toBe('0.35');
  });

  it('remembers the noise layer, which belongs to the listener rather than to a program', async () => {
    window.location.hash = '#/p/powernap';
    root.render(<App />);
    await flush();

    root.act(() => setInputValue(root.query('.noise__level input') as HTMLInputElement, '0.3'));
    root.act(() => setSelectValue(root.query('.noise__colour select') as HTMLSelectElement, 'brown'));
    await wait(WRITE_DEBOUNCE);

    root.remount(<App />);
    await flush();
    // Not per-program: it is a preference about listening, so it carries to the next one.
    window.location.hash = '#/p/sleep-smr';
    await flush();

    expect((root.query('.noise__level input') as HTMLInputElement).value).toBe('0.3');
    expect((root.query('.noise__colour select') as HTMLSelectElement).value).toBe('brown');
  });
});

describe('live mode (§6.1)', () => {
  it('opens from the library and has sliders instead of a timeline', async () => {
    root.render(<App />);
    root.click(root.query('.library__live'));
    await flush();

    expect(window.location.hash).toBe('#/live');
    expect(root.query('.live__title')?.textContent).toBe('Live');
    expect(root.queryAll('.live__slider input')).toHaveLength(2);
    expect(root.query('.schedule-chart')).toBeNull();
  });

  it('plays, and says what is playing from the library', async () => {
    window.location.hash = '#/live';
    root.render(<App />);
    await flush();

    root.click(root.byText('.button--primary', 'Play'));
    await flush();

    // A program with no title of its own still has to be nameable on a lock screen.
    expect(mediaSession.metadata?.title).toBe('Live');

    root.click(root.byText('.back-link', 'Library'));
    await flush();
    expect(root.query('.now-playing__title')?.textContent).toBe('Live');
    // No total: the twelve-hour container is true and tells a listener nothing.
    expect(root.query('.now-playing__time')?.textContent).not.toContain('/');

    root.click(root.query('.now-playing__open'));
    await flush();
    expect(window.location.hash).toBe('#/live');
  });

  it('keeps playing through a slider move, rather than reloading the graph', async () => {
    // `load()` is a teardown: it silences everything and returns to zero, and `usePlayer` would
    // report not-playing again. An edit has to go through `update()` instead, which is the whole
    // reason step 1 exists — and a slider bound to the schedule *prop* would quietly do the wrong
    // one on every pixel of a drag.
    window.location.hash = '#/live';
    root.render(<App />);
    await flush();
    root.click(root.byText('.button--primary', 'Play'));
    await flush();

    const base = root.queryAll('.live__slider input')[0] as HTMLInputElement;
    root.act(() => setInputValue(base, '0.4'));
    root.act(() => setInputValue(base, '0.5'));
    await wait(200);

    expect(root.byText('.button--primary', 'Pause')).toBeDefined();
  });

  it('remembers where the sliders were left', async () => {
    window.location.hash = '#/live';
    root.render(<App />);
    await flush();

    const base = root.queryAll('.live__slider input')[0] as HTMLInputElement;
    root.act(() => setInputValue(base, '0'));
    await wait(WRITE_DEBOUNCE);

    root.remount(<App />);
    await flush();

    expect(root.query('.readout')?.textContent).toContain('40 Hz');
  });

  it('keeps a session as a program, by the same path an import takes', async () => {
    window.location.hash = '#/live';
    root.render(<App />);
    await flush();

    root.act(() => setInputValue(root.query('.live__field input') as HTMLInputElement, '5'));
    root.click(root.byText('.button', 'Keep'));
    await flush();

    const [saved] = await listImported();
    expect(saved.durationSeconds).toBe(300);
    expect(saved.sourceName).toBe('Live session');

    // It lands in the library as an ordinary program: routed to, playable, exportable, shareable.
    expect(window.location.hash).toBe(`#/i/${saved.id}`);
    expect(root.query('.player__title')?.textContent).toContain('Hz beat at');
    expect(root.query('.export')).not.toBeNull();
  });
});

describe('the editor (§6.1)', () => {
  /** Fork the bundled Power Nap into a draft and land in the editor. */
  async function openDraftOf(program = 'powernap') {
    window.location.hash = `#/p/${program}`;
    root.render(<App />);
    await flush();
    root.click(root.byText('.button', 'Edit a copy'));
    await flush();
  }

  function field(label: string): HTMLInputElement {
    const found = [...root.queryAll('.editor__field')].find((element) =>
      element.textContent?.startsWith(label),
    );
    return found?.querySelector('input, textarea') as HTMLInputElement;
  }

  function type(label: string, value: string): void {
    const input = field(label);
    root.act(() => setInputValue(input, value));
    root.blur(input);
  }

  it('forks a program into a draft rather than editing it in place', async () => {
    await openDraftOf();

    expect(window.location.hash).toMatch(/^#\/e\/.+/);
    expect(root.query('.editor__title')?.textContent).toBe('Power Nap');

    const [draft] = await listDrafts();
    expect(draft.sourceName).toBe('Power Nap');
    // The bundled program is untouched: a copy is the only thing the editor ever opens.
    expect(await listImported()).toHaveLength(0);
  });

  it('commits an edit once the field is left, and undoes it', async () => {
    await openDraftOf();

    type('Title', 'Nap, renamed');
    expect(root.query('.editor__title')?.textContent).toBe('Nap, renamed');

    root.click(root.byText('.button', 'Undo'));
    expect(root.query('.editor__title')?.textContent).toBe('Power Nap');
    expect(field('Title').value).toBe('Power Nap');

    root.click(root.byText('.button', 'Redo'));
    expect(root.query('.editor__title')?.textContent).toBe('Nap, renamed');
  });

  it('has nothing to undo before the first edit', async () => {
    await openDraftOf();

    expect(root.byText('.button', 'Undo')?.hasAttribute('disabled')).toBe(true);
    expect(root.byText('.button', 'Redo')?.hasAttribute('disabled')).toBe(true);
  });

  it('autosaves, so the draft survives leaving the page', async () => {
    await openDraftOf();
    type('Title', 'Saved by itself');
    await wait(DRAFT_SAVE_DEBOUNCE_MS * 2);
    await flush();

    const [draft] = await listDrafts();
    expect(draft.title).toBe('Saved by itself');
    // XML, not a blob of the model: what is recovered is exportable and openable in Gnaural.
    expect(parseSchedule(draft.xml).title).toBe('Saved by itself');

    // Reopening the app at the library — the closest a test gets to a reload — finds it under
    // Drafts, with the title it was last given rather than the one it was forked with.
    window.location.hash = '';
    root.remount(<App />);
    await flush();
    expect(root.byText('.program-card', 'Saved by itself')).toBeDefined();
    expect(root.text()).toContain('Drafts');
  });

  it('keeps playing through an edit, rather than reloading the graph', async () => {
    // The same invariant Live mode's slider test pins, now with a second caller of `update()`:
    // `load()` is a teardown, and an editor that pushed documents in through the `schedule` prop
    // would silence and rewind the program on every commit.
    await openDraftOf();
    root.click(root.byText('.button--primary', 'Play'));
    await flush();

    // By label, not by position: the lane toggles are `.editor__check` too, and now come first.
    const swap = root
      .byText('.editor__check', 'Swap left and right')
      ?.querySelector('input') as HTMLInputElement;
    root.act(() => setCheckbox(swap, true));
    type('Volume left', '0.5');
    await wait(200);

    expect(root.byText('.button--primary', 'Pause')).toBeDefined();
  });

  /**
   * The same invariant again, against the edits that change the *shape* of the graph — adding a
   * voice is `update()`'s crossfade path, which until step 6 had no caller at all.
   */
  it('keeps playing through a structural edit, and undoes it', async () => {
    await openDraftOf();
    root.click(root.byText('.button--primary', 'Play'));
    await flush();

    expect(root.queryAll('.voice-rows__row')).toHaveLength(1);

    root.click(root.byText('button', 'Add noise voice'));
    await wait(200);
    expect(root.queryAll('.voice-rows__row')).toHaveLength(2);
    expect(root.byText('.button--primary', 'Pause')).toBeDefined();

    root.click(root.byText('.button', 'Undo add voice'));
    await wait(200);
    expect(root.queryAll('.voice-rows__row')).toHaveLength(1);
    expect(root.byText('.button--primary', 'Pause')).toBeDefined();
  });

  /**
   * The gates are derived per voice, and the editor deliberately never re-hands `usePlayer` its
   * `schedule` prop — so anything reading that prop for a voice count is reading the document as it
   * was when the draft opened, not as it is.
   */
  it('keeps a solo on the voice a structural edit added', async () => {
    await openDraftOf();
    root.click(root.byText('button', 'Add noise voice'));
    await flush();

    const rows = root.queryAll('.voice-rows__row');
    expect(rows).toHaveLength(2);

    const solo = [...rows[1].querySelectorAll('button')].find((b) => b.textContent === 'Solo');
    root.click(solo);
    await flush();

    expect(root.queryAll('.voice-rows__row')).toHaveLength(2);
    const after = root.queryAll('.voice-rows__row')[1].querySelectorAll('button');
    expect([...after].find((b) => b.textContent === 'Solo')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('saves a draft to the library by the same path an import takes', async () => {
    await openDraftOf();
    type('Title', 'Ready to share');
    root.click(root.byText('.button', 'Save to library'));
    await flush();

    const [saved] = await listImported();
    expect(saved.title).toBe('Ready to share');
    expect(window.location.hash).toBe(`#/i/${saved.id}`);
    // An ordinary program from here on: playable, exportable, shareable.
    expect(root.query('.export')).not.toBeNull();
    // And the draft is still there to keep working on.
    expect(await listDrafts()).toHaveLength(1);
  });

  it('discards a draft from the editor', async () => {
    await openDraftOf();
    root.click(root.byText('.button', 'Discard draft'));
    await flush();

    expect(await listDrafts()).toHaveLength(0);
    expect(root.queryAll('.program-card').length).toBe(PROGRAMS.length);
  });

  it('redirects a draft id that is no longer stored', async () => {
    window.location.hash = '#/e/deleted-long-ago';
    root.render(<App />);
    await flush();

    expect(root.queryAll('.program-card').length).toBeGreaterThan(0);
  });

  /**
   * §6.1 asks for four independently collapsible lanes. Collapsing could not wait for step 8's zoom
   * work: the chart divides its height between the lanes it is given, so four inside the read-only
   * 280 px would leave about 44 px of plot each.
   */
  it('opens and closes the volume lanes', async () => {
    await openDraftOf();

    const laneToggle = (label: string) =>
      root.byText('.editor__lanes .editor__check', label)?.querySelector('input') as HTMLInputElement;

    expect(root.text()).not.toContain('Volume left (');
    expect(laneToggle('Volume L').checked).toBe(false);

    root.act(() => setCheckbox(laneToggle('Volume L'), true));
    expect(root.queryAll('.schedule-chart__lane-title').map((t) => t.textContent)).toEqual([
      'Beat frequency (Hz)',
      'Base frequency (Hz)',
      'Volume left',
    ]);

    root.act(() => setCheckbox(laneToggle('Beat'), false));
    expect(root.queryAll('.schedule-chart__lane-title').map((t) => t.textContent)).toEqual([
      'Base frequency (Hz)',
      'Volume left',
    ]);
  });

  it('selects a node from the chart and edits it to an exact value', async () => {
    await openDraftOf();

    const svg = root.query('.editor__chart svg') as SVGSVGElement;
    stubRect(svg, TEST_WIDTH, 262);
    expect(root.text()).toContain('Tap a node on the chart');

    const marker = root.queryAll('circle.schedule-chart__node')[2];
    pointer(svg, 'pointerdown', {
      x: Number(marker.getAttribute('cx')),
      y: Number(marker.getAttribute('cy')),
    });
    pointer(svg, 'pointerup', {
      x: Number(marker.getAttribute('cx')),
      y: Number(marker.getAttribute('cy')),
    });

    // A tap is a selection and nothing else: no move, so no commit.
    expect(root.text()).toContain('Node 3 of 12');
    expect(root.byText('.button', 'Undo')?.hasAttribute('disabled')).toBe(true);

    // §6.1's reason for the panel: a drag cannot reach every value, and typing can.
    type('Beat (Hz)', '17.5');
    expect(field('Beat (Hz)').value).toBe('17.5');
    expect(root.byText('.button', 'Undo')?.textContent).toContain('change beat frequency');

    root.click(root.byText('.button', 'Undo'));
    // Undo restores the selection the commit was made with, so the obvious next action works.
    expect(root.text()).toContain('Node 3 of 12');
  });

  /**
   * §6.1's inline validation, end to end: an edit that is legal in the format and wrong for a
   * person raises a row under the chart, a mark on the node it happened at, and no obstacle of any
   * kind — §6.1 says warnings, not hard errors, so Save goes on working.
   */
  it('validates a committed edit, marks the node, and blocks nothing', async () => {
    await openDraftOf();

    const svg = root.query('.editor__chart svg') as SVGSVGElement;
    stubRect(svg, TEST_WIDTH, 262);
    expect(root.query('.validation')).toBeNull();

    const marker = root.queryAll('circle.schedule-chart__node')[2];
    const at = { x: Number(marker.getAttribute('cx')), y: Number(marker.getAttribute('cy')) };
    pointer(svg, 'pointerdown', at);
    pointer(svg, 'pointerup', at);

    // Step 5 left volumes unclamped on purpose, so that this has something to point at.
    type('Volume left', '2.5');

    expect(root.query('.validation [role="alert"]')?.textContent).toContain('outside 0–1');
    expect(root.queryAll('circle.schedule-chart__mark').length).toBeGreaterThan(0);
    expect(root.byText('.button', 'Save to library')?.hasAttribute('disabled')).toBe(false);

    root.click(root.byText('.button', 'Undo change node volume'));
    expect(root.query('.validation')).toBeNull();
    expect(root.queryAll('circle.schedule-chart__mark')).toHaveLength(0);
  });

  /**
   * A schedule with no voices is an allowed state (step 6), not a refusal — but it is silence, and
   * the player already disables Play for it. The editor now says the same thing in the same words.
   */
  it('disables Play once the last voice is gone, and says why', async () => {
    await openDraftOf();

    const del = [...root.queryAll('.voice-rows__row button')].find((b) => b.textContent === 'Delete');
    root.click(del);

    expect(root.queryAll('.voice-rows__row')).toHaveLength(0);
    expect(root.query('.validation [role="alert"]')?.textContent).toContain('nothing to play');
    expect(root.byText('.button--primary', 'Play')?.hasAttribute('disabled')).toBe(true);
  });

  it('drags a node and keeps playing, without reloading the graph', async () => {
    await openDraftOf();
    root.click(root.byText('.button--primary', 'Play'));
    await flush();

    const svg = root.query('.editor__chart svg') as SVGSVGElement;
    stubRect(svg, TEST_WIDTH, 262);
    const marker = root.queryAll('circle.schedule-chart__node')[3];
    const at = { x: Number(marker.getAttribute('cx')), y: Number(marker.getAttribute('cy')) };

    pointer(svg, 'pointerdown', at);
    pointer(svg, 'pointermove', { x: at.x + 12, y: at.y - 18 });
    pointer(svg, 'pointermove', { x: at.x + 24, y: at.y - 30 });
    pointer(svg, 'pointerup', { x: at.x + 24, y: at.y - 30 });
    await wait(200);

    // The third caller of `player.update`, honouring the same invariant Live mode's test pins:
    // the `schedule` prop keeps its identity, so `load()` — a teardown — never runs.
    expect(root.byText('.button--primary', 'Pause')).toBeDefined();
    expect(root.byText('.button', 'Undo')?.textContent).toContain('move node');
    // One commit for the whole gesture, not one per move.
    root.click(root.byText('.button', 'Undo'));
    expect(root.byText('.button', 'Undo')?.hasAttribute('disabled')).toBe(true);
  });

  /**
   * §6.1's marquee, group move and group undo, end to end — and the point of the whole step: the
   * densest bundled voice puts 26 of its 44 node gaps inside the 12 px hit radius, so selecting a
   * region and operating on it is how a real document is edited, not tapping one node at a time.
   */
  it('marquees a group of nodes, moves them together, and undoes it in one step', async () => {
    await openDraftOf();

    const svg = root.query('.editor__chart svg') as SVGSVGElement;
    stubRect(svg, TEST_WIDTH, 262);
    const markers = root.queryAll('circle.schedule-chart__node');
    const at = (index: number) => ({
      x: Number(markers[index].getAttribute('cx')),
      y: Number(markers[index].getAttribute('cy')),
    });

    // A box from empty space above the curve, down and across the first three nodes.
    pointer(svg, 'pointerdown', { x: at(0).x - 10, y: 2 });
    pointer(svg, 'pointermove', { x: at(2).x + 4, y: 250 });
    pointer(svg, 'pointerup', { x: at(2).x + 4, y: 250 });

    // The group panel replaces the exact-values panel, because exact values need one node.
    expect(root.text()).toContain('3 nodes in 1 voice');
    expect(root.text()).not.toContain('Tap a node on the chart');

    const before = root.queryAll('circle.schedule-chart__node').map((n) => n.getAttribute('cx'));
    root.act(() =>
      setInputValue(root.query('.editor__fields input[type="number"]') as HTMLInputElement, '30'),
    );
    root.click(root.byText('button', 'Later →'));
    await wait(200);

    expect(root.byText('.button', 'Undo')?.textContent).toContain('move nodes');
    const after = root.queryAll('circle.schedule-chart__node').map((n) => n.getAttribute('cx'));
    expect(after).not.toEqual(before);

    // One commit for the group, and the selection it was made with comes back with the undo.
    root.click(root.byText('.button', 'Undo'));
    expect(root.queryAll('circle.schedule-chart__node').map((n) => n.getAttribute('cx'))).toEqual(
      before,
    );
    expect(root.text()).toContain('3 nodes in 1 voice');
  });

  /** §6.1's zoom, and the manual axis override that lands with it. */
  it('zooms the time axis and overrides a lane range', async () => {
    await openDraftOf();

    const zoom = (label: string) => root.byText('.editor__view button', label) as HTMLButtonElement;
    expect(root.query('.editor__zoom')?.textContent).toBe('1.0×');
    expect(root.query('input.editor__pan')).toBeNull();

    root.click(zoom('+'));
    expect(root.query('.editor__zoom')?.textContent).toBe('2.0×');
    expect(root.query('input.editor__pan')).not.toBeNull();

    root.click(zoom('Fit'));
    expect(root.query('.editor__zoom')?.textContent).toBe('1.0×');

    // The axis override: a lane fitted to its data cannot be dragged past it, and this is the way
    // out that step 5 recorded as owed to step 8.
    const max = root.query('input[aria-label="Beat maximum"]') as HTMLInputElement;
    expect(Number(max.value)).toBeLessThan(30);
    root.act(() => setInputValue(max, '40'));
    expect((root.query('input[aria-label="Beat maximum"]') as HTMLInputElement).value).toBe('40');
  });
});

describe('the app-level noise layer (§4.5b)', () => {
  it('is off until someone turns it on (§3.8 item 6)', async () => {
    window.location.hash = '#/p/powernap';
    root.render(<App />);
    await flush();

    expect((root.query('.noise__level input') as HTMLInputElement).value).toBe('0');
    expect(root.query('.noise')?.textContent).toContain('Off');
  });

  it('says it is not exported, where the omission would otherwise surprise', async () => {
    window.location.hash = '#/p/powernap';
    root.render(<App />);
    await flush();

    expect(root.query('.export')?.textContent).not.toContain('background noise layer');

    root.act(() => setInputValue(root.query('.noise__level input') as HTMLInputElement, '0.3'));

    expect(root.query('.export')?.textContent).toContain('background noise layer is not included');
  });

  it('points the four presets that lost their ambient bed at it, and nothing else', async () => {
    window.location.hash = '#/p/meditation-unity';
    root.render(<App />);
    await flush();
    expect(root.query('.noise')?.textContent).toContain('originally had an ambient background');

    window.location.hash = '#/p/powernap';
    await flush();
    expect(root.query('.noise')?.textContent).not.toContain('originally had an ambient background');
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
