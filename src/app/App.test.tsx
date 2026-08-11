import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import App from '../App';
import { loadFixture } from '../document/test-fixtures';
import { PROGRAMS } from '../library/programs';
import { flush, setInputValue, setSelectValue, setupRoot } from '../test-utils';

const root = setupRoot();

beforeEach(() => {
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

  it('redirects the opened-file route when nothing has been opened this session', async () => {
    // The route depends on in-memory state, so a reload lands on it with nothing behind it.
    window.location.hash = '#/opened';
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

describe('export', () => {
  it('offers WAV and .gnaural export, with the size a WAV would take', async () => {
    window.location.hash = '#/p/powernap';
    root.render(<App />);
    await flush();

    expect(root.byText('.button', 'Export WAV')).toBeDefined();
    expect(root.byText('.button', 'Export .gnaural')).toBeDefined();
    // 20 minutes of 44.1 kHz stereo — large enough that the estimate is the point of showing it.
    expect(root.query('.export__estimate')?.textContent).toBe('≈ 202 MB');
  });

  it('halves the estimate at the lower sample rate', async () => {
    window.location.hash = '#/p/powernap';
    root.render(<App />);
    await flush();

    const select = root.query('.export__rate select') as HTMLSelectElement;
    root.act(() => setSelectValue(select, '22050'));

    expect(root.query('.export__estimate')?.textContent).toBe('≈ 101 MB');
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

  it('plays a dropped schedule and routes to the opened view', async () => {
    root.render(<App />);
    drop(loadFixture('powernap.gnaural'));
    await flush();

    expect(window.location.hash).toBe('#/opened');
    expect(root.query('.player__title')?.textContent).toBe('Power Nap');
    // The byline names the file, since an opened file has no library metadata behind it.
    expect(root.query('.player__byline')?.textContent).toBe('dropped.gnaural');
  });

  it('reports a file it cannot read instead of throwing', async () => {
    root.render(<App />);
    drop('this is not a schedule', 'broken.gnaural');
    await flush();

    expect(root.query('[role="alert"]')?.textContent).toContain('broken.gnaural');
    // And stays on the library rather than half-loading a player.
    expect(root.queryAll('.program-card').length).toBeGreaterThan(0);
  });
});
