// Filter Platform — browser screens: History.
//
// Programmatic UI only (no XML layouts — build.sh's aapt2 step compiles
// only activity_main.xml, activity_browser.xml and strings.xml), plain
// Activity, in the style of MainActivity.kt (views built in code,
// background thread for store I/O, errors shown on screen, never a crash
// on empty / missing data).
//
// Uses the real BrowserData.kt (same package):
//   data class HistoryEntry(val url: String, val title: String,
//                           val visitedAt: Long)   // epoch millis
//   class HistoryStore(storage: BrowserStorage)   // all() newest first,
//     search(query), clear(). Constructed here with
//     FileBrowserStorage(filesDir) — one JSON file per store key, a
//     missing / unreadable file loads as empty, so a fresh store is
//     built on every load (the browser may have written while this
//     screen was paused; a fresh store re-reads the file).
package com.filterplatform.app

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.concurrent.thread

class HistoryActivity : Activity() {

    private lateinit var listContainer: LinearLayout
    private lateinit var statusText: TextView
    private lateinit var clearButton: Button
    private lateinit var searchInput: EditText

    private var clearArmed = false
    private var currentQuery = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 32, 32, 32)
        }

        val header = TextView(this).apply {
            text = "History"
            textSize = 22f
        }
        root.addView(header)

        statusText = TextView(this).apply {
            text = ""
            setPadding(0, 8, 0, 8)
        }
        root.addView(statusText)

        searchInput = EditText(this).apply {
            hint = "Search history"
            setSingleLine(true)
        }
        searchInput.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable?) {
                currentQuery = s?.toString()?.trim() ?: ""
                clearArmed = false
                clearButton.text = "Clear history"
                loadEntries()
            }
        })
        root.addView(searchInput)

        clearButton = Button(this).apply { text = "Clear history" }
        clearButton.setOnClickListener { onClearPressed() }
        root.addView(clearButton)

        val scroll = ScrollView(this)
        listContainer = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }
        scroll.addView(listContainer)
        root.addView(scroll, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))

        setContentView(root)
        loadEntries()
    }

    override fun onResume() {
        super.onResume()
        // The user may have visited pages since this screen was last shown.
        if (::listContainer.isInitialized) loadEntries()
    }

    /** Fresh store on every load, so edits made by the browser while
     *  this screen was paused are picked up (stores keep an in-memory
     *  copy loaded at construction). */
    private fun newStore(): HistoryStore =
        HistoryStore(FileBrowserStorage(filesDir))

    /** Load (and filter) on a background thread; render on the UI thread. */
    private fun loadEntries() {
        val query = currentQuery
        thread {
            val entries = try {
                val raw = newStore().let { store ->
                    if (query.isBlank()) store.all() else store.search(query)
                }
                // Newest first, whatever order the store returns.
                raw.sortedByDescending { it.visitedAt }
            } catch (t: Throwable) {
                runOnUiThread {
                    statusText.text = "Could not load history: ${t.message ?: t.javaClass.simpleName}"
                }
                return@thread
            }
            runOnUiThread { render(entries) }
        }
    }

    private fun render(entries: List<HistoryEntry>) {
        listContainer.removeAllViews()
        if (entries.isEmpty()) {
            val empty = TextView(this).apply {
                text = if (currentQuery.isBlank()) "No history yet."
                else "No history matches \"$currentQuery\"."
                setPadding(0, 24, 0, 0)
            }
            listContainer.addView(empty)
            return
        }
        val dateFormat = SimpleDateFormat("MMM d, yyyy HH:mm", Locale.getDefault())
        for (entry in entries) {
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(0, 16, 0, 16)
                isClickable = true
            }
            val titleView = TextView(this).apply {
                text = entry.title.ifBlank { entry.url }
                textSize = 16f
            }
            val urlView = TextView(this).apply {
                text = entry.url
                textSize = 13f
            }
            val dateView = TextView(this).apply {
                text = try {
                    dateFormat.format(Date(entry.visitedAt))
                } catch (_: Throwable) {
                    ""
                }
                textSize = 12f
            }
            row.addView(titleView)
            row.addView(urlView)
            row.addView(dateView)
            row.setOnClickListener { openInBrowser(entry.url) }
            listContainer.addView(row)
        }
    }

    /** Two-tap confirm: first tap arms, second tap really clears. */
    private fun onClearPressed() {
        if (!clearArmed) {
            clearArmed = true
            clearButton.text = "Tap again to confirm — delete all history"
            statusText.text = "This deletes every history entry on this device."
            return
        }
        clearArmed = false
        clearButton.text = "Clear history"
        thread {
            try {
                newStore().clear()
                runOnUiThread {
                    statusText.text = "History cleared."
                    loadEntries()
                }
            } catch (t: Throwable) {
                runOnUiThread {
                    statusText.text = "Could not clear history: ${t.message ?: t.javaClass.simpleName}"
                }
            }
        }
    }

    /** Opens the URL in the browser. BrowserActivity (reworked in parallel)
     *  reads the "open_url" extra on launch and loads it instead of home. */
    private fun openInBrowser(url: String) {
        val intent = Intent(this, BrowserActivity::class.java)
            .putExtra("open_url", url)
        startActivity(intent)
    }
}
