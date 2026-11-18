// Filter Platform — built-in WebExtension background script.
//
// Relay only. Content scripts cannot rely on `runtime.sendNativeMessage`
// being available in every GeckoView content-script context, so they talk
// to this background script with `runtime.sendMessage`, and this script
// forwards to the native app ("filter-platform" — the id Kotlin registers
// with WebExtension.setMessageDelegate) with `runtime.sendNativeMessage`
// and returns the native reply as the sendMessage response.
//
// The native reply is the decisions object built by FilterEngine
// (see FilterEngine.kt): {"type":"decisions","decisions":[{"id","verdict"}]}.
// If the native side is unreachable the promise rejects and the content
// script keeps everything covered (fail closed) and retries.
const NATIVE_APP = "filter-platform";

browser.runtime.onMessage.addListener((message) => {
  return browser.runtime.sendNativeMessage(NATIVE_APP, message);
});
