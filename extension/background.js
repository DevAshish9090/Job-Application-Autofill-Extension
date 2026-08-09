// AutoApply background service worker (MV3)
// Kept intentionally minimal for V1. Profile + application data live in
// chrome.storage.local and are read/written directly from the popup.

chrome.runtime.onInstalled.addListener(() => {
  console.log("AutoApply installed.");
});
