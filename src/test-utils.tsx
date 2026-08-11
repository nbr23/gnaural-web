import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach } from 'vitest';

/**
 * Minimal React DOM test harness on happy-dom — no testing-library dependency, since everything
 * these tests need is `createRoot` plus `act`.
 */

export interface TestRoot {
  readonly container: HTMLDivElement;
  render(element: ReactNode): void;
  /** Throw the tree away and mount a fresh one — the closest a test gets to reloading the page. */
  remount(element: ReactNode): void;
  /** Run an interaction and flush the resulting renders. */
  act(action: () => void): void;
  click(element: Element | null | undefined): void;
  text(): string;
  query(selector: string): Element | null;
  queryAll(selector: string): Element[];
  /** First element whose text content matches, useful for finding a button by its label. */
  byText(selector: string, text: string): Element | undefined;
}

export function setupRoot(): TestRoot {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  return {
    get container() {
      return container;
    },
    render: (element) => act(() => root.render(element)),
    remount: (element) => {
      act(() => root.unmount());
      root = createRoot(container);
      act(() => root.render(element));
    },
    act: (action) => act(action),
    click: (element) => {
      act(() => {
        element?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
    },
    text: () => container.textContent ?? '',
    query: (selector) => container.querySelector(selector),
    queryAll: (selector) => [...container.querySelectorAll(selector)],
    byText: (selector, text) =>
      [...container.querySelectorAll(selector)].find((el) => el.textContent?.includes(text)),
  };
}

export interface HookResult<T> {
  /** What the hook returned on its most recent render. */
  readonly current: T;
  rerender(): void;
  unmount(): void;
}

/**
 * Mount a hook on its own, for the ones with no component of their own worth rendering.
 *
 * Self-contained rather than built on `setupRoot`, so a test can control when it unmounts — which
 * for anything holding a timer is the interesting moment.
 */
export function renderHook<T>(hook: () => T): HookResult<T> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);

  let value!: T;
  function Probe() {
    value = hook();
    return null;
  }

  act(() => root.render(<Probe />));

  return {
    get current() {
      return value;
    },
    rerender: () => act(() => root.render(<Probe />)),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/**
 * Set a controlled input's value the way a user would.
 *
 * Assigning `.value` directly also updates React's internal value tracker, so React concludes
 * nothing changed and never fires `onChange`. Going through the prototype's setter leaves the
 * tracker stale, which is what makes the subsequent event look like real input.
 */
export function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** The `setInputValue` trick, for a checkbox — where React derives `onChange` from `click`. */
export function setCheckbox(input: HTMLInputElement, checked: boolean): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
  setter?.call(input, checked);
  input.dispatchEvent(new Event('click', { bubbles: true }));
}

/** The `setInputValue` trick, for a `<select>`. */
export function setSelectValue(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  setter?.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * Flush pending async work — a lazily imported program, a file read, an IndexedDB query — and the
 * renders it causes. A dynamic import settles on a macrotask, so a microtask drain alone is not
 * enough, and a chain of them needs one turn each: fake-indexeddb spends a turn per request, and
 * `App` runs its library read, its settings read and a program load concurrently.
 */
export async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Let real time pass, for the debounce on a persisted setting. */
export async function wait(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}
