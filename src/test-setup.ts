import { IDBFactory } from 'fake-indexeddb';
import 'fake-indexeddb/auto';
import { AudioBuffer, OfflineAudioContext } from 'node-web-audio-api';
import { resetConnection } from './library/storage';

/**
 * Global test environment setup (registered as vitest `setupFiles`). happy-dom gives us a DOM but
 * no layout engine, no React act signalling, and none of the platform APIs the app builds on, so
 * they're stubbed here once rather than in every test.
 */

/** React needs this to allow `await act(...)`, which is how async effects are flushed. */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A database with nothing in it, plus a storage module that has forgotten the old one. happy-dom
 * ships no IndexedDB, so `fake-indexeddb/auto` supplies it; a fresh `IDBFactory` empties it between
 * tests.
 */
export function resetDatabase(): void {
  globalThis.indexedDB = new IDBFactory();
  resetConnection();
}

/**
 * Web Audio, so pressing Play in a component test builds a real graph instead of throwing. An
 * `OfflineAudioContext` stands in for `AudioContext`: its clock only advances during
 * `startRendering()`, leaving `currentTime` at zero, which is what a test that never waits for
 * real time wants.
 */
const TEST_CONTEXT_SECONDS = 600;

globalThis.AudioBuffer = AudioBuffer as unknown as typeof globalThis.AudioBuffer;
globalThis.AudioContext = class extends OfflineAudioContext {
  constructor() {
    super(2, 44100 * TEST_CONTEXT_SECONDS, 44100);
  }
} as unknown as typeof globalThis.AudioContext;

/**
 * `navigator.mediaSession` and `navigator.wakeLock`, neither of which happy-dom has. Recording
 * stubs rather than spies, so a test can call a handler the way a lock-screen button would.
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
    // Chrome enforces this and the spec requires it.
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
}

/**
 * What `matchMedia` answers, since happy-dom lays nothing out and evaluates no queries. Every query
 * is a miss: the layout queries only change styling and the chart's height prop, and nothing else
 * asks.
 */
Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  value: (query: string) => ({
    matches: false,
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
