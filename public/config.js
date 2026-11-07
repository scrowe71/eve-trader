// Paste the Client ID from https://developers.eveonline.com here.
// The Callback URL in your EVE app must be exactly CALLBACK_URL below,
// for example https://eve-trader.pages.dev/
window.APP_CONFIG = {
  CLIENT_ID: "d2d220b6f3734981ae7fdceeb8bcfde7",
  CALLBACK_URL: location.origin + "/",
  // Your watcher Worker (delivery alerts, cloud copies, daily summary).
  WATCHER_URL: "https://eve-trader-watcher.scrowe71.workers.dev",
};
