// Filter Platform — browser screens: GeckoView data clearing.
//
// SettingsActivity has no GeckoRuntime (the runtime lives in
// BrowserActivity), so it cannot clear cookies / cache / site data
// itself. It only records WHAT to clear (a ClearFlags bitmask, in the
// result intent extra SettingsActivity.EXTRA_CLEAR_GECKO_FLAGS) and
// finishes; BrowserActivity reads that result and calls this helper.
//
// WIRING (BrowserActivity, reworked in parallel):
//   1. Start SettingsActivity with startActivityForResult (or the
//      Activity Result API) and a request code, e.g. REQUEST_SETTINGS.
//   2. In onActivityResult: if the request code matches and resultCode
//      == RESULT_OK, read
//        val flags = data?.getLongExtra(
//            SettingsActivity.EXTRA_CLEAR_GECKO_FLAGS, 0L) ?: 0L
//      and when flags != 0L call
//        BrowserDataCleaner.clearGeckoData(runtime, flags)
//      (runtime is BrowserActivity's GeckoRuntime). Optionally show the
//      Boolean result in the filter status line.
//   3. BrowserDataCleaner.clearGeckoData(runtime) with no flags clears
//      everything (ClearFlags.ALL).
//
// clearData() is ASYNCHRONOUS: it returns a GeckoResult<Void> that
// completes when the clear finishes. This helper only reports whether
// the clear was ISSUED without throwing (true) — not whether it has
// finished. BrowserActivity can attach its own .then { } listener to
// runtime.storageController.clearData(flags) if it needs completion.
package com.filterplatform.app

import org.mozilla.geckoview.GeckoRuntime
import org.mozilla.geckoview.StorageController

object BrowserDataCleaner {

    /** ClearFlags for Settings "Clear cookies and site data": cookies,
     *  site data (incl. local / session storage), DOM storages and auth
     *  sessions. Permissions and site settings are NOT cleared here —
     *  the user would have to re-grant them; use clearGeckoData(runtime)
     *  (ALL) for a full wipe. */
    val FLAGS_COOKIES_AND_SITE_DATA: Long =
        StorageController.ClearFlags.COOKIES or
            StorageController.ClearFlags.SITE_DATA or
            StorageController.ClearFlags.DOM_STORAGES or
            StorageController.ClearFlags.AUTH_SESSIONS

    /** ClearFlags for Settings "Clear cache": all caches (network +
     *  image). ALL_CACHES is the single flag covering both. */
    val FLAGS_CACHE: Long = StorageController.ClearFlags.ALL_CACHES

    /** Clear ALL Gecko data (cookies, cache, site data, permissions,
     *  site settings — ClearFlags.ALL). True when the clear was issued;
     *  false when even issuing it threw. */
    fun clearGeckoData(runtime: GeckoRuntime): Boolean =
        clearGeckoData(runtime, StorageController.ClearFlags.ALL)

    /** Clear the given ClearFlags bitmask from the runtime's storage
     *  controller. True when the clear was issued; false when issuing
     *  it threw. Completion is asynchronous — see the file header. */
    fun clearGeckoData(runtime: GeckoRuntime, flags: Long): Boolean {
        return try {
            runtime.storageController.clearData(flags)
            true
        } catch (_: Throwable) {
            false
        }
    }
}
