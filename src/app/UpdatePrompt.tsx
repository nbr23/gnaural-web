import { useRegisterSW } from 'virtual:pwa-register/react';
import './UpdatePrompt.css';

/**
 * Offers the new build once the service worker has one waiting.
 *
 * The registration is `prompt`, not `autoUpdate`, and deliberately so: the 19 programs are lazily
 * imported chunks, and `autoUpdate` claims an open page with a worker whose precache may no longer
 * hold the chunk that page is about to request — a 404 in the middle of a session. Waiting lets
 * the old worker keep serving one consistent build.
 *
 * The cost of that choice is what this component pays off. Without a prompt, a waiting worker
 * activates only once *every* client has closed, so an installed PWA left open can serve a stale
 * build indefinitely — which is not hypothetical here: it is what happened during the Android
 * crackling investigation, where a phone spent a debugging round-trip running the previous build
 * while apparently testing a fix.
 *
 * Dismissing does not update. The worker keeps waiting and the offer returns next launch, which is
 * the right behaviour for someone forty minutes into a sleep programme.
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
