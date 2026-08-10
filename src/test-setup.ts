/**
 * Global test environment setup (registered as vitest `setupFiles`).
 *
 * happy-dom gives us a DOM but no layout engine and no React act signalling, so both are stubbed
 * here once rather than in every component test.
 */

/** React needs this to allow `await act(...)`, which is how async effects are flushed. */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Width a stubbed `ResizeObserver` reports — happy-dom lays nothing out, so `clientWidth` is 0. */
export const TEST_WIDTH = 640;

globalThis.ResizeObserver = class {
  constructor(private callback: ResizeObserverCallback) {}
  observe(target: Element) {
    this.callback([{ target, contentRect: { width: TEST_WIDTH } } as ResizeObserverEntry], this);
  }
  unobserve() {}
  disconnect() {}
};
