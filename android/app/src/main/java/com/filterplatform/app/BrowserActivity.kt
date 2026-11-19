// Filter Platform — GeckoView browser prototype (OWN browser, OWN engine).
//
// Decision 2026-11-18 (Yakob): the browser base is GeckoView, STABLE
// release (not Nightly) — own Browser App + own Filtering Engine, using
// Mozilla Android Components where they help, NOT a ready-made foreign
// browser UI. Cromite is not the base (GPLv3); raw Chromium is backup only.
//
// This Activity is the multi-tab browser:
//   * OWN UI, built programmatically in Kotlin (no new XML layouts —
//     build.sh only compiles activity_main.xml, activity_browser.xml
//     and strings.xml): a tab strip (+ new tab, tab overview), an
//     omnibox with suggestions, back / forward / reload / stop / home,
//     a find-in-page bar, a page-tools menu, a native new-tab page,
//     and a long-press menu. No Firefox UI, no third-party browser chrome.
//   * ONE GeckoRuntime, ONE GeckoSession per tab. Switching tabs swaps
//     the single GeckoView's session (geckoView.setSession). Private
//     tabs use usePrivateMode(true) and are never persisted or restored.
//   * OWN filtering engine: EVERY tab's session gets the same
//     navigation delegate (SafeSearch rewrite, blocked hosts, scheme
//     checks), progress/content/context-menu delegates, and the same
//     built-in filter WebExtension (installed ONCE on the runtime).
//     The native bridge attributes each scan to its tab via
//     WebExtension.MessageSender.session (public final field, verified
//     in the vendored AAR) and keeps a per-tab sourceUrl -> Verdict map
//     for the download policy.
//   * State layer: BrowserData.kt (TabStore, HistoryStore,
//     BookmarkStore, DownloadStore, SettingsStore, Omnibox,
//     DownloadPolicy, FileBrowserStorage). This file owns NO copies of
//     those classes — it calls them. History is recorded on page stop
//     for non-private http(s) pages only.
//
// Person detection hook: FilterEngine is constructed with a PersonDetector.
// 0.2.2: CombinedPersonDetector(JsReportedPersonDetector(),
// RfDetrPersonDetector(RfDetrOrtBackend)) — RF-DETR Nano runs on-device
// (assets/rfdetr-nano.onnx, onnxruntime-android 1.32.0) as the authoritative
// person model; the content script's person + face numbers stay as a
// complementary signal. PERSON if EITHER says person; NO_PERSON only if
// BOTH ran clean; anything undecided stays covered. StubPersonDetector
// remains for tests only. No verdict in this file is ever faked: there is
// no code path that returns ALLOW without a detector saying NO_PERSON
// above threshold.
//
// GeckoView 160 APIs relied on here — all VERIFIED by javap against the
// vendored AAR (manual-build/libs/geckoview-160.0.20261116130455.aar):
//   * GeckoSession(GeckoSessionSettings) constructor
//   * GeckoSessionSettings.Builder.usePrivateMode(boolean),
//     userAgentMode(int), viewportMode(int); constants
//     USER_AGENT_MODE_MOBILE/DESKTOP, VIEWPORT_MODE_MOBILE/DESKTOP
//   * GeckoSession.getFinder() -> SessionFinder.find(String, int) /
//     clear(); GeckoSession.FINDER_FIND_FORWARD (= 0) /
//     FINDER_FIND_BACKWARDS (= 1); GeckoSession.FinderResult public
//     fields found, wrapped, current, total, searchString, flags,
//     linkUri, clientRect
//   * ContentDelegate.onContextMenu(session, int, int, ContextElement);
//     ContextElement public fields baseUri, linkUri, title, altText,
//     type, srcUri, linkText; TYPE_NONE/IMAGE/VIDEO/AUDIO
//   * WebExtension.MessageSender.public final GeckoSession session
//   * GeckoRuntime.getStorageController() — used by BrowserDataCleaner
//     (Settings "clear cookies/cache" asks the browser to clear Gecko
//     data via onActivityResult; see REQUEST_SETTINGS)
//   * GeckoView.setSession/getSession/releaseSession
//   * GeckoResult.accept(Consumer) / accept(Consumer, Consumer)
//
// What is NOT verified here (no Android device/emulator exists on this VM):
// the Activity has never run. GeckoView startup, extension install,
// content-script injection, the native bridge round-trip, tab switching
// and the cover behaviour on the 8 content types must be checked on a
// real device — see android/GECKOVIEW-PROTOTYPE.md for the exact checklist.
// In particular, private-mode storage isolation is wired only through
// the usePrivateMode API above; it has not been observed on-device.
package com.filterplatform.app

import android.app.Activity
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.PopupMenu
import android.widget.PopupWindow
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import java.net.URLDecoder
import java.net.URLEncoder
import org.json.JSONObject
import org.mozilla.geckoview.AllowOrDeny
import org.mozilla.geckoview.GeckoResult
import org.mozilla.geckoview.GeckoRuntime
import org.mozilla.geckoview.GeckoRuntimeSettings
import org.mozilla.geckoview.GeckoSession
import org.mozilla.geckoview.GeckoSessionSettings
import org.mozilla.geckoview.WebExtension
import kotlin.concurrent.thread

class BrowserActivity : Activity() {

    companion object {
        /** The native-app id the extension addresses (must match
         *  background.js NATIVE_APP and the manifest's expectations). */
        const val NATIVE_APP_ID = "filter-platform"

        /** Built-in extension location: bundled in the APK under assets/. */
        const val EXTENSION_LOCATION = "resource://android/assets/filter-extension/"

        /** First page: the filter dashboard (own property, already live).
         *  Also the default homepage in SettingsStore.DEFAULT_SETTINGS. */
        const val HOME_URL = "https://filter-platform-dashboard.pages.dev"

        // Page-menu item ids (PopupMenu).
        private const val MENU_SHARE = 1
        private const val MENU_DESKTOP = 2
        private const val MENU_BOOKMARK = 3
        private const val MENU_FIND = 4
        private const val MENU_NEW_PRIVATE = 5
        private const val MENU_HISTORY = 6
        private const val MENU_BOOKMARKS = 7
        private const val MENU_DOWNLOADS = 8
        private const val MENU_SETTINGS = 9

        /** Request code for Settings (startActivityForResult): Settings
         *  returns EXTRA_CLEAR_GECKO_FLAGS when the user asked to clear
         *  cookies/cache — the browser owns the GeckoRuntime, so only it
         *  can clear Gecko data (see onActivityResult). */
        private const val REQUEST_SETTINGS = 1001
    }

    private lateinit var store: SecureStore
    private lateinit var engine: FilterEngine
    /** The RF-DETR backend the engine's detector runs on — kept here
     *  too, so the review handler can run the same model on a
     *  finding's thumbnail for boxes (see handleReviewMessage). */
    private lateinit var rfDetrBackend: RfDetrOrtBackend
    /** Local review-decision store: a reviewed image is honoured
     *  from here on later scans without re-asking (see
     *  enrichWithCachedDecisions). */
    private lateinit var reviewDecisionStore: ReviewDecisionStore

    // Pure state layer (BrowserData.kt) — no copies of these classes here.
    private lateinit var browserStorage: FileBrowserStorage
    private lateinit var tabStore: TabStore
    private lateinit var historyStore: HistoryStore
    private lateinit var bookmarkStore: BookmarkStore
    private lateinit var downloadStore: DownloadStore
    private lateinit var settingsStore: SettingsStore

    private lateinit var runtime: GeckoRuntime
    private var runtimeReady = false
    private var geckoView: org.mozilla.geckoview.GeckoView? = null

    // XML views (activity_browser.xml).
    private lateinit var addressInput: EditText
    private lateinit var progressBar: ProgressBar
    private lateinit var filterStatusText: TextView
    private lateinit var backButton: Button
    private lateinit var forwardButton: Button
    private lateinit var reloadButton: Button
    private lateinit var geckoContainer: FrameLayout

    // Programmatic views (built in buildProgrammaticUi()).
    private lateinit var tabStripRow: LinearLayout
    private lateinit var tabsButton: Button
    private lateinit var homeButton: Button
    private lateinit var starButton: Button
    private lateinit var findBar: LinearLayout
    private lateinit var findInput: EditText
    private lateinit var findCountText: TextView
    private lateinit var ntpView: LinearLayout
    private lateinit var ntpSearchInput: EditText
    private lateinit var ntpShortcuts: LinearLayout
    private lateinit var suggestionsPopup: PopupWindow
    private lateinit var suggestionsAdapter: ArrayAdapter<String>
    private var currentSuggestions: List<Suggestion> = emptyList()

    // The device's server policy when registered; the fail-closed local
    // default otherwise (FilterEngine.DEFAULT_POLICY).
    @Volatile private var policy: Policy = FilterEngine.DEFAULT_POLICY
    /** The last server policy fetched (null when never fetched / not
     *  registered). Kept apart from [policy] so the effective policy
     *  can be re-resolved when the local setting changes (see
     *  [effectivePolicy]). */
    @Volatile private var serverPolicy: Policy? = null
    // Hosts the server says are blocked (filled from the policy/blocklist
    // when registered; empty until then — navigation still goes through
    // FilterEngine.shouldBlockNavigation for scheme checks).
    @Volatile private var blockedHosts: Set<String> = emptySet()

    // ------------------------------------------------------------ tab model

    /**
     * One open tab: the persisted [TabState] (source of truth in
     * [TabStore]) plus the live GeckoSession and per-tab runtime state.
     * [session] is null only when the GeckoRuntime failed to start —
     * the tab still exists (strip + new-tab page render) but cannot
     * navigate until the runtime works.
     */
    private class Tab(var state: TabState, var session: GeckoSession?) {
        var currentUrl: String? = state.url
        var canGoBack: Boolean = false
        var canGoForward: Boolean = false
        var loading: Boolean = false
        /** True once this tab has loaded a URL (restored tabs load lazily
         *  on first activation; a fresh tab is false until navigated). */
        var navigated: Boolean = false
        var coveredCount: Int = 0
        var allowedCount: Int = 0
        var blockedCount: Int = 0
        /** Last filter verdict per element source URL (for the download
         *  policy: a covered/blocked image must not be downloadable). */
        val verdicts = HashMap<String, Verdict>()
        /** Last scan's findings by element id — the review handler
         *  looks a covered image up here by the id the content
         *  script sends with {type:'review'}. Replaced on every scan. */
        var findingsById = HashMap<String, ScanFinding>()
    }

    /** Open tabs, in the same order as [TabStore.list]. */
    private val tabs = ArrayList<Tab>()

    /** The selected tab, resolved through TabStore.selectedId. */
    private fun activeTab(): Tab? {
        val selectedId = tabStore.selectedId
        if (selectedId != null) {
            tabs.firstOrNull { it.state.id == selectedId }?.let { return it }
        }
        return tabs.firstOrNull()
    }

    private fun tabForSession(session: GeckoSession): Tab? =
        tabs.firstOrNull { it.session === session }

    private fun displayTitle(tab: Tab): String {
        val base = tab.state.title?.ifBlank { null }
            ?: tab.currentUrl?.ifBlank { null }
            ?: tab.state.url?.ifBlank { null }
            ?: "New Tab"
        return if (tab.state.isPrivate) "$base (private)" else base
    }

    // ------------------------------------------------------------- lifecycle

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = SecureStore(this)
        // HOOK (0.2.2): RF-DETR Nano is the authoritative person model
        // (officially agreed, Apache 2.0); the JS EfficientDet + face-api
        // numbers stay as complementary signals. PERSON if EITHER says
        // person; NO_PERSON only if BOTH ran clean (see
        // CombinedPersonDetector in FilterEngine.kt). The RF-DETR backend
        // is created lazily on first use, on the message-delegate
        // (background) thread — never on the UI thread.
        rfDetrBackend = RfDetrOrtBackend(applicationContext)
        engine = FilterEngine(
            CombinedPersonDetector(
                listOf(
                    JsReportedPersonDetector(),
                    RfDetrPersonDetector(rfDetrBackend)
                )
            )
        )
        browserStorage = FileBrowserStorage(filesDir)
        // TabStore's constructor restores the persisted non-private tabs
        // (private tabs are never written, so they never come back).
        tabStore = TabStore(browserStorage)
        historyStore = HistoryStore(browserStorage)
        bookmarkStore = BookmarkStore(browserStorage)
        downloadStore = DownloadStore(browserStorage)
        settingsStore = SettingsStore(browserStorage)
        reviewDecisionStore = ReviewDecisionStore(browserStorage)

        setContentView(R.layout.activity_browser)

        addressInput = findViewById(R.id.addressInput)
        progressBar = findViewById(R.id.progressBar)
        filterStatusText = findViewById(R.id.filterStatusText)
        backButton = findViewById(R.id.backButton)
        forwardButton = findViewById(R.id.forwardButton)
        reloadButton = findViewById(R.id.reloadButton)
        geckoContainer = findViewById(R.id.geckoContainer)

        buildProgrammaticUi()

        findViewById<Button>(R.id.goButton).setOnClickListener { goToAddress() }
        reloadButton.setOnClickListener { onReloadOrStop() }
        backButton.setOnClickListener { activeTab()?.session?.goBack() }
        forwardButton.setOnClickListener { activeTab()?.session?.goForward() }
        addressInput.setOnEditorActionListener { _, _, _ -> goToAddress(); true }
        addressInput.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable?) {
                // Suggestions only while the user is typing in the
                // omnibox — not when the field is set programmatically
                // (tab switch / location change).
                if (addressInput.hasFocus()) refreshSuggestions()
            }
        })

        // --- GeckoView runtime (own settings, no Firefox defaults) ---
        // 0.1.1: if the runtime fails to start, show the real error in the
        // status line instead of crashing the whole app — the user can
        // report it and the browser simply stays unusable until fixed.
        // Tabs are still created (strip + new-tab page render); their
        // sessions are null and navigation reports the failure.
        try {
            val settings = GeckoRuntimeSettings.Builder()
                .javaScriptEnabled(true)      // the filter itself needs JS
                .remoteDebuggingEnabled(false)
                .consoleOutput(false)
                .build()
            runtime = GeckoRuntime.create(this, settings)
            runtimeReady = true

            val newGeckoView = org.mozilla.geckoview.GeckoView(this)
            geckoView = newGeckoView
            geckoContainer.addView(
                newGeckoView,
                FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT
                )
            )
        } catch (e: Exception) {
            runtimeReady = false
            filterStatusText.text =
                "GeckoView failed to start: ${e.javaClass.simpleName}: ${e.message}"
        }

        // Restore tabs (or open one fresh new tab) and activate the
        // selected one. Restored tabs load their URL lazily on first
        // activation (see activateTab); fresh tabs show the new-tab page.
        val restored = tabStore.list()
        if (restored.isEmpty()) {
            createNewTab(null, false)
        } else {
            for (state in restored) tabs.add(Tab(state, createSession(state)))
            val selected = tabStore.selectedTab() ?: restored.first()
            activateTab(tabs.firstOrNull { it.state.id == selected.id } ?: tabs.first())
        }

        // History/Bookmarks open a URL in this browser via the "open_url"
        // intent extra (same contract in onNewIntent; the activity is
        // singleTask in the manifest, so a second tap reuses this one).
        handleOpenUrlIntent(intent)

        if (runtimeReady) {
            installFilterExtension()
            loadPolicy()
        }
        updateFilterStatus()
    }

    override fun onDestroy() {
        if (::suggestionsPopup.isInitialized && suggestionsPopup.isShowing) {
            suggestionsPopup.dismiss()
        }
        for (tab in tabs) {
            try { tab.session?.close() } catch (_: Exception) { /* already closed */ }
        }
        tabs.clear()
        super.onDestroy()
    }

    override fun onBackPressed() {
        // Close the find bar first, then go back in the active tab's
        // page history; only exit when there is no page history.
        if (::findBar.isInitialized && findBar.visibility == View.VISIBLE) {
            hideFindBar()
            return
        }
        val tab = activeTab()
        if (tab != null && tab.canGoBack) {
            tab.session?.goBack()
        } else {
            super.onBackPressed()
        }
    }

    /** History/Bookmarks open a URL in this browser: singleTask in the
     *  manifest delivers a second tap here instead of a new instance. */
    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        if (intent != null) {
            setIntent(intent)
            handleOpenUrlIntent(intent)
        }
    }

    /** Open the "open_url" intent extra in a new tab, if present. */
    private fun handleOpenUrlIntent(intent: Intent) {
        val url = intent.getStringExtra("open_url")?.trim()
        if (!url.isNullOrBlank()) {
            createNewTab(url, false)
        }
    }

    /** Settings returns here: clear Gecko cookies/cache/site data when
     *  the user asked for it (only the browser owns the GeckoRuntime).
     *  clearData() is async — the Boolean only says the clear was
     *  issued; failures are reported in the status line. */
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQUEST_SETTINGS || resultCode != Activity.RESULT_OK) return
        // The local human-image-mode setting may have changed in
        // Settings — re-resolve the effective policy (the server mode,
        // when the server specified one, still wins).
        policy = effectivePolicy()
        updateFilterStatus()
        val flags = data?.getLongExtra(
            SettingsActivity.EXTRA_CLEAR_GECKO_FLAGS, 0L) ?: 0L
        if (flags == 0L) return
        if (!runtimeReady) {
            filterStatusText.text =
                "Could not clear browser data: GeckoView is not running."
            return
        }
        val issued = try {
            BrowserDataCleaner.clearGeckoData(runtime, flags)
        } catch (t: Throwable) {
            filterStatusText.text =
                "Could not clear browser data (${t.javaClass.simpleName})"
            return
        }
        filterStatusText.text = if (issued) "Browser data cleared."
        else "Could not clear browser data."
    }

    // -------------------------------------------------------- tab management

    /**
     * Build a session for a tab: private mode for private tabs,
     * desktop user-agent + viewport for desktop-site tabs.
     * Returns null when the runtime failed to start.
     */
    private fun createSession(state: TabState): GeckoSession? {
        if (!runtimeReady) return null
        val desktop = state.desktopSite
        val settings = GeckoSessionSettings.Builder()
            .usePrivateMode(state.isPrivate)
            .userAgentMode(
                if (desktop) GeckoSessionSettings.USER_AGENT_MODE_DESKTOP
                else GeckoSessionSettings.USER_AGENT_MODE_MOBILE
            )
            .viewportMode(
                if (desktop) GeckoSessionSettings.VIEWPORT_MODE_DESKTOP
                else GeckoSessionSettings.VIEWPORT_MODE_MOBILE
            )
            .build()
        val session = GeckoSession(settings)
        // Every tab gets the SAME delegates: the filter applies to every
        // navigation, every page load and every context menu, not just
        // the first tab's.
        session.setNavigationDelegate(navigationDelegate)
        session.setProgressDelegate(progressDelegate)
        session.setContentDelegate(contentDelegate)
        session.open(runtime)
        return session
    }

    /** Open a tab (blank/new-tab page when [url] is null) and switch to it. */
    private fun createNewTab(url: String?, isPrivate: Boolean): Tab {
        var state = tabStore.newTab(url, isPrivate)
        if (settingsStore.settings.desktopSiteDefault && !state.desktopSite) {
            tabStore.updateTab(state.id, desktopSite = true)
            state = state.copy(desktopSite = true)
        }
        val tab = Tab(state, createSession(state))
        tabs.add(tab)
        if (url != null) {
            tab.session?.loadUri(url)
            tab.navigated = true
        }
        activateTab(tab)
        return tab
    }

    /** Make [tab] the active tab: swap the GeckoView's session, lazily
     *  load a restored tab's URL, and refresh all chrome for it. */
    private fun activateTab(tab: Tab) {
        tabStore.selectTab(tab.state.id)
        val session = tab.session
        if (session != null) {
            geckoView?.setSession(session)
            if (!tab.navigated && tab.state.url != null) {
                session.loadUri(tab.state.url!!)
                tab.navigated = true
            }
        }
        hideFindBar()
        refreshChrome()
    }

    /** Close a tab. Closing the last tab opens a fresh new tab — the
     *  activity is never left with no tab. */
    private fun closeTab(tab: Tab) {
        val wasActive = tab === activeTab()
        tabStore.closeTab(tab.state.id)
        tabs.remove(tab)
        try { tab.session?.close() } catch (_: Exception) { /* already closed */ }
        if (tabs.isEmpty()) {
            createNewTab(null, false)
        } else if (wasActive) {
            activateTab(activeTab() ?: tabs.first())
        } else {
            rebuildTabStrip()
        }
    }

    /**
     * Desktop-site toggle for a tab: the user-agent/viewport live on
     * the session settings, so the session is recreated with the other
     * mode and the URL is reloaded. Persists in TabState.
     */
    private fun setDesktopSite(tab: Tab, desktop: Boolean) {
        try { tab.session?.close() } catch (_: Exception) { /* already closed */ }
        tabStore.updateTab(tab.state.id, desktopSite = desktop)
        tab.state = tab.state.copy(desktopSite = desktop)
        val newSession = createSession(tab.state)
        tab.session = newSession
        val url = tab.currentUrl ?: tab.state.url
        if (newSession != null && url != null) {
            newSession.loadUri(url)
            tab.navigated = true
        }
        if (tab === activeTab()) {
            if (newSession != null) geckoView?.setSession(newSession)
            refreshChrome()
        }
    }

    // ------------------------------------------------------------ chrome UI

    /** Refresh every chrome element for the active tab. */
    private fun refreshChrome() {
        val tab = activeTab()
        if (tab == null) {
            addressInput.setText("")
            backButton.isEnabled = false
            forwardButton.isEnabled = false
            updateReloadButton()
            updateStarButton()
            updateFilterStatus()
            rebuildTabStrip()
            updateNtpVisibility()
            return
        }
        val url = tab.currentUrl ?: tab.state.url ?: ""
        if (addressInput.text.toString() != url) addressInput.setText(url)
        backButton.isEnabled = tab.canGoBack
        forwardButton.isEnabled = tab.canGoForward
        updateReloadButton()
        updateStarButton()
        updateFilterStatus()
        rebuildTabStrip()
        updateNtpVisibility()
        val title = tab.state.title?.ifBlank { null } ?: "New Tab"
        setTitle("Filter Browser — $title")
    }

    /** The reload button shows the stop state while the active tab loads. */
    private fun updateReloadButton() {
        reloadButton.text = if (activeTab()?.loading == true) "✕" else "↻"
    }

    private fun onReloadOrStop() {
        val tab = activeTab() ?: return
        val session = tab.session ?: run {
            filterStatusText.text = "GeckoView failed to start — cannot navigate."
            return
        }
        if (tab.loading) session.stop() else session.reload()
    }

    /** Rebuild the tab strip chips (title + close button per tab). */
    private fun rebuildTabStrip() {
        if (!::tabStripRow.isInitialized) return
        tabStripRow.removeAllViews()
        val active = activeTab()
        for (state in tabStore.list()) {
            val tab = tabs.firstOrNull { it.state.id == state.id } ?: continue
            val chip = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                setPadding(16, 8, 8, 8)
            }
            chip.setBackgroundColor(
                if (tab === active) Color.parseColor("#BBDEFB")
                else Color.parseColor("#EEEEEE")
            )
            val titleView = TextView(this).apply {
                text = displayTitle(tab)
                maxWidth = 420
                maxLines = 1
                ellipsize = android.text.TextUtils.TruncateAt.END
            }
            chip.addView(titleView)
            val close = Button(this).apply {
                text = "×"
                setOnClickListener { closeTab(tab) }
            }
            chip.addView(close)
            chip.setOnClickListener { activateTab(tab) }
            tabStripRow.addView(chip)
        }
        if (::tabsButton.isInitialized) {
            tabsButton.text = "▦ ${tabStore.list().size}"
        }
    }

    /** The tab strip, toolbar additions, find bar and new-tab page are
     *  all built in code — no new XML layouts (see file header). */
    private fun buildProgrammaticUi() {
        val root = findViewById<ViewGroup>(android.R.id.content)
            .getChildAt(0) as LinearLayout
        val toolbar = addressInput.parent as LinearLayout

        // --- Tab strip (row 0): scrollable chips + new tab + overview ---
        val stripContainer = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
        }
        val scroller = HorizontalScrollView(this).apply {
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        tabStripRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
        }
        scroller.addView(tabStripRow)
        stripContainer.addView(scroller)
        val newTabButton = Button(this).apply {
            text = "+"
            setOnClickListener { createNewTab(null, false) }
        }
        stripContainer.addView(newTabButton)
        tabsButton = Button(this).apply {
            text = "▦ 0"
            setOnClickListener { showTabOverview() }
        }
        stripContainer.addView(tabsButton)
        root.addView(stripContainer, 0)

        // --- Toolbar additions: home, bookmark star, page menu ---
        homeButton = Button(this).apply {
            text = "⌂"
            setOnClickListener { goHome() }
        }
        toolbar.addView(homeButton)
        starButton = Button(this).apply {
            text = "☆"
            setOnClickListener { toggleBookmark() }
        }
        toolbar.addView(starButton)
        val menuButton = Button(this).apply {
            text = "⋮"
            setOnClickListener { showPageMenu(this) }
        }
        toolbar.addView(menuButton)

        // --- Find bar (hidden until Find in page): above the GeckoView ---
        findBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            visibility = View.GONE
            setPadding(8, 4, 8, 4)
        }
        findInput = EditText(this).apply {
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
            hint = "Find in page"
            setSingleLine()
        }
        findInput.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable?) { runFind(true) }
        })
        findInput.setOnEditorActionListener { _, _, _ -> runFind(true); true }
        findBar.addView(findInput)
        val findPrev = Button(this).apply {
            text = "↑"
            setOnClickListener { runFind(false) }
        }
        findBar.addView(findPrev)
        val findNext = Button(this).apply {
            text = "↓"
            setOnClickListener { runFind(true) }
        }
        findBar.addView(findNext)
        findCountText = TextView(this).apply {
            setPadding(8, 0, 8, 0)
        }
        findBar.addView(findCountText)
        val findClose = Button(this).apply {
            text = "✕"
            setOnClickListener { hideFindBar() }
        }
        findBar.addView(findClose)
        root.addView(findBar, root.indexOfChild(geckoContainer))

        // --- Suggestions popup under the omnibox ---
        val suggestionsList = ListView(this)
        suggestionsAdapter = ArrayAdapter(this, android.R.layout.simple_list_item_1, ArrayList<String>())
        suggestionsList.adapter = suggestionsAdapter
        suggestionsList.setOnItemClickListener { _, _, position, _ ->
            val suggestion = currentSuggestions.getOrNull(position) ?: return@setOnItemClickListener
            dismissSuggestions()
            val tab = activeTab() ?: return@setOnItemClickListener
            addressInput.setText(suggestion.url)
            navigateToUrl(tab, suggestion.url)
        }
        suggestionsPopup = PopupWindow(
            suggestionsList,
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
            false
        )

        // --- New-tab page (native view inside the GeckoView container) ---
        ntpView = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
            setPadding(32, 32, 32, 32)
        }
        val ntpTitle = TextView(this).apply {
            text = "Filter Browser"
            textSize = 22f
            setPadding(0, 0, 0, 24)
        }
        ntpView.addView(ntpTitle)
        val ntpSearchRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
        }
        ntpSearchInput = EditText(this).apply {
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
            hint = "Search or type an address"
            setSingleLine()
        }
        ntpSearchInput.setOnEditorActionListener { _, _, _ -> goToNtpSearch(); true }
        ntpSearchRow.addView(ntpSearchInput)
        val ntpGo = Button(this).apply {
            text = "Go"
            setOnClickListener { goToNtpSearch() }
        }
        ntpSearchRow.addView(ntpGo)
        ntpView.addView(ntpSearchRow)
        val shortcutsLabel = TextView(this).apply {
            text = "Shortcuts"
            textSize = 16f
            setPadding(0, 24, 0, 8)
        }
        ntpView.addView(shortcutsLabel)
        ntpShortcuts = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }
        ntpView.addView(ntpShortcuts)
        geckoContainer.addView(
            ntpView,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        )
    }

    /** Tab overview: a simple list dialog — tap to switch, close per row. */
    private fun showTabOverview() {
        val list = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(16, 8, 16, 8)
        }
        val active = activeTab()
        for (state in tabStore.list()) {
            val tab = tabs.firstOrNull { it.state.id == state.id } ?: continue
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                setPadding(0, 8, 0, 8)
            }
            val label = TextView(this).apply {
                text = displayTitle(tab)
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                maxLines = 1
                ellipsize = android.text.TextUtils.TruncateAt.END
            }
            row.addView(label)
            val close = Button(this).apply {
                text = "×"
            }
            // The dialog is dismissed by the switch action; the close
            // button must dismiss it itself before closing the tab.
            close.setOnClickListener { overviewDialog?.dismiss(); closeTab(tab) }
            row.addView(close)
            row.setOnClickListener { overviewDialog?.dismiss(); activateTab(tab) }
            // Mark the active row bold-ish via the title prefix.
            if (tab === active) label.text = "▶ ${displayTitle(tab)}"
            list.addView(row)
        }
        val scroll = ScrollView(this).apply { addView(list) }
        overviewDialog = AlertDialog.Builder(this)
            .setTitle("Tabs (${tabStore.list().size})")
            .setView(scroll)
            .setPositiveButton("New tab") { _, _ -> createNewTab(null, false) }
            .setNegativeButton("Close", null)
            .show()
    }

    private var overviewDialog: AlertDialog? = null

    /** Show the new-tab page when the active tab has no URL yet; hide
     *  the GeckoView while it is shown. */
    private fun updateNtpVisibility() {
        if (!::ntpView.isInitialized) return
        val tab = activeTab()
        val show = tab == null || (tab.state.url == null && !tab.navigated)
        if (show) rebuildNtpShortcuts()
        ntpView.visibility = if (show) View.VISIBLE else View.GONE
        geckoView?.visibility = if (show) View.GONE else View.VISIBLE
    }

    /** New-tab page shortcuts: bookmarks first, then most-visited hosts. */
    private fun rebuildNtpShortcuts() {
        if (!::ntpShortcuts.isInitialized) return
        ntpShortcuts.removeAllViews()
        var added = 0
        for (bookmark in bookmarkStore.list()) {
            if (added >= 8) break
            addNtpShortcut(bookmark.title.ifBlank { bookmark.url }, bookmark.url)
            added++
        }
        for (site in historyStore.topSites(6)) {
            if (added >= 8) break
            val url = "https://${site.host}"
            addNtpShortcut(site.host, url)
            added++
        }
        if (added == 0) {
            ntpShortcuts.addView(TextView(this).apply {
                text = "No shortcuts yet — visit a page or save a bookmark."
            })
        }
    }

    private fun addNtpShortcut(label: String, url: String) {
        val button = Button(this).apply {
            text = label
            setOnClickListener {
                val tab = activeTab() ?: return@setOnClickListener
                navigateToUrl(tab, url)
            }
        }
        ntpShortcuts.addView(button)
    }

    private fun goToNtpSearch() {
        val tab = activeTab() ?: return
        val input = ntpSearchInput.text.toString()
        if (input.isBlank()) return
        ntpSearchInput.setText("")
        navigateTo(tab, input)
    }

    // ------------------------------------------------------------ navigation

    /** Resolve omnibox input (URL vs search) and navigate the tab. */
    private fun navigateTo(tab: Tab, rawInput: String) {
        navigateToUrl(tab, Omnibox.resolve(rawInput, settingsStore.settings))
    }

    private fun navigateToUrl(tab: Tab, url: String) {
        val session = tab.session
        if (session == null) {
            filterStatusText.text = "GeckoView failed to start — cannot navigate."
            return
        }
        dismissSuggestions()
        session.loadUri(url)
        tab.navigated = true
        tab.currentUrl = url
        tabStore.updateTab(tab.state.id, url = url)
        tab.state = tab.state.copy(url = url)
        if (tab === activeTab()) {
            if (addressInput.text.toString() != url) addressInput.setText(url)
            updateNtpVisibility()
            updateStarButton()
        }
    }

    private fun goToAddress() {
        val tab = activeTab() ?: return
        val input = addressInput.text.toString()
        if (input.isBlank()) return
        navigateTo(tab, input)
    }

    private fun goHome() {
        val tab = activeTab() ?: return
        navigateToUrl(tab, settingsStore.settings.homepage)
    }

    // ------------------------------------------------------------- suggestions

    private fun refreshSuggestions() {
        if (!::suggestionsPopup.isInitialized) return
        val query = addressInput.text.toString()
        if (query.isBlank()) {
            dismissSuggestions()
            return
        }
        val list = Omnibox.suggestions(
            query,
            historyStore.all(),
            bookmarkStore.list(),
            tabStore.list()
        )
        if (list.isEmpty()) {
            dismissSuggestions()
            return
        }
        currentSuggestions = list
        suggestionsAdapter.clear()
        suggestionsAdapter.addAll(list.map { "${it.title}\n${it.url}" })
        suggestionsAdapter.notifyDataSetChanged()
        if (!suggestionsPopup.isShowing) {
            suggestionsPopup.showAsDropDown(addressInput)
        }
    }

    private fun dismissSuggestions() {
        if (::suggestionsPopup.isInitialized && suggestionsPopup.isShowing) {
            suggestionsPopup.dismiss()
        }
    }

    // -------------------------------------------------------------- find bar

    private fun showFindBar() {
        findBar.visibility = View.VISIBLE
        findInput.requestFocus()
    }

    private fun hideFindBar() {
        if (!::findBar.isInitialized) return
        findBar.visibility = View.GONE
        findCountText.text = ""
        try { activeTab()?.session?.getFinder()?.clear() } catch (_: Exception) { }
    }

    private fun runFind(forward: Boolean) {
        if (!::findBar.isInitialized || findBar.visibility != View.VISIBLE) return
        val tab = activeTab() ?: return
        val session = tab.session ?: return
        val query = findInput.text.toString()
        if (query.isBlank()) {
            findCountText.text = ""
            return
        }
        val flags = if (forward) GeckoSession.FINDER_FIND_FORWARD
            else GeckoSession.FINDER_FIND_BACKWARDS
        session.getFinder().find(query, flags).accept { result ->
            runOnUiThread {
                findCountText.text = if (result != null && result.total > 0) {
                    "${result.current} of ${result.total}"
                } else {
                    "0 of 0"
                }
            }
        }
    }

    // --------------------------------------------------------------- delegates

    private val navigationDelegate = object : GeckoSession.NavigationDelegate {
        override fun onLoadRequest(
            session: GeckoSession,
            request: GeckoSession.NavigationDelegate.LoadRequest
        ): GeckoResult<AllowOrDeny>? {
            // EVERY top-level navigation passes through the filter engine,
            // in this order:
            //  1. SafeSearch: a search-engine URL without its SafeSearch
            //     param is denied and re-loaded with the param added.
            //     rewriteSafeSearch is idempotent, so the re-loaded URL
            //     passes straight through (no loop).
            //  2. Blocked host: deny and show the Yiddish block page.
            //  3. The remaining navigation checks (unknown schemes).
            // The loadUri / showBlockPage calls run on the UI thread; the
            // deny result itself is returned synchronously.
            val uri = request.uri
            val rewritten = if (policy.forceSafeSearch) {
                FilterEngine.rewriteSafeSearch(uri, true)
            } else {
                null
            }
            if (rewritten != null && rewritten != uri) {
                runOnUiThread { session.loadUri(rewritten) }
                return GeckoResult.deny()
            }
            val blockedHost = FilterEngine.matchedBlockedHost(uri, blockedHosts)
            if (blockedHost != null) {
                runOnUiThread { showBlockPage(session, blockedHost) }
                return GeckoResult.deny()
            }
            return if (FilterEngine.shouldBlockNavigation(uri, blockedHosts)) {
                runOnUiThread {
                    if (tabForSession(session) === activeTab()) {
                        filterStatusText.text =
                            "Blocked navigation: $uri (filter policy)"
                    }
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
                val tab = tabForSession(session) ?: return@runOnUiThread
                if (url != null) {
                    tab.currentUrl = url
                    tabStore.updateTab(tab.state.id, url = url)
                    tab.state = tab.state.copy(url = url)
                    if (tab === activeTab()) {
                        if (addressInput.text.toString() != url) addressInput.setText(url)
                        updateStarButton()
                        updateNtpVisibility()
                    }
                    rebuildTabStrip()
                }
            }
        }

        override fun onCanGoBack(session: GeckoSession, canGoBack: Boolean) {
            runOnUiThread {
                val tab = tabForSession(session) ?: return@runOnUiThread
                tab.canGoBack = canGoBack
                if (tab === activeTab()) backButton.isEnabled = canGoBack
            }
        }

        override fun onCanGoForward(session: GeckoSession, canGoForward: Boolean) {
            runOnUiThread {
                val tab = tabForSession(session) ?: return@runOnUiThread
                tab.canGoForward = canGoForward
                if (tab === activeTab()) forwardButton.isEnabled = canGoForward
            }
        }
    }

    private val progressDelegate = object : GeckoSession.ProgressDelegate {
        override fun onPageStart(session: GeckoSession, url: String) {
            runOnUiThread {
                val tab = tabForSession(session) ?: return@runOnUiThread
                tab.loading = true
                // New page: reset this tab's counters; the content script
                // reports fresh findings for it.
                tab.coveredCount = 0; tab.allowedCount = 0; tab.blockedCount = 0
                if (tab === activeTab()) {
                    progressBar.visibility = View.VISIBLE
                    progressBar.progress = 0
                    updateReloadButton()
                    updateFilterStatus()
                }
            }
        }

        override fun onProgressChange(session: GeckoSession, progress: Int) {
            runOnUiThread {
                if (tabForSession(session) === activeTab()) {
                    progressBar.progress = progress
                }
            }
        }

        override fun onPageStop(session: GeckoSession, success: Boolean) {
            runOnUiThread {
                val tab = tabForSession(session) ?: return@runOnUiThread
                tab.loading = false
                if (tab === activeTab()) {
                    progressBar.visibility = View.GONE
                    progressBar.progress = 100
                    updateReloadButton()
                }
                // Record history on page stop: non-private tabs, http(s)
                // pages only (HistoryStore.record also ignores non-http(s)).
                if (success && !tab.state.isPrivate) {
                    val url = tab.currentUrl ?: tab.state.url
                    if (url != null) {
                        historyStore.record(url, tab.state.title ?: "")
                    }
                }
            }
        }
    }

    private val contentDelegate = object : GeckoSession.ContentDelegate {
        override fun onTitleChange(session: GeckoSession, title: String?) {
            runOnUiThread {
                val tab = tabForSession(session) ?: return@runOnUiThread
                if (!title.isNullOrBlank()) {
                    tabStore.updateTab(tab.state.id, title = title)
                    tab.state = tab.state.copy(title = title)
                    if (tab === activeTab()) {
                        setTitle("Filter Browser — $title")
                    }
                    rebuildTabStrip()
                }
            }
        }

        override fun onContextMenu(
            session: GeckoSession,
            screenX: Int,
            screenY: Int,
            element: GeckoSession.ContentDelegate.ContextElement
        ) {
            runOnUiThread { showContextMenu(session, element) }
        }
    }

    /**
     * Show the Yiddish block page for a blocked host: read the bundled
     * filter-extension/blocked.html asset, substitute the blocked host
     * and the current policy name into its data-domain / data-policy
     * attributes (HTML-escaped), and load the result as a data: URL
     * into the session that was blocked.
     *
     * UNVERIFIED ON-DEVICE: loading a data: URL as the top-level page
     * in GeckoView has never been tried on a real device — if GeckoView
     * refuses it, the navigation stays denied and the status line says
     * so. If reading the asset itself fails, fall back to a plain deny
     * and write the error to the status line.
     */
    private fun showBlockPage(session: GeckoSession, host: String) {
        try {
            val html = applicationContext.assets
                .open("filter-extension/blocked.html")
                .bufferedReader(Charsets.UTF_8).use { it.readText() }
            val page = html
                .replace("{{DOMAIN}}", FilterEngine.escapeHtml(host))
                .replace("{{POLICY_NAME}}", FilterEngine.escapeHtml(policy.name))
            session.loadUri("data:text/html;charset=utf-8," + URLEncoder.encode(page, "UTF-8"))
            if (tabForSession(session) === activeTab()) {
                filterStatusText.text = "Blocked: $host (filter policy)"
            }
        } catch (e: Exception) {
            // Asset missing or unreadable: the navigation is still denied
            // (the caller already returned deny) — just say so.
            if (tabForSession(session) === activeTab()) {
                filterStatusText.text =
                    "Blocked: $host — block page failed to load " +
                        "(${e.javaClass.simpleName}: ${e.message})"
            }
        }
    }

    // ------------------------------------------------------- long-press menu

    /** Long-press menu for the tab that owns [session]. Only the actions
     *  that apply to the pressed element are offered. */
    private fun showContextMenu(
        session: GeckoSession,
        element: GeckoSession.ContentDelegate.ContextElement
    ) {
        val tab = tabForSession(session) ?: return
        val items = ArrayList<String>()
        val actions = ArrayList<() -> Unit>()
        val linkUri = element.linkUri?.ifBlank { null }
        val srcUri = element.srcUri?.ifBlank { null }
        if (linkUri != null) {
            items.add("Open link in new tab")
            actions.add { createNewTab(linkUri, false) }
            items.add("Copy link")
            actions.add { copyToClipboard("Link", linkUri) }
        }
        if (element.type == GeckoSession.ContentDelegate.ContextElement.TYPE_IMAGE
            && srcUri != null
        ) {
            items.add("Download image")
            actions.add { tryDownload(srcUri, tab.verdicts[srcUri]) }
        }
        if (linkUri != null) {
            items.add("Download link")
            actions.add { tryDownload(linkUri, null) }
        }
        if (items.isEmpty()) return
        val title = element.title?.ifBlank { null } ?: linkUri ?: srcUri ?: "Link"
        AlertDialog.Builder(this)
            .setTitle(title)
            .setItems(items.toTypedArray()) { _, which -> actions[which]() }
            .show()
    }

    private fun copyToClipboard(label: String, text: String) {
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText(label, text))
        Toast.makeText(this, "Copied", Toast.LENGTH_SHORT).show()
    }

    /**
     * Download gate: the filter policy decides. A covered/blocked/
     * unreviewed image (or an image with no verdict at all) is refused
     * with the policy's own reason — a download must never be a way
     * around the visual filter.
     */
    private fun tryDownload(url: String, elementVerdict: Verdict?) {
        when (val decision = DownloadPolicy.decide(url, blockedHosts, elementVerdict)) {
            is DownloadDecision.ALLOW -> startDownload(url, fileNameFromUrl(url))
            is DownloadDecision.BLOCK -> {
                AlertDialog.Builder(this)
                    .setTitle("Download blocked")
                    .setMessage(
                        "This content is covered by the filter and cannot " +
                            "be downloaded: ${decision.reason}"
                    )
                    .setPositiveButton("OK", null)
                    .show()
            }
        }
    }

    /** Enqueue a download with DownloadManager and record it in the
     *  download history (DownloadsActivity lists it). The DownloadManager
     *  id is stored on the record so DownloadsActivity can look the
     *  download up directly (no title matching). Enqueue goes through
     *  DownloadHelper (it owns the pre-Android-10 storage-permission
     *  path); when permission is requested, the download is re-enqueued
     *  from onRequestPermissionsResult. */
    private fun startDownload(url: String, fileName: String) {
        try {
            val record = downloadStore.add(url, fileName)
            val managerId = DownloadHelper.enqueue(this, url, fileName)
            if (managerId == null) {
                if (DownloadHelper.needsStoragePermission(this)) {
                    // Permission request fired by enqueue(); the
                    // download resumes in onRequestPermissionsResult.
                    pendingDownload = record.id to url
                    Toast.makeText(
                        this, "Storage permission needed to download",
                        Toast.LENGTH_LONG
                    ).show()
                } else {
                    filterStatusText.text = "Download failed: could not start."
                    Toast.makeText(this, "Download failed", Toast.LENGTH_LONG).show()
                }
                return
            }
            downloadStore.setDownloadManagerId(record.id, managerId)
            Toast.makeText(this, "Downloading $fileName", Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            filterStatusText.text =
                "Download failed: ${e.javaClass.simpleName}: ${e.message}"
            Toast.makeText(this, "Download failed: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }

    /** A download waiting on the pre-Android-10 storage permission:
     *  (DownloadStore record id, URL). Re-enqueued from
     *  onRequestPermissionsResult when the user grants it. */
    private var pendingDownload: Pair<Long, String>? = null

    override fun onRequestPermissionsResult(
        requestCode: Int, permissions: Array<out String>, grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != DownloadHelper.REQUEST_WRITE_STORAGE) return
        val pending = pendingDownload ?: return
        pendingDownload = null
        if (grantResults.isNotEmpty() &&
            grantResults[0] == android.content.pm.PackageManager.PERMISSION_GRANTED
        ) {
            val record = downloadStore.get(pending.first) ?: return
            val managerId = DownloadHelper.enqueue(this, pending.second, record.fileName)
            if (managerId != null) {
                downloadStore.setDownloadManagerId(record.id, managerId)
                Toast.makeText(this, "Downloading ${record.fileName}", Toast.LENGTH_SHORT).show()
            } else {
                filterStatusText.text = "Download failed: could not start."
            }
        } else {
            filterStatusText.text = "Download cancelled: storage permission denied."
        }
    }

    private fun fileNameFromUrl(url: String): String {
        val clean = url.substringBefore("?").substringBefore("#")
        val last = clean.substringAfterLast("/").trim()
        if (last.isBlank()) return "download"
        return try {
            URLDecoder.decode(last, "UTF-8").ifBlank { "download" }
        } catch (_: Exception) {
            last
        }
    }

    // ------------------------------------------------------------ page menu

    private fun showPageMenu(anchor: View) {
        val tab = activeTab()
        val popup = PopupMenu(this, anchor)
        popup.menu.add(0, MENU_SHARE, 0, "Share")
        popup.menu.add(0, MENU_DESKTOP, 1, "Desktop site").apply {
            isCheckable = true
            isChecked = tab?.state?.desktopSite == true
        }
        popup.menu.add(
            0, MENU_BOOKMARK, 2,
            if (isCurrentBookmarked()) "Remove bookmark" else "Bookmark this page"
        )
        popup.menu.add(0, MENU_FIND, 3, "Find in page")
        popup.menu.add(0, MENU_NEW_PRIVATE, 4, "New private tab")
        popup.menu.add(0, MENU_HISTORY, 5, "History")
        popup.menu.add(0, MENU_BOOKMARKS, 6, "Bookmarks")
        popup.menu.add(0, MENU_DOWNLOADS, 7, "Downloads")
        popup.menu.add(0, MENU_SETTINGS, 8, "Settings")
        popup.setOnMenuItemClickListener { item ->
            when (item.itemId) {
                MENU_SHARE -> shareCurrentPage()
                MENU_DESKTOP -> {
                    val t = activeTab()
                    if (t != null) setDesktopSite(t, !t.state.desktopSite)
                }
                MENU_BOOKMARK -> toggleBookmark()
                MENU_FIND -> showFindBar()
                MENU_NEW_PRIVATE -> createNewTab(null, true)
                MENU_HISTORY -> openSubActivity(
                    "com.filterplatform.app.HistoryActivity", "History"
                )
                MENU_BOOKMARKS -> openSubActivity(
                    "com.filterplatform.app.BookmarksActivity", "Bookmarks"
                )
                MENU_DOWNLOADS -> openSubActivity(
                    "com.filterplatform.app.DownloadsActivity", "Downloads"
                )
                MENU_SETTINGS -> openSettings()
            }
            true
        }
        popup.show()
    }

    /** Settings is started for a result (see REQUEST_SETTINGS): it
     *  returns EXTRA_CLEAR_GECKO_FLAGS when the user asked to clear
     *  cookies/cache, and only this activity can clear Gecko data. */
    private fun openSettings() {
        try {
            val intent = Intent()
                .setClassName(packageName, "com.filterplatform.app.SettingsActivity")
            startActivityForResult(intent, REQUEST_SETTINGS)
        } catch (e: Exception) {
            filterStatusText.text =
                "Settings is not available yet (${e.javaClass.simpleName})"
            Toast.makeText(this, "Settings is not available yet", Toast.LENGTH_SHORT).show()
        }
    }

    /**
     * The History/Bookmarks/Downloads/Settings activities are built by
     * another agent; the intents are wired by class name (string-based,
     * so this file compiles before those classes exist). If an activity
     * is not there yet, the user gets an honest message, not a crash.
     */
    private fun openSubActivity(className: String, label: String) {
        try {
            val intent = Intent().setClassName(packageName, className)
            startActivity(intent)
        } catch (e: Exception) {
            filterStatusText.text =
                "$label is not available yet (${e.javaClass.simpleName})"
            Toast.makeText(this, "$label is not available yet", Toast.LENGTH_SHORT).show()
        }
    }

    private fun shareCurrentPage() {
        val tab = activeTab() ?: return
        val url = tab.currentUrl ?: tab.state.url
        if (url.isNullOrBlank()) {
            Toast.makeText(this, "Nothing to share yet", Toast.LENGTH_SHORT).show()
            return
        }
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, url)
            tab.state.title?.let { putExtra(Intent.EXTRA_SUBJECT, it) }
        }
        startActivity(Intent.createChooser(intent, "Share link"))
    }

    private fun isCurrentBookmarked(): Boolean {
        val tab = activeTab() ?: return false
        val url = tab.currentUrl ?: tab.state.url ?: return false
        return bookmarkStore.isBookmarked(url)
    }

    private fun updateStarButton() {
        if (!::starButton.isInitialized) return
        starButton.text = if (isCurrentBookmarked()) "★" else "☆"
    }

    private fun toggleBookmark() {
        val tab = activeTab() ?: return
        val url = tab.currentUrl ?: tab.state.url ?: return
        if (bookmarkStore.isBookmarked(url)) {
            val existing = bookmarkStore.list().firstOrNull { it.url == url }
            if (existing != null) bookmarkStore.remove(existing.id)
        } else {
            bookmarkStore.add(url, tab.state.title ?: url)
        }
        updateStarButton()
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
     * The native bridge. Two message types, both from the content
     * script via background.js (a generic relay — see
     * filter-extension/background.js):
     *   {"type":"scan", ...}   -> FilterEngine decisions (see
     *     handleScanMessage).
     *   {"type":"review", id, source, imageKey} -> second-stage
     *     review for one covered image (see handleReviewMessage):
     *     runs RF-DETR on the finding's thumbnail and replies
     *     {"type":"review-decision", id, decision, boxes, best,
     *     model, reason, contentHash}.
     * Any other message, or any failure parsing it, returns null —
     * the content script then keeps everything covered.
     *
     * Per-tab attribution: WebExtension.MessageSender.session (public
     * final field) is the session the message came from, so the
     * decisions and counters go to that tab. If the sender session is
     * null or matches no open tab (e.g. a message from the extension's
     * background page, which has no tab session), the decisions still
     * go back to the content script, but the counters/verdicts fall
     * back to the active tab — a message that cannot be attributed to
     * a tab must never be dropped, and attributing it to the active
     * tab is the least-wrong choice (the visible page is almost always
     * the sender).
     */
    private val filterMessageDelegate = object : WebExtension.MessageDelegate {
        override fun onMessage(
            nativeApp: String,
            message: Any,
            sender: WebExtension.MessageSender
        ): GeckoResult<Any>? {
            val json = message as? JSONObject ?: return null
            return when (json.optString("type")) {
                "scan" -> handleScanMessage(json, sender)
                "review" -> handleReviewMessage(json, sender)
                else -> null
            }
        }
    }

    /** Resolve the tab a message came from (see filterMessageDelegate). */
    private fun tabForSender(sender: WebExtension.MessageSender): Tab? {
        val senderSession = sender.session
        return if (senderSession != null) {
            tabs.firstOrNull { it.session === senderSession } ?: activeTab()
        } else {
            activeTab()
        }
    }

    /** Review-cache key for a finding: the key the content script
     *  sent ('u:' + sha256 of the canonical URL), or — when the
     *  script sent none (the pre-sync Android script) — a key
     *  computed here from the thumbnail bytes ('b:') or, with no
     *  thumbnail at all, from the source URL ('u:'). Null when
     *  there is nothing to key on. */
    private fun imageKeyForFinding(finding: ScanFinding): String? {
        finding.imageKey?.takeIf { it.isNotBlank() }?.let { return it }
        val thumb = finding.thumbnailDataUrl
        if (thumb != null) {
            val bytes = RfDetrPersonDetector.decodeDataUrl(thumb)
            if (bytes != null) return FilterEngine.imageKeyForContent(bytes)
        }
        val source = finding.sourceUrl?.takeIf { it.isNotBlank() } ?: return null
        return FilterEngine.imageKeyForUrl(source)
    }

    /** Attach locally recorded review decisions to findings that do
     *  not already carry one from the content script, so the engine
     *  honours a reviewed image verbatim on later scans instead of
     *  re-deciding it. The content script's own cachedDecision (when
     *  present) wins — it is the freshest copy of the same record. */
    private fun enrichWithCachedDecisions(
        findings: List<ScanFinding>
    ): List<ScanFinding> {
        return findings.map { finding ->
            if (finding.cachedDecision != null) {
                finding
            } else {
                val key = imageKeyForFinding(finding) ?: return@map finding
                val stored = try {
                    reviewDecisionStore.lookup(key)
                } catch (_: Exception) {
                    null
                } ?: return@map finding
                finding.copy(cachedDecision = stored.toCachedDecision())
            }
        }
    }

    private fun handleScanMessage(
        json: JSONObject,
        sender: WebExtension.MessageSender
    ): GeckoResult<Any>? {
        val parsed = try {
            FilterEngine.parseScanMessage(json)
        } catch (e: IllegalArgumentException) {
            // Malformed scan message: do NOT guess — reply nothing, the
            // content script keeps everything covered and retries.
            return null
        }
        val findings = enrichWithCachedDecisions(parsed)
        val decisions = engine.decideAll(findings, policy)
        val tab = tabForSender(sender)
        if (tab != null) {
            tab.findingsById = HashMap<String, ScanFinding>().also { map ->
                for (finding in findings) map[finding.elementId] = finding
            }
            for ((finding, decision) in findings.zip(decisions)) {
                finding.sourceUrl?.let { tab.verdicts[it] = decision.verdict }
            }
            runOnUiThread {
                for (d in decisions) {
                    when (d.verdict) {
                        Verdict.ALLOW, Verdict.PAINTED -> tab.allowedCount++
                        Verdict.BLOCK -> tab.blockedCount++
                        Verdict.COVER, Verdict.REVIEW -> tab.coveredCount++
                    }
                }
                if (tab === activeTab()) updateFilterStatus()
            }
        }
        val reply = FilterEngine.buildDecisionsMessage(decisions)
        @Suppress("UNCHECKED_CAST")
        return GeckoResult.fromValue(reply) as GeckoResult<Any>
    }

    /**
     * Second-stage review for one covered image (Yakob req 2 + 3).
     * The content script sends {type:'review', id, source, imageKey}
     * when the user taps the request button on a covered image.
     * Runs on the message-delegate (background) thread — RF-DETR
     * inference (~0.3 s) never touches the UI thread.
     *
     * Order:
     *  1. Find the finding by id (any tab's last scan). Unknown id,
     *     or a finding with no thumbnail to run on -> reply
     *     'uncertain' (stays covered; a review NEVER unblocks by
     *     itself on failure).
     *  2. A recorded decision for the image key — local store first,
     *     then the server (GET /api/v1/review-decisions) — is
     *     replied verbatim, without re-running the model.
     *  3. Otherwise run RF-DETR on the thumbnail: best person score
     *     + person boxes -> [FilterEngine.reviewDecision] with the
     *     effective human-image mode.
     *  4. Record the outcome locally (always) and on the server
     *     (when registered; a failed POST never blocks or undoes the
     *     UI decision — the local store is the fallback), under the
     *     'u:' key the script sent and the 'b:' content-hash key.
     * Reply: {type:'review-decision', id, decision, boxes, best,
     * model:'rf-detr-nano', reason, contentHash} — decision in
     * allow | allow_painted | block | uncertain; contentHash is the
     * bare sha256 hex of the reviewed bytes, so the script can also
     * cache under 'b:' + contentHash.
     */
    private fun handleReviewMessage(
        json: JSONObject,
        sender: WebExtension.MessageSender
    ): GeckoResult<Any>? {
        val id = json.optString("id", "").ifBlank { return null }
        val reply = JSONObject()
            .put("type", "review-decision")
            .put("id", id)
        fun uncertainReply(reason: String): GeckoResult<Any> {
            reply.put("decision", "uncertain")
                .put("boxes", org.json.JSONArray())
                .put("best", 0.0)
                .put("model", "rf-detr-nano")
                .put("reason", reason)
            @Suppress("UNCHECKED_CAST")
            return GeckoResult.fromValue(reply) as GeckoResult<Any>
        }
        // 1. The finding (any tab — the review button belongs to the
        //    page that reported it, which may not be the active tab).
        val finding = tabs.asSequence()
            .mapNotNull { it.findingsById[id] }
            .firstOrNull()
            ?: return uncertainReply("no finding for this image")
        val mode = policy.humanImageMode ?: settingsStore.settings.humanImageMode
        val imageKey = json.optString("imageKey", "").ifBlank { null }
            ?: imageKeyForFinding(finding)
        // 2. Already reviewed? Local store first, then the server.
        if (imageKey != null) {
            val stored = try {
                reviewDecisionStore.lookup(imageKey)
            } catch (_: Exception) {
                null
            }
            if (stored != null) {
                return reviewReply(reply, stored.decision, stored.boxes,
                    stored.bestScore, "reviewed earlier", null)
            }
            val serverRecord = lookupServerReview(imageKey)
            if (serverRecord != null) {
                saveLocalReview(serverRecord, finding)
                return reviewReply(reply, serverRecord.decision,
                    serverRecord.boxes, serverRecord.bestScore,
                    "reviewed earlier (server)", null)
            }
        }
        // 3. Run RF-DETR on the thumbnail.
        val thumbBytes = finding.thumbnailDataUrl?.let {
            RfDetrPersonDetector.decodeDataUrl(it)
        } ?: return uncertainReply("no thumbnail to review")
        val image = try {
            rfDetrBackend.decodeJpeg(thumbBytes)
        } catch (_: Throwable) {
            null
        } ?: return uncertainReply("thumbnail could not be decoded")
        val detections = try {
            rfDetrBackend.personDetections(image)
        } catch (_: Throwable) {
            null
        } ?: return uncertainReply("review model unavailable")
        val decision = FilterEngine.reviewDecision(
            detections.bestScore, detections.boxes, mode
        )
        val contentHash = FilterEngine.sha256Hex(thumbBytes)
        val firstSignal = when {
            finding.persons > 0 -> "efficientdet"
            finding.faces > 0 -> "face-api"
            else -> "none"
        }
        // 4. Record locally (always) and on the server (best-effort).
        val stored = StoredReviewDecision(
            imageKey = imageKey ?: FilterEngine.imageKeyForContent(thumbBytes),
            decision = decision,
            boxes = detections.boxes,
            bestScore = detections.bestScore,
            humanImageMode = mode,
            imageUrl = finding.sourceUrl,
            pageUrl = finding.pageUrl.ifBlank { null },
            recordedAt = System.currentTimeMillis()
        )
        try {
            reviewDecisionStore.save(stored)
        } catch (_: Exception) {
            // Local save failing must not undo the review reply.
        }
        recordServerReview(stored, firstSignal)
        return reviewReply(reply, decision, detections.boxes,
            detections.bestScore, reviewReason(decision, detections), contentHash)
    }

    /** Build a review-decision reply object (shared by the
     *  already-reviewed and freshly-reviewed paths). */
    private fun reviewReply(
        reply: JSONObject,
        decision: ReviewDecision,
        boxes: List<PersonBox>,
        best: Double,
        reason: String,
        contentHash: String?
    ): GeckoResult<Any> {
        reply.put("decision", ReviewDecision.wireName(decision))
            .put("boxes", FilterEngine.boxesToJson(boxes))
            .put("best", best)
            .put("model", "rf-detr-nano")
            .put("reason", reason)
        if (contentHash != null) reply.put("contentHash", contentHash)
        @Suppress("UNCHECKED_CAST")
        return GeckoResult.fromValue(reply) as GeckoResult<Any>
    }

    /** Human-readable reason for a fresh review outcome (shown by
     *  the content script; also the audit trail in the record). */
    private fun reviewReason(
        decision: ReviewDecision,
        detections: RfDetrDetections
    ): String = when (decision) {
        ReviewDecision.ALLOW ->
            "review: no person (best score ${detections.bestScore})"
        ReviewDecision.ALLOW_PAINTED ->
            "review: person confirmed (best score ${detections.bestScore}), " +
                "person painted over"
        ReviewDecision.BLOCK ->
            "review: person confirmed (best score ${detections.bestScore}), " +
                "whole image blocked"
        ReviewDecision.UNCERTAIN ->
            "review: uncertain (best score ${detections.bestScore}), stays covered"
    }

    /** Server lookup for a recorded decision (GET). Null when the
     *  device is not registered, offline, or the server has no
     *  decision for the key — all normal, never fatal. */
    private fun lookupServerReview(imageKey: String): ReviewDecisionRecord? {
        if (store.deviceId.isNullOrBlank() || store.apiToken.isNullOrBlank()) {
            return null
        }
        return try {
            ApiClient(store.baseUrl, store.apiToken).getReviewDecision(imageKey)
        } catch (_: Exception) {
            null
        }
    }

    /** Save a server record into the local store (same shape the
     *  engine honours), so the next scan needs no network. */
    private fun saveLocalReview(
        record: ReviewDecisionRecord,
        finding: ScanFinding
    ) {
        try {
            reviewDecisionStore.save(
                StoredReviewDecision(
                    imageKey = record.imageKey,
                    decision = record.decision,
                    boxes = record.boxes,
                    bestScore = record.bestScore,
                    humanImageMode = record.humanImageMode,
                    imageUrl = record.imageUrl ?: finding.sourceUrl,
                    pageUrl = record.pageUrl ?: finding.pageUrl.ifBlank { null },
                    recordedAt = System.currentTimeMillis()
                )
            )
        } catch (_: Exception) {
            // Best-effort; the server still holds the record.
        }
    }

    /** POST a fresh review decision to the server. Fire-and-forget:
     *  any failure is swallowed — the local store already holds the
     *  decision, and a failed POST must never block or undo the UI
     *  decision. Only when the device is registered. */
    private fun recordServerReview(stored: StoredReviewDecision, firstSignal: String) {
        if (store.deviceId.isNullOrBlank() || store.apiToken.isNullOrBlank()) return
        try {
            ApiClient(store.baseUrl, store.apiToken).recordReviewDecision(
                ReviewDecisionRecord(
                    imageKey = stored.imageKey,
                    imageUrl = stored.imageUrl,
                    pageUrl = stored.pageUrl,
                    decision = stored.decision,
                    bestScore = stored.bestScore,
                    boxes = stored.boxes,
                    humanImageMode = stored.humanImageMode,
                    firstSignal = firstSignal
                )
            )
        } catch (_: Exception) {
            // Swallowed by design (see above).
        }
    }

    /** Status line: the ACTIVE tab's counters (each tab counts its own).
     *  When the runtime failed to start, the failure message stays —
     *  it is more important than the counters. */
    private fun updateFilterStatus() {
        if (!::filterStatusText.isInitialized) return
        if (!runtimeReady) return
        val tab = activeTab()
        if (tab == null) {
            filterStatusText.text = "Filter: no tab  (policy: ${policy.name})"
            return
        }
        filterStatusText.text =
            "Filter: ${tab.coveredCount} covered • ${tab.allowedCount} allowed • ${tab.blockedCount} blocked" +
                "  (policy: ${policy.name})"
    }

    // ------------------------------------------------------------- policy

    /**
     * The effective policy the engine decides against: the server
     * policy when one was fetched, with the server's human-image
     * mode when the server specified one — otherwise the LOCAL
     * setting from Settings (SettingsStore). With no server policy
     * at all (not registered / offline), the fail-closed local
     * default with the local human-image mode. So: the server mode
     * wins when present; the local setting is authoritative when
     * there is no server fetch or the server sent no mode.
     */
    private fun effectivePolicy(): Policy {
        val localMode = try {
            settingsStore.settings.humanImageMode
        } catch (_: Exception) {
            HumanImageMode.PAINT
        }
        val server = serverPolicy
        return if (server != null) {
            server.copy(humanImageMode = server.humanImageMode ?: localMode)
        } else {
            FilterEngine.DEFAULT_POLICY.copy(humanImageMode = localMode)
        }
    }

    /** Load the device's server policy when registered; otherwise keep the
     *  fail-closed local default. Never fails the browser: on any error the
     *  default policy stays in force. */
    private fun loadPolicy() {
        val policyId = store.policyId
        if (policyId.isNullOrBlank() || store.deviceId.isNullOrBlank()) {
            policy = effectivePolicy()
            return
        }
        thread {
            try {
                val p = ApiClient(store.baseUrl, store.apiToken).getPolicy(policyId)
                serverPolicy = p
                policy = effectivePolicy()
                runOnUiThread { updateFilterStatus() }
            } catch (_: Exception) {
                // Offline / bad token: keep DEFAULT_POLICY (fail closed).
            }
        }
    }
}
