// The HTML shell is fetched from the network, but a previous service worker
// may still return old JavaScript and CSS. Reload once when the updated worker
// takes control so the shell and its assets belong to the same release.
if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker.getRegistration()
    .then((registration) => registration?.update())
    .catch(() => {});
}
