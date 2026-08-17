import { useRegisterSW } from 'virtual:pwa-register/react';
import './UpdatePrompt.css';

/**
 * Offers the new build once the service worker has one waiting.
 *
 * The registration is `prompt`, not `autoUpdate`: the programs are lazily imported chunks, and
 * `autoUpdate` can claim an open page whose precache no longer holds the chunk it's about to
 * request. Without a prompt, an installed PWA left open can serve a stale build indefinitely.
 * Dismissing here doesn't update — the worker keeps waiting and the offer returns next launch.
 */
export function UpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  if (!needRefresh) return null;

  return (
    <div className="update" role="status">
      <span className="update__text">A new version is ready.</span>
      <button type="button" className="button button--primary" onClick={() => void updateServiceWorker(true)}>
        Reload
      </button>
      <button type="button" className="button" onClick={() => setNeedRefresh(false)}>
        Later
      </button>
    </div>
  );
}
