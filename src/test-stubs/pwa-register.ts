/**
 * Stands in for `virtual:pwa-register/react` under Vitest.
 *
 * That module is synthesised by `vite-plugin-pwa` during a build and does not exist when the suite
 * runs, so `vite.config.ts` aliases it here for tests only. It reports no waiting worker, which is
 * the true state of a test run — there is no service worker at all — so `UpdatePrompt` renders
 * nothing and every other test is unaffected by its presence in the tree.
 */
export function useRegisterSW() {
  return {
    needRefresh: [false, () => {}] as [boolean, (value: boolean) => void],
    offlineReady: [false, () => {}] as [boolean, (value: boolean) => void],
    updateServiceWorker: async (_reload?: boolean) => {},
  };
}
