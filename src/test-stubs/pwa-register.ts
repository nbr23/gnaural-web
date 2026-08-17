/**
 * Stands in for `virtual:pwa-register/react` under Vitest: that module is synthesised by
 * `vite-plugin-pwa` during a build and doesn't exist when the suite runs, so `vite.config.ts`
 * aliases it here.
 */
export function useRegisterSW() {
  return {
    needRefresh: [false, () => {}] as [boolean, (value: boolean) => void],
    offlineReady: [false, () => {}] as [boolean, (value: boolean) => void],
    updateServiceWorker: async (_reload?: boolean) => {},
  };
}
