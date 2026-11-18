// Filter Platform — GeckoView browser prototype (OWN browser, OWN engine).
//
// Decision 2026-11-18 (Yakob): the browser base is GeckoView, STABLE
// release (not Nightly) — own Browser App + own Filtering Engine, using
// Mozilla Android Components where they help, NOT a ready-made foreign
// browser UI. Cromite is not the base (GPLv3); raw Chromium is backup only.
//
// This Activity is the prototype of that browser:
//   * OWN UI: address bar, back / forward / reload, loading indicator,
//     filter-status line. No Firefox UI, no third-party browser chrome.
//   * OWN filtering engine: every page load passes through FilterEngine
//     (navigation hook) and every visual element passes through the
//     built-in WebExtension + this native bridge (see below).
//   * GeckoView 160.0.20261116130455 (stable) renders the pages.
//
// Native bridge (WebExtension <-> Kotlin):
//   content script --sendMessage--> background.js
//   --sendNativeMessage("filter-platform")--> MessageDelegate.onMessage here.
//   The reply is the FilterEngine decisions JSON; the content script
//   applies it (allow / cover / block). If anything on this path fails,
//   the content script keeps everything covered — fail closed.
//
// Person detection hook: FilterEngine is constructed with a PersonDetector.
// This prototype ships StubPersonDetector (no model on device), so every
// finding comes back REVIEW and stays covered. Plugging in a real
// on-device model means implementing PersonDetector (one interface, one
// call site in FilterEngine.decide) — nothing here changes, and no verdict
// in this file is ever faked: there is no code path that returns ALLOW
// without a detector saying NO_PERSON above threshold.
//
// What is NOT verified here (no Android device/emulator exists on this VM):
// the Activity has never run. GeckoView startup, extension install,
// content-script injection, the native bridge round-trip and the cover
// behaviour on the 8 content types must be checked on a real device —
// see android/GECKOVIEW-PROTOTYPE.md for the exact checklist.
package com.filterplatform.app

import android.app.Activity
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import org.json.JSONObject
import org.mozilla.geckoview.AllowOrDeny
import org.mozilla.geckoview.GeckoResult
import org.mozilla.geckoview.GeckoRuntime
import org.mozilla.geckoview.GeckoRuntimeSettings
import org.mozilla.geckoview.GeckoSession
import org.mozilla.geckoview.WebExtension
import kotlin.concurrent.thread

class BrowserActivity : Activity() {

    companion object {
        /** The native-app id the extension addresses (must match
         *  background.js NATIVE_APP and the manifest's expectations). */
        const val NATIVE_APP_ID = "filter-platform"

        /** Built-in extension location: bundled in the APK under assets/. */
        const val EXTENSION_LOCATION = "resource://android/assets/filter-extension/"

        /** First page: the filter dashboard (own property, already live). */
        const val HOME_URL = "https://filter-platform-dashboard.pages.dev"
    }

    private lateinit var store: SecureStore
    private lateinit var engine: FilterEngine

    private lateinit var geckoView: org.mozilla.geckoview.GeckoView
    private lateinit var session: GeckoSession
    private lateinit var runtime: GeckoRuntime

    private lateinit var addressInput: EditText
    private lateinit var progressBar: ProgressBar
    private lateinit var filterStatusText: TextView
    private lateinit var backButton: Button
    private lateinit var forwardButton: Button

    // The device's server policy when registered; the fail-closed local
    // default otherwise (FilterEngine.DEFAULT_POLICY).
    @Volatile private var policy: Policy = FilterEngine.DEFAULT_POLICY
    // Hosts the server says are blocked (filled from the policy/blocklist
    // when registered; empty until then — navigation still goes through
    // FilterEngine.shouldBlockNavigation for scheme checks).
    @Volatile private var blockedHosts: Set<String> = emptySet()

    // Filter counters for the status line (updated on the UI thread).
    private var coveredCount = 0
    private var allowedCount = 0
    private var blockedCount = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = SecureStore(this)
        // HOOK: replace StubPersonDetector with a real on-device model here.
        // Until then every finding is REVIEW and stays covered.
        engine = FilterEngine(StubPersonDetector())
        setContentView(R.layout.activity_browser)

        addressInput = findViewById(R.id.addressInput)
        progressBar = findViewById(R.id.progressBar)
        filterStatusText = findViewById(R.id.filterStatusText)
        backButton = findViewById(R.id.backButton)
        forwardButton = findViewById(R.id.forwardButton)
        val container = findViewById<FrameLayout>(R.id.geckoContainer)

        findViewById<Button>(R.id.goButton).setOnClickListener { goToAddress() }
        findViewById<Button>(R.id.reloadButton).setOnClickListener { session.reload() }
        backButton.setOnClickListener { session.goBack() }
        forwardButton.setOnClickListener { session.goForward() }
        addressInput.setOnEditorActionListener { _, _, _ -> goToAddress(); true }

        // --- GeckoView runtime + session (own settings, no Firefox defaults) ---
        // 0.1.1: if the runtime fails to start, show the real error in the
        // status line instead of crashing the whole app — the user can
        // report it and the browser simply stays unusable until fixed.
        try {
            val settings = GeckoRuntimeSettings.Builder()
                .javaScriptEnabled(true)      // the filter itself needs JS
                .remoteDebuggingEnabled(false)
                .consoleOutput(false)
                .build()
            runtime = GeckoRuntime.create(this, settings)

            session = GeckoSession()
            session.setNavigationDelegate(navigationDelegate)
            session.setProgressDelegate(progressDelegate)
            session.setContentDelegate(contentDelegate)
            session.open(runtime)

            geckoView = org.mozilla.geckoview.GeckoView(this)
            geckoView.setSession(session)
            container.addView(
                geckoView,
                FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT
                )
            )

            installFilterExtension()
            loadPolicy()
            session.loadUri(HOME_URL)
            updateFilterStatus()
        } catch (e: Exception) {
            filterStatusText.text =
                "GeckoView failed to start: ${e.javaClass.simpleName}: ${e.message}"
        }
    }

    override fun onDestroy() {
        try { session.close() } catch (_: Exception) { /* already closed */ }
        super.onDestroy()
    }

    override fun onBackPressed() {
        // Back goes back in the browser first; only exits when there is no
        // page history. (canGoBack is tracked by the navigation delegate.)
        if (canGoBack) session.goBack() else super.onBackPressed()
    }

    // ------------------------------------------------------------ navigation

    @Volatile private var canGoBack = false
    @Volatile private var canGoForward = false

    private val navigationDelegate = object : GeckoSession.NavigationDelegate {
        override fun onLoadRequest(
            session: GeckoSession,
            request: GeckoSession.NavigationDelegate.LoadRequest
        ): GeckoResult<AllowOrDeny>? {
            // EVERY top-level navigation passes through the filter engine.
            return if (FilterEngine.shouldBlockNavigation(request.uri, blockedHosts)) {
                runOnUiThread {
                    filterStatusText.text =
                        "Blocked navigation: ${request.uri} (filter policy)"
                }
                GeckoResult.deny()
            } else {
                GeckoResult.allow()
            }
        }

        override fun onLocationChange(
            session: GeckoSession,
            url: String?,
            perms: List<GeckoSession.PermissionDelegate.ContentPermission>,
            hasUserGesture: Boolean
        ) {
            runOnUiThread {
                if (url != null) addressInput.setText(url)
            }
        }

        override fun onCanGoBack(session: GeckoSession, canGoBack: Boolean) {
            this@BrowserActivity.canGoBack = canGoBack
            runOnUiThread { backButton.isEnabled = canGoBack }
        }

        override fun onCanGoForward(session: GeckoSession, canGoForward: Boolean) {
            this@BrowserActivity.canGoForward = canGoForward
            runOnUiThread { forwardButton.isEnabled = canGoForward }
        }
    }

    private val progressDelegate = object : GeckoSession.ProgressDelegate {
        override fun onPageStart(session: GeckoSession, url: String) {
            runOnUiThread {
                progressBar.visibility = View.VISIBLE
                progressBar.progress = 0
                // New page: reset the counters; the content script reports
                // fresh findings for it.
                coveredCount = 0; allowedCount = 0; blockedCount = 0
                updateFilterStatus()
            }
        }

        override fun onProgressChange(session: GeckoSession, progress: Int) {
            runOnUiThread { progressBar.progress = progress }
        }

        override fun onPageStop(session: GeckoSession, success: Boolean) {
            runOnUiThread {
                progressBar.visibility = View.GONE
                progressBar.progress = 100
            }
        }
    }

    private val contentDelegate = object : GeckoSession.ContentDelegate {
        override fun onTitleChange(session: GeckoSession, title: String?) {
            // Shown in the status line only when there is no filter message.
            runOnUiThread { if (!title.isNullOrBlank()) titleText(title) }
        }
    }

    private fun titleText(title: String) {
        // Keep the window title informative without hiding filter state.
        setTitle("Filter Browser — $title")
    }

    private fun goToAddress() {
        var url = addressInput.text.toString().trim()
        if (url.isBlank()) return
        if (!url.contains("://")) url = "https://$url"
        session.loadUri(url)
    }

    // ------------------------------------------------- filter extension (bridge)

    private fun installFilterExtension() {
        runtime.webExtensionController.installBuiltIn(EXTENSION_LOCATION)
            .accept({ extension ->
                if (extension == null) {
                    runOnUiThread {
                        filterStatusText.text =
                            "FILTER EXTENSION FAILED TO INSTALL (null result): " +
                                "visual filtering is OFF — do not use this browser " +
                                "for unfiltered browsing."
                    }
                    return@accept
                }
                extension.setMessageDelegate(filterMessageDelegate, NATIVE_APP_ID)
                runOnUiThread {
                    filterStatusText.text = "Filter extension installed — covering unreviewed content."
                }
            }, { error ->
                // The browser still works, but WITHOUT the visual filter:
                // say so loudly instead of silently browsing unfiltered.
                runOnUiThread {
                    filterStatusText.text =
                        "FILTER EXTENSION FAILED TO INSTALL (${error?.message ?: "unknown error"}): " +
                            "visual filtering is OFF — do not use this browser " +
                            "for unfiltered browsing."
                }
            })
    }

    /**
     * The native bridge. The content script sends
     * {"type":"scan","pageUrl":"...","findings":[...]} and this returns the
     * FilterEngine decisions {"type":"decisions","decisions":[...]}.
     * Any message that is not a scan, or any failure parsing it, returns
     * null — the content script then keeps everything covered.
     */
    private val filterMessageDelegate = object : WebExtension.MessageDelegate {
        override fun onMessage(
            nativeApp: String,
            message: Any,
            sender: WebExtension.MessageSender
        ): GeckoResult<Any>? {
            val json = message as? JSONObject ?: return null
            val findings = try {
                FilterEngine.parseScanMessage(json)
            } catch (e: IllegalArgumentException) {
                // Malformed scan message: do NOT guess — reply nothing, the
                // content script keeps everything covered and retries.
                return null
            }
            val decisions = engine.decideAll(findings, policy)
            runOnUiThread {
                for (d in decisions) {
                    when (d.verdict) {
                        Verdict.ALLOW -> allowedCount++
                        Verdict.BLOCK -> blockedCount++
                        Verdict.COVER, Verdict.REVIEW -> coveredCount++
                    }
                }
                updateFilterStatus()
            }
            val reply = FilterEngine.buildDecisionsMessage(decisions)
            @Suppress("UNCHECKED_CAST")
            return GeckoResult.fromValue(reply) as GeckoResult<Any>
        }
    }

    private fun updateFilterStatus() {
        filterStatusText.text =
            "Filter: $coveredCount covered • $allowedCount allowed • $blockedCount blocked" +
                "  (policy: ${policy.name})"
    }

    // ------------------------------------------------------------- policy

    /** Load the device's server policy when registered; otherwise keep the
     *  fail-closed local default. Never fails the browser: on any error the
     *  default policy stays in force. */
    private fun loadPolicy() {
        val policyId = store.policyId
        if (policyId.isNullOrBlank() || store.deviceId.isNullOrBlank()) return
        thread {
            try {
                val p = ApiClient(store.baseUrl, store.apiToken).getPolicy(policyId)
                policy = p
                runOnUiThread { updateFilterStatus() }
            } catch (_: Exception) {
                // Offline / bad token: keep DEFAULT_POLICY (fail closed).
            }
        }
    }
}
