import { IDBFactory } from 'fake-indexeddb';
import 'fake-indexeddb/auto';
import { AudioBuffer, OfflineAudioContext } from 'node-web-audio-api';
import { resetConnection } from './library/storage';

/**
 * Global test environment setup (registered as vitest `setupFiles`).
 *
 * happy-dom gives us a DOM but no layout engine, no React act signalling, and none of the
 * platform APIs step 8 builds on, so all of them are stubbed here once rather than in every test.
 */

/** React needs this to allow `await act(...)`, which is how async effects are flushed. */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A database with nothing in it, plus a storage module that has forgotten the old one.
 *
 * happy-dom ships no IndexedDB at all, so `fake-indexeddb/auto` supplies it; a fresh `IDBFactory`
 * is how it is emptied between tests. Call this in a `beforeEach` for anything that persists.
 */
export function resetDatabase(): void {
  globalThis.indexedDB = new IDBFactory();
  resetConnection();
}

/**
 * Web Audio, so pressing Play in a component test builds a real graph instead of throwing.
 *
 * An `OfflineAudioContext` standing in for `AudioContext`: it is the same W3C implementation
 * `engine.test.ts` renders through, needs no audio device, and — because its clock only advances
 * during `startRendering()` — leaves `currentTime` at zero, which is exactly what a test that
 * never waits for real time wants. `AudioBuffer` is global for `keepalive.ts`, which constructs
 * one directly rather than borrowing a context.
 */
const TEST_CONTEXT_SECONDS = 600;

globalThis.AudioBuffer = AudioBuffer as unknown as typeof globalThis.AudioBuffer;
globalThis.AudioContext = class extends OfflineAudioContext {
  constructor() {
    super(2, 44100 * TEST_CONTEXT_SECONDS, 44100);
  }
} as unknown as typeof globalThis.AudioContext;

/**
 * `navigator.mediaSession` and `navigator.wakeLock`, neither of which happy-dom has.
 *
 * Recording stubs rather than spies: what the tests care about is the state the OS would be shown
 * and the handlers it would be able to invoke, so the stub keeps both and lets a test call a
 * handler the way a lock-screen button would.
 */
export interface TestMediaSession {
  metadata: { title?: string; artist?: string; album?: string } | null;
  playbackState: string;
  position: { duration: number; position: number; playbackRate: number } | null;
  handlers: Map<string, (details: { seekTime?: number; seekOffset?: number }) => void>;
  setActionHandler(action: string, handler: ((details: never) => void) | null): void;
  setPositionState(state: { duration: number; position: number; playbackRate: number }): void;
}

export const mediaSession: TestMediaSession = {
  metadata: null,
  playbackState: 'none',
  position: null,
  handlers: new Map(),
  setActionHandler(action, handler) {
    if (handler) this.handlers.set(action, handler as never);
    else this.handlers.delete(action);
  },
  setPositionState(state) {
    // Chrome enforces this and the spec requires it; a stub that shrugged at a zero rate let a
    // real "playbackRate cannot be equal to zero" crash through to a browser.
    if (state.playbackRate === 0) throw new TypeError('playbackRate cannot be equal to zero');
    this.position = state;
  },
};

/** Screen wake locks taken so far, and whether each is still held. */
export const wakeLocks: { released: boolean }[] = [];

export function resetPlatform(): void {
  mediaSession.metadata = null;
  mediaSession.playbackState = 'none';
  mediaSession.position = null;
  mediaSession.handlers.clear();
  wakeLocks.length = 0;
  media.coarsePointer = false;
}

/**
 * What `matchMedia` answers, since happy-dom lays nothing out and evaluates no queries.
 *
 * `(pointer: coarse)` is the one that changes behaviour rather than styling — it is what takes the
 * seek gesture off the chart — so a test can set it and get the phone's answer. Everything else
 * reads false, which is the desktop-shaped default the views are written against.
 */
export const media = { coarsePointer: false };

Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  value: (query: string) => ({
    matches: query.includes('pointer: coarse') ? media.coarsePointer : false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }),
});

globalThis.MediaMetadata = class {
  constructor(init: { title?: string; artist?: string; album?: string }) {
    Object.assign(this, init);
  }
} as unknown as typeof globalThis.MediaMetadata;

Object.defineProperty(navigator, 'mediaSession', { value: mediaSession, configurable: true });
Object.defineProperty(navigator, 'wakeLock', {
  configurable: true,
  value: {
    request: async () => {
      const sentinel = {
        released: false,
        addEventListener() {},
        removeEventListener() {},
        async release() {
          sentinel.released = true;
        },
      };
      wakeLocks.push(sentinel);
      return sentinel;
    },
  },
});

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
