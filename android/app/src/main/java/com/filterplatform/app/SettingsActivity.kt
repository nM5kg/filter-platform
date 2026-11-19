// Filter Platform — browser screens: Settings.
//
// Programmatic UI only (no XML layouts), plain Activity, in the style of
// MainActivity.kt. Sections: search engine, homepage, privacy (clear
// browsing data), filter (current policy), about. Local data only — no
// account sync, no server sync of history / bookmarks.
//
// Uses the real BrowserData.kt (same package):
//   enum class SearchEngine { DUCKDUCKGO, GOOGLE, BING }
//   data class BrowserSettings(val searchEngine: SearchEngine,
//       val homepage: String, val desktopSiteDefault: Boolean)
//   class SettingsStore(storage: BrowserStorage)
//     var settings: BrowserSettings   // assigning persists immediately
//     fun save(newSettings: BrowserSettings)
//     companion DEFAULT_SETTINGS      // DuckDuckGo,
//       homepage https://filter-platform-dashboard.pages.dev
// Constructed here with FileBrowserStorage(filesDir); a missing or
// corrupt settings file yields the defaults (never a crash).
//
// GECKO DATA CLEARING — SettingsActivity has no GeckoRuntime (it lives
// in BrowserActivity), so "Clear cookies and site data" / "Clear cache"
// do NOT clear anything here. They OR their ClearFlags into
// pendingGeckoClear, put it in the result intent extra
// EXTRA_CLEAR_GECKO_FLAGS, and show a note that the browser clears the
// data when this screen closes. BrowserActivity must read that extra in
// its Settings result path and call
// BrowserDataCleaner.clearGeckoData(runtime, flags) — see
// BrowserDataCleaner.kt for the exact wiring. History and download
// records ARE cleared here directly (they are app-side stores).
package com.filterplatform.app

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.ScrollView
import android.widget.TextView
import kotlin.concurrent.thread

class SettingsActivity : Activity() {

    companion object {
        /** Result extra (Long, ClearFlags bitmask) for BrowserActivity:
         *  the Gecko data Settings asked to clear. 0 = nothing pending.
         *  See BrowserDataCleaner.kt for the wiring. */
        const val EXTRA_CLEAR_GECKO_FLAGS = "clear_gecko_flags"

        // App version, hardcoded: must match build.sh
        // --version-name 0.3.0 / --version-code 8 (update build.sh when
        // bumping this — build.sh still said 0.2.2 / 7 when this screen
        // was written, so the coordinator must bump it to 0.3.0 / 8).
        const val APP_VERSION = "0.3.0"
    }

    private var settingsStore: SettingsStore? = null
    private lateinit var statusText: TextView
    private lateinit var policyText: TextView
    private lateinit var homepageInput: EditText

    /** ClearFlags bitmask the browser still has to clear (cookies /
     *  cache). OR-ed in by the privacy buttons; sent back as the
     *  activity result. */
    private var pendingGeckoClear: Long = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        try {
            settingsStore = SettingsStore(FileBrowserStorage(filesDir))
        } catch (t: Throwable) {
            // Stores tolerate missing files, but if construction itself
            // fails the screen still opens with defaults and saving is
            // reported as failed instead of crashing.
            settingsStore = null
        }
        setResult(Activity.RESULT_OK, resultIntent())

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 32, 32, 32)
        }

        val header = TextView(this).apply {
            text = "Settings"
            textSize = 22f
        }
        root.addView(header)

        statusText = TextView(this).apply {
            text = ""
            setPadding(0, 8, 0, 8)
        }
        root.addView(statusText)

        val scroll = ScrollView(this)
        val body = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }
        scroll.addView(body)
        root.addView(scroll, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))

        buildSearchEngineSection(body)
        buildHomepageSection(body)
        buildPrivacySection(body)
        buildFilterSection(body)
        buildAboutSection(body)

        val doneButton = Button(this).apply { text = "Done — back to browser" }
        doneButton.setOnClickListener { finish() }
        root.addView(doneButton)

        setContentView(root)
        loadPolicyRow()
    }

    // ------------------------------------------------------------ sections

    private fun sectionHeader(parent: LinearLayout, title: String) {
        parent.addView(TextView(this).apply {
            text = title
            textSize = 18f
            setPadding(0, 32, 0, 8)
        })
    }

    /** Current settings, or the defaults when the store is unavailable. */
    private fun currentSettings(): BrowserSettings {
        return try {
            settingsStore?.settings
        } catch (_: Throwable) {
            null
        } ?: SettingsStore.DEFAULT_SETTINGS
    }

    private fun buildSearchEngineSection(parent: LinearLayout) {
        sectionHeader(parent, "Search engine")
        val group = RadioGroup(this).apply {
            orientation = RadioGroup.VERTICAL
        }
        val options = listOf(
            "DuckDuckGo" to SearchEngine.DUCKDUCKGO,
            "Google" to SearchEngine.GOOGLE,
            "Bing" to SearchEngine.BING
        )
        val current = currentSettings().searchEngine
        for ((label, engine) in options) {
            val radio = RadioButton(this).apply {
                text = label + if (engine == SearchEngine.DUCKDUCKGO) " (default)" else ""
                isChecked = engine == current
                setOnClickListener { saveSearchEngine(engine) }
            }
            group.addView(radio)
        }
        parent.addView(group)
    }

    private fun buildHomepageSection(parent: LinearLayout) {
        sectionHeader(parent, "Homepage")
        homepageInput = EditText(this).apply {
            setText(currentSettings().homepage)
            hint = "https://…"
            setSingleLine(true)
        }
        parent.addView(homepageInput)
        val saveButton = Button(this).apply { text = "Save homepage" }
        saveButton.setOnClickListener { saveHomepage() }
        parent.addView(saveButton)
    }

    private fun buildPrivacySection(parent: LinearLayout) {
        sectionHeader(parent, "Privacy — clear browsing data")

        val clearHistoryButton = Button(this).apply { text = "Clear history" }
        clearHistoryButton.setOnClickListener { clearHistory() }
        parent.addView(clearHistoryButton)

        val clearCookiesButton = Button(this).apply { text = "Clear cookies and site data" }
        clearCookiesButton.setOnClickListener {
            pendingGeckoClear = pendingGeckoClear or BrowserDataCleaner.FLAGS_COOKIES_AND_SITE_DATA
            setResult(Activity.RESULT_OK, resultIntent())
            statusText.text = "Cookies and site data will be cleared when you return to the browser."
        }
        parent.addView(clearCookiesButton)

        val clearCacheButton = Button(this).apply { text = "Clear cache" }
        clearCacheButton.setOnClickListener {
            pendingGeckoClear = pendingGeckoClear or BrowserDataCleaner.FLAGS_CACHE
            setResult(Activity.RESULT_OK, resultIntent())
            statusText.text = "Cache will be cleared when you return to the browser."
        }
        parent.addView(clearCacheButton)

        val clearDownloadsButton = Button(this).apply { text = "Clear download records" }
        clearDownloadsButton.setOnClickListener { clearDownloadRecords() }
        parent.addView(clearDownloadsButton)

        parent.addView(TextView(this).apply {
            text = "Cookies, site data and cache are held by the browser engine — " +
                "they are cleared when you go back to the browser (see the note " +
                "above each button). History and download records are cleared here."
            textSize = 13f
            setPadding(0, 8, 0, 0)
        })
    }

    private fun buildFilterSection(parent: LinearLayout) {
        sectionHeader(parent, "Filter")
        policyText = TextView(this).apply {
            text = "Loading policy…"
            setPadding(0, 0, 0, 8)
        }
        parent.addView(policyText)
        val deviceButton = Button(this).apply { text = "Device / policy screen" }
        deviceButton.setOnClickListener {
            startActivity(Intent(this, MainActivity::class.java))
        }
        parent.addView(deviceButton)
    }

    private fun buildAboutSection(parent: LinearLayout) {
        sectionHeader(parent, "About")
        val lines = listOf(
            "Filter Platform $APP_VERSION",
            "GeckoView 160.0.20261116130455 (MPL-2.0)",
            "Mozilla Android Components 160.0.1 (MPL-2.0)",
            "RF-DETR Nano person detection (Apache 2.0)",
            "EfficientDet-Lite0 — prototype only, weights license unverified",
            "ONNX Runtime 1.32.0 (MIT)",
            "All browsing data stays on this device (no sync)."
        )
        for (line in lines) {
            parent.addView(TextView(this).apply {
                text = line
                textSize = 14f
                setPadding(0, 4, 0, 4)
            })
        }
    }

    // ------------------------------------------------------------ actions

    private fun resultIntent(): Intent =
        Intent().putExtra(EXTRA_CLEAR_GECKO_FLAGS, pendingGeckoClear)

    private fun saveSearchEngine(engine: SearchEngine) {
        val store = settingsStore
        if (store == null) {
            statusText.text = "Could not save search engine: settings storage is unavailable."
            return
        }
        try {
            store.save(store.settings.copy(searchEngine = engine))
            statusText.text = "Search engine saved."
        } catch (t: Throwable) {
            statusText.text = "Could not save search engine: ${t.message ?: t.javaClass.simpleName}"
        }
    }

    private fun saveHomepage() {
        var url = homepageInput.text.toString().trim()
        if (url.isBlank()) {
            statusText.text = "Homepage cannot be blank."
            return
        }
        if (!url.contains("://")) url = "https://$url"
        val store = settingsStore
        if (store == null) {
            statusText.text = "Could not save homepage: settings storage is unavailable."
            return
        }
        try {
            store.save(store.settings.copy(homepage = url))
            homepageInput.setText(url)
            statusText.text = "Homepage saved."
        } catch (t: Throwable) {
            statusText.text = "Could not save homepage: ${t.message ?: t.javaClass.simpleName}"
        }
    }

    private fun clearHistory() {
        thread {
            try {
                HistoryStore(FileBrowserStorage(filesDir)).clear()
                runOnUiThread { statusText.text = "History cleared." }
            } catch (t: Throwable) {
                runOnUiThread {
                    statusText.text = "Could not clear history: ${t.message ?: t.javaClass.simpleName}"
                }
            }
        }
    }

    private fun clearDownloadRecords() {
        thread {
            try {
                val store = DownloadStore(FileBrowserStorage(filesDir))
                var removed = 0
                for (record in store.list()) {
                    try {
                        if (store.remove(record.id)) removed++
                    } catch (_: Throwable) {
                        // One bad record must not stop the rest.
                    }
                }
                runOnUiThread {
                    statusText.text = if (removed == 0) "No download records to clear."
                    else "Cleared $removed download record${if (removed == 1) "" else "s"}."
                }
            } catch (t: Throwable) {
                runOnUiThread {
                    statusText.text = "Could not clear download records: ${t.message ?: t.javaClass.simpleName}"
                }
            }
        }
    }

    /**
     * Filter row: the current policy name + auto-decide threshold.
     * Only fetches from the server when the device is actually
     * registered (policyId + token present) — never with a missing
     * token. Otherwise shows the local fail-closed default policy
     * (FilterEngine.DEFAULT_POLICY: threshold 0.70) with no network.
     */
    private fun loadPolicyRow() {
        val secure: SecureStore? = try {
            SecureStore(this)
        } catch (_: Throwable) {
            null
        }
        if (secure == null) {
            showDefaultPolicy("(local default — device not registered)")
            return
        }
        val policyId: String? = secure.policyId
        val token: String? = secure.apiToken
        if (policyId.isNullOrBlank() || token.isNullOrBlank()) {
            showDefaultPolicy("(local default — device not registered)")
            return
        }
        val baseUrl = secure.baseUrl
        thread {
            try {
                val p = ApiClient(baseUrl, token).getPolicy(policyId)
                runOnUiThread {
                    policyText.text = "Policy: ${p.name}\nAuto-decide threshold: ${p.autoDecideThreshold}"
                }
            } catch (t: Throwable) {
                runOnUiThread {
                    showDefaultPolicy(
                        "(could not load server policy: ${t.message ?: t.javaClass.simpleName} — showing local default)"
                    )
                }
            }
        }
    }

    private fun showDefaultPolicy(note: String) {
        val d = FilterEngine.DEFAULT_POLICY
        policyText.text = "Policy: ${d.name}\nAuto-decide threshold: ${d.autoDecideThreshold}\n$note"
    }
}
