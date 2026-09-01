export function registerOfflineWorker(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) {
    return;
  }

  // Registration never sends SKIP_WAITING and therefore never reloads an open session.
  void navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => {
    // Offline capability is verified by acceptance tests; runtime failures stay local.
  });
}
