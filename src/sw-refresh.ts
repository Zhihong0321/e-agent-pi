/**
 * A deploy replaces the precached bundle, but a page that is already open keeps the assets it
 * loaded — so the first visit after a deploy still renders the previous build. sw.js ships with
 * skipWaiting + clientsClaim, so a new worker takes control the moment it activates; reload on that
 * signal and the new build lands without anyone having to know to refresh twice.
 *
 * The reload waits while a turn is streaming: the agent keeps working server-side either way, but
 * reloading mid-turn would drop the live transcript the reader is watching.
 */
let busy = false;
let pending = false;

export function setTurnBusy(next: boolean) {
  busy = next;
  if (!busy && pending) window.location.reload();
}

export function watchForNewBuild() {
  if (!("serviceWorker" in navigator)) return;
  // No controller means this page was not served by a worker — a first install, nothing stale to swap.
  if (!navigator.serviceWorker.controller) return;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (busy) {
      pending = true;
      return;
    }
    window.location.reload();
  });
}
