import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { parseSchedule } from '../document/parser';
import { loadFixture } from '../document/test-fixtures';
import { DRAFT_SAVE_DEBOUNCE_MS } from '../editor/useDraft';
import { encodeSharePayload } from '../files/shareLink';
import { ANDROID_PACKAGE } from '../library/catalog';
import { PROGRAMS } from '../library/programs';
import { listDrafts, listImported } from '../library/storage';
import { TEST_WIDTH, mediaSession, resetDatabase, resetPlatform, wakeLocks } from '../test-setup';
import {
  flush,
  pointer,
  press,
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

/** Where the playhead is, from the timeline's own readout: `m:ss` of elapsed, then remaining. */
function elapsedSeconds(): number {
  const [minutes, seconds] = (root.query('.timeline__times')?.textContent ?? '')
    .split('−')[0]
    .split(':');
  return Number(minutes) * 60 + Number(seconds);
}

/** Close a `<details>` the way the element would, since happy-dom does not implement the summary. */
function fold(details: Element | null | undefined): void {
  root.act(() => {
    const element = details as HTMLDetailsElement;
    element.open = false;
    element.dispatchEvent(new Event('toggle'));
  });
}

describe('library view', () => {
  it('lists every bundled program, grouped by category', () => {
    root.render(<App />);

    expect(root.queryAll('.program-row')).toHaveLength(PROGRAMS.length);
    expect(root.text()).toContain('Contrib');
    expect(root.text()).toContain('Gnaural edits');
    expect(root.text()).toContain('OOBE');
  });

  it('shows which build it is running, on whatever view is open', async () => {
    root.render(<App />);
    const stamp = /^build \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

    expect(root.query('.app-footer__build')?.textContent).toMatch(stamp);

    window.location.hash = '#/p/powernap';
    await flush();

    expect(root.query('.app-footer__build')?.textContent).toMatch(stamp);
  });

  it('links to its own source from the footer', () => {
    root.render(<App />);
    const link = root.query('.app-footer__source') as HTMLAnchorElement | null;

    expect(link?.href).toBe('https://github.com/nbr23/gnaural-web');
    expect(link?.target).toBe('_blank');
    expect(link?.textContent).toBe('Fork on GitHub');
  });

  it('attributes the bundled descriptions to their authors rather than to the app', () => {
    root.render(<App />);

    const notes = root.queryAll('.library__note').map((note) => note.textContent ?? '');
    expect(notes.some((note) => note.includes("original authors' words"))).toBe(true);
    expect(notes.some((note) => note.includes('their words'))).toBe(true);
    const bold = root.queryAll('.library__note strong').map((clause) => clause.textContent ?? '');
    expect(bold.some((clause) => clause.includes("original authors' words"))).toBe(true);
  });

  it('credits each program on its card', () => {
    root.render(<App />);
    const card = root.byText('.program-row__open', 'Power Nap (Android)');

    expect(card?.textContent).toContain('Gnaural');
    expect(card?.textContent).toContain('20 min');
  });

  it('narrows the list and the jump rail to what is searched for', () => {
    root.render(<App />);
    root.act(() =>
      setInputValue(root.query('.library__search') as HTMLInputElement, 'schumann'),
    );

    expect(root.queryAll('.program-row')).toHaveLength(1);
    expect(root.text()).toContain('Schumann Resonance');
    expect(root.queryAll('.library__rail-link').map((link) => link.textContent)).toEqual([
      'binauralbeat1',
      'Meditation1',
    ]);
  });

  it('keeps a favourite across a reload, and lists it first', async () => {
    root.render(<App />);
    root.click(root.query('.program-row__star'));
    await wait(WRITE_DEBOUNCE);

    root.remount(<App />);
    await flush();

    expect(root.query('.library__section')?.textContent).toContain('Favourites');
    expect(root.queryAll('.program-row')).toHaveLength(PROGRAMS.length + 1);

    root.click(root.query('.program-row__star'));
    expect(root.query('.library__section')?.textContent).not.toContain('Favourites');
  });

  it('opens the top-level sections and folds the groups inside them', () => {
    root.render(<App />);

    const open = (element: Element) => (element as HTMLDetailsElement).open;
    expect(root.queryAll('.library__section--top').every(open)).toBe(true);
    expect(root.queryAll('.library__section--child').some(open)).toBe(false);
    expect(root.queryAll('.program-row')).toHaveLength(PROGRAMS.length);
  });

  it('remembers which sections were folded away', async () => {
    root.render(<App />);
    fold(root.byText('.library__category', ANDROID_PACKAGE)?.closest('details'));
    await wait(WRITE_DEBOUNCE);

    root.remount(<App />);
    await flush();

    expect(root.byText('.library__category', ANDROID_PACKAGE)?.closest('details')?.open).toBe(
      false,
    );
  });
});

describe('routing', () => {
  it('opens a program from the library and shows its player', async () => {
    root.render(<App />);
    root.click(root.byText('.program-row__open', 'Power Nap (Android)'));
    await flush();

    expect(window.location.hash).toBe('#/p/powernap');
    expect(root.query('.player__title')?.textContent).toBe('Power Nap');
    expect(root.queryAll('path.schedule-chart__series').length).toBeGreaterThan(0);
    expect(root.byText('.button', 'Play')).toBeDefined();
  });

  it('opens a program at the top of the page, not where the library was scrolled to', async () => {
    const scrollTo = vi.fn();
    Object.defineProperty(window, 'scrollTo', { configurable: true, value: scrollTo });

    root.render(<App />);
    root.click(root.byText('.program-row__open', 'Power Nap (Android)'));
    await flush();

    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it('returns to the library from the player', async () => {
    window.location.hash = '#/p/powernap';
    root.render(<App />);
    await flush();

    root.click(root.byText('.back-link', 'Library'));
    await flush();

    expect(root.queryAll('.program-row')).toHaveLength(PROGRAMS.length);
  });

  it('redirects an unknown program id back to the library', async () => {
    window.location.hash = '#/p/does-not-exist';
    root.render(<App />);
    await flush();

    expect(root.queryAll('.program-row').length).toBeGreaterThan(0);
  });

  it('redirects an imported id that is no longer stored', async () => {
    window.location.hash = '#/i/deleted-long-ago';
    root.render(<App />);
    await flush();

    expect(root.queryAll('.program-row').length).toBeGreaterThan(0);
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

  /** The plot is a picture, not a control: the timeline above is what moves the playhead, and a
   *  pointer anywhere on the chart leaves it exactly where it was. */
  it('does not move the playhead from the chart', async () => {
    window.location.hash = '#/p/powernap';
    root.render(<App />);
    await flush();

    const svg = root.query('.player__chart svg') as SVGSVGElement;
    stubRect(svg, TEST_WIDTH, 200);
    pointer(svg, 'pointerdown', { x: TEST_WIDTH / 2, y: 100 });
    pointer(svg, 'pointermove', { x: TEST_WIDTH / 2 + 60, y: 100 });
    pointer(svg, 'pointerup', { x: TEST_WIDTH / 2 + 60, y: 100 });

    expect(elapsedSeconds()).toBe(0);
  });
});

describe('keyboard shortcuts', () => {
  it('plays and pauses with the space bar, from anywhere', async () => {
    window.location.hash = '#/p/powernap';
    root.render(<App />);
    await flush();

    press(' ');
    await flush();
    expect(root.byText('.button--primary', 'Pause')).toBeDefined();

    press(' ');
    await flush();
    expect(root.byText('.button--primary', 'Play')).toBeDefined();
  });

  it('seeks with the arrows', async () => {
    window.location.hash = '#/p/powernap';
    root.render(<App />);
    await flush();

    press('ArrowRight');
    press('ArrowRight');
    expect(root.query('.timeline__times')?.textContent).toContain('1:00');

    press('ArrowLeft');
    expect(root.query('.timeline__times')?.textContent).toContain('0:30');
  });

  it('leaves the keys alone inside a field, and on a focused button', async () => {
    window.location.hash = '#/p/powernap';
    root.render(<App />);
    await flush();

    press(' ', root.query('.export__rate select') as Element);
    press(' ', root.byText('.button', 'Stop') as Element);
    await flush();

    expect(root.byText('.button--primary', 'Play')).toBeDefined();
  });

  it('goes back to the library with escape, without stopping what is playing', async () => {
    window.location.hash = '#/p/powernap';
    root.render(<App />);
    await flush();

    press(' ');
    await flush();

    press('Escape');
    await flush();

    expect(window.location.hash).toBe('#/');
    expect(root.queryAll('.program-row').length).toBeGreaterThan(0);
    expect(root.query('.now-playing')).toBeDefined();

    press('Escape');
    await flush();
    expect(window.location.hash).toBe('#/');
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
    expect(root.query('.export__estimate')?.textContent).toBe('≈ 202 MB');
  });

  it('halves the estimate at the lower sample rate, and remembers the choice', async () => {
    window.location.hash = '#/p/powernap';
    root.render(<App />);
    await flush();

    root.act(() => setSelectValue(root.query('.export__rate select') as HTMLSelectElement, '22050'));
    expect(root.query('.export__estimate')?.textContent).toBe('≈ 101 MB');

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
    expect(root.byText('.button', 'Add to library')).toBeUndefined();
  });

  it('reports a fragment that is not a readable program', async () => {
    window.location.hash = '#/s/bm90YXNjaGVkdWxl';
    root.render(<App />);
    await flush();

    expect(root.query('[role="alert"]')?.textContent).toContain('shared link');
    expect(root.queryAll('.program-row').length).toBeGreaterThan(0);
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
    expect(root.queryAll('.program-row')).toHaveLength(PROGRAMS.length + 1);

    root.click(root.query('.library__remove'));
    root.click(root.byText('.program-row__action', 'Remove'));
    await flush();
    expect(root.queryAll('.program-row')).toHaveLength(PROGRAMS.length);
    expect(await listImported()).toHaveLength(0);
  });

  it('changes its mind about removing an imported program', async () => {
    root.render(<App />);
    drop(loadFixture('powernap.gnaural'), 'mine.gnaural');
    await flush();
    root.click(root.byText('.back-link', 'Library'));
    await flush();

    root.click(root.query('.library__remove'));
    root.click(root.byText('.program-row__action', 'Keep'));
    await flush();

    expect(await listImported()).toHaveLength(1);
    expect(root.queryAll('.program-row')).toHaveLength(PROGRAMS.length + 1);
  });

  it('says where a program came from, so a file and a session are told apart', async () => {
    root.render(<App />);
    drop(loadFixture('powernap.gnaural'), 'mine.gnaural');
    await flush();
    root.click(root.byText('.back-link', 'Library'));
    await flush();

    const badges = new Set(root.queryAll('.program-row__badge').map((tag) => tag.textContent));
    expect(badges).toContain('Imported');
    expect(badges).toContain('Sleep');
    expect(badges).not.toContain('Android');
    expect(root.query('.program-row--imported')).not.toBeNull();
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
    expect(root.queryAll('.program-row').length).toBeGreaterThan(0);
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

    expect(root.queryAll('.program-row').length).toBeGreaterThan(0);
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

describe('playing from the library', () => {
  /** The row for a program, found by the title it shows. */
  function row(title: string): Element {
    const found = root
      .queryAll('.program-row')
      .find((candidate) => candidate.querySelector('.program-row__title')?.textContent === title);
    if (!found) throw new Error(`no library row for ${title}`);
    return found;
  }

  /** Press a row's transport, by what it is offering — which is half the assertion. */
  function pressRow(title: string, action: 'Play' | 'Pause' | 'Stop'): void {
    const button = row(title).querySelector(`[aria-label="${action} ${title}"]`);
    if (!button) throw new Error(`${title} offers no ${action}`);
    root.click(button);
  }

  async function play(title = 'Power Nap (Android)'): Promise<void> {
    root.render(<App />);
    await flush();
    pressRow(title, 'Play');
    await flush();
  }

  it('starts a program from its row, and hands it to the player when the row is opened', async () => {
    await play();

    expect(root.queryAll('.program-row')).toHaveLength(PROGRAMS.length);
    expect(root.query('.player__title')).toBeNull();
    expect(root.query('.now-playing__title')?.textContent).toBe('Power Nap');
    expect(mediaSession.metadata?.title).toBe('Power Nap');
    expect(row('Power Nap (Android)').className).toContain('is-active');

    root.click(row('Power Nap (Android)').querySelector('.program-row__open'));
    await flush();

    expect(window.location.hash).toBe('#/p/powernap');
    expect(root.byText('.button--primary', 'Pause')).toBeDefined();
  });

  it('pauses, resumes and stops from the row', async () => {
    await play();

    pressRow('Power Nap (Android)', 'Pause');
    await flush();
    expect(mediaSession.playbackState).toBe('paused');

    pressRow('Power Nap (Android)', 'Play');
    await flush();
    expect(mediaSession.playbackState).toBe('playing');

    pressRow('Power Nap (Android)', 'Stop');
    await flush();
    expect(root.query('.now-playing')).toBeNull();
    expect(root.query('.program-row.is-active')).toBeNull();
  });

  it('replaces what is playing when a second row is started', async () => {
    await play();

    pressRow('Schumann Resonance', 'Play');
    await flush(60);

    expect(root.queryAll('.program-row.is-active')).toHaveLength(1);
    expect(row('Schumann Resonance').className).toContain('is-active');
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
    window.location.hash = '#/p/sleep-smr';
    await flush();

    expect((root.query('.noise__level input') as HTMLInputElement).value).toBe('0.3');
    expect((root.query('.noise__colour select') as HTMLSelectElement).value).toBe('brown');
  });
});

describe('live mode', () => {
  it('opens from the library and has sliders instead of a timeline', async () => {
    root.render(<App />);
    root.click(root.byText('.button', 'Live'));
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

    expect(mediaSession.metadata?.title).toBe('Live');

    root.click(root.byText('.back-link', 'Library'));
    await flush();
    expect(root.query('.now-playing__title')?.textContent).toBe('Live');
    expect(root.query('.now-playing__time')?.textContent).not.toContain('/');

    root.click(root.query('.now-playing__open'));
    await flush();
    expect(window.location.hash).toBe('#/live');
  });

  it('keeps playing through a slider move, rather than reloading the graph', async () => {
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

    expect(root.query('.readout')?.textContent).toContain('40.00 Hz');
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

    expect(window.location.hash).toBe(`#/i/${saved.id}`);
    expect(root.query('.player__title')?.textContent).toContain('Hz beat at');
    expect(root.query('.export')).not.toBeNull();
  });
});

describe('the editor', () => {
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

  it('starts a blank draft from the library', async () => {
    root.render(<App />);
    root.click(root.byText('.button', 'New program'));
    await flush();

    expect(window.location.hash).toMatch(/^#\/e\/.+/);
    expect(root.query('.editor__title')?.textContent).toBe('New program');
    expect(root.queryAll('.voice-rows__row')).toHaveLength(1);
    expect(root.query('.timeline__times')?.textContent).toContain('20:00');
    expect(await listDrafts()).toHaveLength(1);
  });

  it('forks a program into a draft rather than editing it in place', async () => {
    await openDraftOf();

    expect(window.location.hash).toMatch(/^#\/e\/.+/);
    expect(root.query('.editor__title')?.textContent).toBe('Power Nap');

    const [draft] = await listDrafts();
    expect(draft.sourceName).toBe('Power Nap');
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
    expect(parseSchedule(draft.xml).title).toBe('Saved by itself');

    window.location.hash = '';
    root.remount(<App />);
    await flush();
    expect(root.byText('.program-row__open', 'Saved by itself')).toBeDefined();
    expect(root.text()).toContain('Drafts');
  });

  it('keeps playing through an edit, rather than reloading the graph', async () => {
    await openDraftOf();
    root.click(root.byText('.button--primary', 'Play'));
    await flush();

    const swap = root
      .byText('.editor__check', 'Swap left and right')
      ?.querySelector('input') as HTMLInputElement;
    root.act(() => setCheckbox(swap, true));
    type('Volume left', '0.5');
    await wait(200);

    expect(root.byText('.button--primary', 'Pause')).toBeDefined();
  });

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

  it('mutes a voice a structural edit added', async () => {
    await openDraftOf();
    root.click(root.byText('button', 'Add noise voice'));
    await flush();

    const added = () => root.queryAll('.voice-rows__row')[1];
    const mute = () =>
      [...added().querySelectorAll('button')].find((b) => b.textContent?.startsWith('Mute')) ??
      [...added().querySelectorAll('button')].find((b) => b.textContent?.startsWith('Unmute'));

    root.click(mute());
    await flush();

    expect(root.queryAll('.voice-rows__row')).toHaveLength(2);
    expect(mute()?.getAttribute('aria-pressed')).toBe('true');
    expect(added().className).toContain('voice-rows__row--silent');
  });

  it('saves a draft to the library by the same path an import takes', async () => {
    await openDraftOf();
    type('Title', 'Ready to share');
    root.click(root.byText('.button', 'Save to library'));
    await flush();

    const [saved] = await listImported();
    expect(saved.title).toBe('Ready to share');
    expect(window.location.hash).toBe(`#/i/${saved.id}`);
    expect(root.query('.export')).not.toBeNull();
    expect(await listDrafts()).toHaveLength(1);
  });

  it('discards a draft from the editor', async () => {
    await openDraftOf();
    root.click(root.byText('.button', 'Discard draft'));
    root.click(root.byText('.button', 'Discard for good'));
    await flush();

    expect(await listDrafts()).toHaveLength(0);
    expect(root.queryAll('.program-row').length).toBe(PROGRAMS.length);
  });

  it('redirects a draft id that is no longer stored', async () => {
    window.location.hash = '#/e/deleted-long-ago';
    root.render(<App />);
    await flush();

    expect(root.queryAll('.program-row').length).toBeGreaterThan(0);
  });

  it('opens and closes the volume lanes', async () => {
    await openDraftOf();

    const laneToggle = (label: string) =>
      root.byText('.editor__lanes .editor__chip', label) as HTMLButtonElement;

    expect(root.text()).not.toContain('Volume left (');
    expect(laneToggle('Volume L').getAttribute('aria-pressed')).toBe('false');

    root.click(laneToggle('Volume L'));
    expect(root.queryAll('.schedule-chart__lane-title').map((t) => t.textContent)).toEqual([
      'Beat frequency (Hz)',
      'Base frequency (Hz)',
      'Volume left',
    ]);

    root.click(laneToggle('Beat'));
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

    expect(root.text()).toContain('Node 3 of 12');
    expect(root.byText('.button', 'Undo')?.hasAttribute('disabled')).toBe(true);

    type('Beat (Hz)', '17.5');
    expect(field('Beat (Hz)').value).toBe('17.5');
    expect(root.byText('.button', 'Undo')?.textContent).toContain('change beat frequency');

    root.click(root.byText('.button', 'Undo'));
    expect(root.text()).toContain('Node 3 of 12');
  });

  it('deselects without moving the playhead when a tap lands on empty plot', async () => {
    await openDraftOf();

    const svg = root.query('.editor__chart svg') as SVGSVGElement;
    stubRect(svg, TEST_WIDTH, 262);
    const marker = root.queryAll('circle.schedule-chart__node')[2];
    const x = Number(marker.getAttribute('cx'));
    const y = Number(marker.getAttribute('cy'));

    pointer(svg, 'pointerdown', { x, y });
    pointer(svg, 'pointerup', { x, y });
    expect(root.text()).toContain('Node 3 of 12');

    pointer(svg, 'pointerdown', { x: x + 60, y: y + 40 });
    pointer(svg, 'pointerup', { x: x + 60, y: y + 40 });

    expect(root.text()).toContain('Tap a node on the chart');
    expect(elapsedSeconds()).toBe(0);
  });

  it('validates a committed edit, marks the node, and blocks nothing', async () => {
    await openDraftOf();

    const svg = root.query('.editor__chart svg') as SVGSVGElement;
    stubRect(svg, TEST_WIDTH, 262);
    expect(root.query('.validation')).toBeNull();

    const marker = root.queryAll('circle.schedule-chart__node')[2];
    const at = { x: Number(marker.getAttribute('cx')), y: Number(marker.getAttribute('cy')) };
    pointer(svg, 'pointerdown', at);
    pointer(svg, 'pointerup', at);

    type('Volume left', '2.5');

    expect(root.query('.validation [role="alert"]')?.textContent).toContain('outside 0–1');
    expect(root.queryAll('circle.schedule-chart__mark').length).toBeGreaterThan(0);
    expect(root.byText('.button', 'Save to library')?.hasAttribute('disabled')).toBe(false);

    root.click(root.byText('.button', 'Undo change node volume'));
    expect(root.query('.validation')).toBeNull();
    expect(root.queryAll('circle.schedule-chart__mark')).toHaveLength(0);
  });

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

    expect(root.byText('.button--primary', 'Pause')).toBeDefined();
    expect(root.byText('.button', 'Undo')?.textContent).toContain('move node');
    root.click(root.byText('.button', 'Undo'));
    expect(root.byText('.button', 'Undo')?.hasAttribute('disabled')).toBe(true);
  });

  it('generates a voice while playing, without reloading the graph', async () => {
    await openDraftOf();
    root.click(root.byText('.button--primary', 'Play'));
    await flush();

    expect(root.queryAll('.voice-rows__row')).toHaveLength(1);

    root.click(root.byText('.authoring button', 'Generate'));
    await wait(200);

    expect(root.queryAll('.voice-rows__row')).toHaveLength(2);
    expect(root.byText('.button--primary', 'Pause')).toBeDefined();
    expect(root.text()).toContain('Ramp');
    expect(root.text()).not.toContain('not the same length');

    root.click(root.byText('.button', 'Undo generate voice'));
    await wait(200);
    expect(root.queryAll('.voice-rows__row')).toHaveLength(1);
    expect(root.byText('.button--primary', 'Pause')).toBeDefined();
  });

  it('duplicates a voice while playing, and the copy does not merge back on reopen', async () => {
    await openDraftOf();
    root.click(root.byText('.button--primary', 'Play'));
    await flush();

    root.click(root.byText('.authoring button', 'Duplicate'));
    await wait(200);

    expect(root.queryAll('.voice-rows__row')).toHaveLength(2);
    expect(root.byText('.button--primary', 'Pause')).toBeDefined();
    expect(root.text()).not.toContain('merge into one voice');
  });

  it('scales the whole program to a target length', async () => {
    await openDraftOf();

    const target = root
      .queryAll('.authoring .editor__field span')
      .find((node) => node.textContent === 'Target length (s)')
      ?.parentElement?.querySelector('input') as HTMLInputElement;
    root.act(() => setInputValue(target, '600'));
    root.click(root.byText('button', 'Scale program'));
    await wait(200);

    expect(root.byText('.button', 'Undo')?.textContent).toContain('scale program');
    expect(root.text()).toContain('Now 10:00');
  });

  it('pads a ragged schedule to its longest voice, from the warning that reports it', async () => {
    await openDraftOf();

    root.click(root.byText('button', 'Add tone voice'));
    await wait(200);
    expect(root.text()).not.toContain('not the same length');

    type('Duration (s)', '400');
    await wait(200);
    expect(root.text()).toContain('not the same length');

    root.click(root.byText('.validation__fix', 'Pad to longest'));
    await wait(200);

    expect(root.text()).not.toContain('not the same length');
    expect(root.byText('.validation__fix', 'Pad to longest')).toBeUndefined();
    expect(root.byText('.button', 'Undo')?.textContent).toContain('pad voices');
    expect(root.text()).toContain('20:00');
  });

  it('marquees a group of nodes, moves them together, and undoes it in one step', async () => {
    await openDraftOf();

    const svg = root.query('.editor__chart svg') as SVGSVGElement;
    stubRect(svg, TEST_WIDTH, 262);
    const markers = root.queryAll('circle.schedule-chart__node');
    const at = (index: number) => ({
      x: Number(markers[index].getAttribute('cx')),
      y: Number(markers[index].getAttribute('cy')),
    });

    pointer(svg, 'pointerdown', { x: at(0).x - 10, y: 2 });
    pointer(svg, 'pointermove', { x: at(2).x + 4, y: 250 });
    pointer(svg, 'pointerup', { x: at(2).x + 4, y: 250 });

    expect(root.text()).toContain('3 nodes in 1 voice');
    expect(root.text()).not.toContain('Tap a node on the chart');

    const before = root.queryAll('circle.schedule-chart__node').map((n) => n.getAttribute('cx'));
    root.act(() =>
      setInputValue(root.query('.group-panel input[type="number"]') as HTMLInputElement, '30'),
    );
    root.click(root.byText('button', 'Later →'));
    await wait(200);

    expect(root.byText('.button', 'Undo')?.textContent).toContain('move nodes');
    const after = root.queryAll('circle.schedule-chart__node').map((n) => n.getAttribute('cx'));
    expect(after).not.toEqual(before);

    root.click(root.byText('.button', 'Undo'));
    expect(root.queryAll('circle.schedule-chart__node').map((n) => n.getAttribute('cx'))).toEqual(
      before,
    );
    expect(root.text()).toContain('3 nodes in 1 voice');
  });

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

    const max = root.query('input[aria-label="Beat maximum"]') as HTMLInputElement;
    expect(Number(max.value)).toBeLessThan(30);
    root.act(() => setInputValue(max, '40'));
    expect((root.query('input[aria-label="Beat maximum"]') as HTMLInputElement).value).toBe('40');
  });
});

describe('the app-level noise layer', () => {
  it('is off until someone turns it on', async () => {
    window.location.hash = '#/p/powernap';
    root.render(<App />);
    await flush();

    expect((root.query('.noise__level input') as HTMLInputElement).value).toBe('0');
    expect(root.query('.noise')?.textContent).toContain('Off');
  });

  it('offers the WAV the bed once there is one, unticked, where the choice is otherwise invisible', async () => {
    window.location.hash = '#/p/powernap';
    root.render(<App />);
    await flush();

    expect(root.query('.export__include')).toBeNull();

    root.act(() => setInputValue(root.query('.noise__level input') as HTMLInputElement, '0.3'));

    const include = root.query('.export__include input') as HTMLInputElement;
    expect(include.checked).toBe(false);
    expect(root.query('.export__include')?.textContent).toContain('Include background noise');
    expect(root.query('.export__include')?.textContent).toContain('program as authored');

    root.act(() => setCheckbox(include, true));
    expect((root.query('.export__include input') as HTMLInputElement).checked).toBe(true);
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

  /** Several bundled programs carry a noise voice of their own, named "Background noise" just like
   *  the app's layer. The panel has to say which is which, and be able to silence theirs. */
  it('names the program’s own bed of noise, and mutes it on request', async () => {
    window.location.hash = '#/p/hypnosis-self-hypnosis';
    root.render(<App />);
    await flush();

    const panel = root.query('.noise__own-bed');
    expect(panel?.textContent).toContain('has a bed of its own');
    expect(panel?.textContent).toContain('Background noise');

    const mute = root.byText('.noise__own-bed .button', 'Mute the program’s own') as HTMLElement;
    root.act(() => mute.click());
    await flush();

    expect(root.query('.noise__own-bed')?.textContent).toContain('Unmute the program’s own');
    // The same session gate the voice list draws, so the voice reads as silent there too.
    expect(root.queryAll('.voice-list__row--silent')).toHaveLength(1);
  });

  it('says nothing about an own bed for a program without one', async () => {
    window.location.hash = '#/p/powernap';
    root.render(<App />);
    await flush();

    expect(root.query('.noise__own-bed')).toBeNull();
  });
});

describe('the warning surface', () => {
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
      ${voiceXml(0, 'tone', 600)}${voiceXml(9, 'mystery', 600)}</schedule>`);
    await flush();

    expect(root.query('.warnings__list[role="alert"]')?.textContent).toContain('does not render yet');
    expect((root.byText('.button', 'Play') as HTMLButtonElement).disabled).toBe(false);
  });

  it('treats an isochronic programme as an ordinary one', async () => {
    root.render(<App />);
    drop(`<?xml version="1.0"?><schedule><title>Pulses</title>
      ${voiceXml(3, 'pulse', 600)}${voiceXml(4, 'alt', 600)}</schedule>`);
    await flush();

    expect(root.query('.warnings')).toBeNull();
    expect((root.byText('.button', 'Play') as HTMLButtonElement).disabled).toBe(false);
    expect(root.text()).toContain('isochronic (alternating)');
    expect(root.text()).not.toContain('not yet rendered');
  });

  it('treats a water programme as an ordinary one', async () => {
    root.render(<App />);
    drop(`<?xml version="1.0"?><schedule><title>Weather</title>
      ${voiceXml(5, 'drops', 600)}${voiceXml(6, 'rain', 600)}</schedule>`);
    await flush();

    expect(root.query('.warnings')).toBeNull();
    expect((root.byText('.button', 'Play') as HTMLButtonElement).disabled).toBe(false);
    expect(root.text()).toContain('water drops');
    expect(root.text()).toContain('rain');
    expect(root.text()).not.toContain('not yet rendered');
  });

  it('refuses to offer Play for a schedule with nothing renderable in it', async () => {
    root.render(<App />);
    drop(`<?xml version="1.0"?><schedule><title>Silent</title>${voiceXml(9, 'mystery', 600)}</schedule>`);
    await flush();

    expect(root.text()).toContain('would play silence');
    expect((root.byText('.button', 'Play') as HTMLButtonElement).disabled).toBe(true);
  });

  it("folds powernap's stale header away as a note rather than raising an alarm", async () => {
    window.location.hash = '#/p/powernap';
    root.render(<App />);
    await flush();

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

describe('the headphone notice', () => {
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
    root.render(<App />);

    expect(root.query('.headphones')).toBeNull();
  });

  it('says what the audio is, and makes no claim about what it does', async () => {
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

    // Regression guard: if this element stays running across a pause, the platform still thinks
    // media is playing, so the lock-screen play button fires no `play` event (found on hardware).
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

    // What Chrome does to the element when the lock-screen play button is pressed, bypassing the
    // MediaSession `play` action handler entirely.
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

    root.act(() => {
      audio()?.dispatchEvent(new Event('pause'));
    });

    expect(root.byText('.button', 'Play')).toBeDefined();
    root.click(root.byText('.button', 'Play'));
    expect(root.byText('.button', 'Pause')).toBeDefined();
  });
});
