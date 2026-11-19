// Filter Platform — browser screens: Bookmarks.
//
// Programmatic UI only (no XML layouts), plain Activity, in the style of
// MainActivity.kt. Bookmarks are grouped by folder (folder header rows,
// via BookmarkStore.listByFolder() — "" = top level, sorted first); tap
// a bookmark to open it in the browser; per-row Edit / Delete buttons
// (plus long-press to edit) — no "Add current page" here, BrowserActivity
// owns bookmarking the page it shows.
//
// Uses the real BrowserData.kt (same package):
//   data class Bookmark(val id: String, val url: String, val title: String,
//                       val folder: String, val createdAt: Long)
//   class BookmarkStore(storage: BrowserStorage)
//     fun list(): List<Bookmark>                  // newest first
//     fun listByFolder(): Map<String, List<Bookmark>>
//     fun update(id: String, title: String, folder: String): Boolean
//     fun remove(id: String): Boolean
// Constructed here with FileBrowserStorage(filesDir) — a fresh store is
// built on every load (the browser may have written while this screen
// was paused; a fresh store re-reads the file).
package com.filterplatform.app

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import kotlin.concurrent.thread

class BookmarksActivity : Activity() {

    private lateinit var listContainer: LinearLayout
    private lateinit var statusText: TextView

    /** Which bookmark row is currently in edit mode (null = none). */
    private var editingId: String? = null
    /** Which bookmark row has its delete armed (two-tap confirm). */
    private var deleteArmedId: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 32, 32, 32)
        }

        val header = TextView(this).apply {
            text = "Bookmarks"
            textSize = 22f
        }
        root.addView(header)

        statusText = TextView(this).apply {
            text = ""
            setPadding(0, 8, 0, 8)
        }
        root.addView(statusText)

        val scroll = ScrollView(this)
        listContainer = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }
        scroll.addView(listContainer)
        root.addView(scroll, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))

        setContentView(root)
        loadBookmarks()
    }

    override fun onResume() {
        super.onResume()
        if (::listContainer.isInitialized) loadBookmarks()
    }

    /** Fresh store on every load, so edits made by the browser while
     *  this screen was paused are picked up (stores keep an in-memory
     *  copy loaded at construction). */
    private fun newStore(): BookmarkStore =
        BookmarkStore(FileBrowserStorage(filesDir))

    private fun loadBookmarks() {
        thread {
            val grouped = try {
                newStore().listByFolder()
            } catch (t: Throwable) {
                runOnUiThread {
                    statusText.text = "Could not load bookmarks: ${t.message ?: t.javaClass.simpleName}"
                }
                return@thread
            }
            runOnUiThread { render(grouped) }
        }
    }

    private fun render(grouped: Map<String, List<Bookmark>>) {
        listContainer.removeAllViews()
        if (grouped.values.all { it.isEmpty() }) {
            val empty = TextView(this).apply {
                text = "No bookmarks yet. Bookmark a page from the browser to see it here."
                setPadding(0, 24, 0, 0)
            }
            listContainer.addView(empty)
            return
        }
        // listByFolder() already sorts folders with "" first; entries
        // inside a folder are newest first. Sort entries by title here
        // for a stable reading order.
        for ((folder, entries) in grouped) {
            if (entries.isEmpty()) continue
            val header = TextView(this).apply {
                text = if (folder.isBlank()) "No folder" else folder
                textSize = 17f
                setPadding(0, 24, 0, 8)
            }
            listContainer.addView(header)
            for (bookmark in entries.sortedBy { it.title.lowercase() }) {
                if (bookmark.id == editingId) {
                    listContainer.addView(editRow(bookmark))
                } else {
                    listContainer.addView(bookmarkRow(bookmark))
                }
            }
        }
    }

    private fun bookmarkRow(bookmark: Bookmark): LinearLayout {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, 12, 0, 12)
            isClickable = true
        }
        val titleView = TextView(this).apply {
            text = bookmark.title.ifBlank { bookmark.url }
            textSize = 16f
        }
        val urlView = TextView(this).apply {
            text = bookmark.url
            textSize = 13f
        }
        row.addView(titleView)
        row.addView(urlView)

        val buttons = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
        }
        val editButton = Button(this).apply { text = "Edit" }
        editButton.setOnClickListener {
            editingId = bookmark.id
            deleteArmedId = null
            loadBookmarks()
        }
        val deleteButton = Button(this).apply {
            text = if (bookmark.id == deleteArmedId) "Tap again to delete" else "Delete"
        }
        deleteButton.setOnClickListener {
            if (bookmark.id == deleteArmedId) {
                deleteArmedId = null
                deleteBookmark(bookmark)
            } else {
                deleteArmedId = bookmark.id
                loadBookmarks()
            }
        }
        buttons.addView(editButton)
        buttons.addView(deleteButton)
        row.addView(buttons)

        row.setOnClickListener { openInBrowser(bookmark.url) }
        // Long-press is a second way into edit mode (same as Edit button).
        row.setOnLongClickListener {
            editingId = bookmark.id
            deleteArmedId = null
            loadBookmarks()
            true
        }
        return row
    }

    /** Inline edit: title + folder fields with Save / Cancel. */
    private fun editRow(bookmark: Bookmark): LinearLayout {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, 12, 0, 12)
        }
        val titleInput = EditText(this).apply {
            setText(bookmark.title)
            hint = "Title"
            setSingleLine(true)
        }
        val folderInput = EditText(this).apply {
            setText(bookmark.folder)
            hint = "Folder (blank = no folder)"
            setSingleLine(true)
        }
        row.addView(titleInput)
        row.addView(folderInput)

        val buttons = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
        }
        val saveButton = Button(this).apply { text = "Save" }
        saveButton.setOnClickListener {
            val title = titleInput.text.toString().trim().ifBlank { bookmark.url }
            val folder = folderInput.text.toString().trim()
            editingId = null
            thread {
                try {
                    val ok = newStore().update(bookmark.id, title, folder)
                    runOnUiThread {
                        statusText.text = if (ok) "Bookmark saved."
                        else "Bookmark no longer exists."
                        loadBookmarks()
                    }
                } catch (t: Throwable) {
                    runOnUiThread {
                        statusText.text = "Could not save bookmark: ${t.message ?: t.javaClass.simpleName}"
                        loadBookmarks()
                    }
                }
            }
        }
        val cancelButton = Button(this).apply { text = "Cancel" }
        cancelButton.setOnClickListener {
            editingId = null
            loadBookmarks()
        }
        buttons.addView(saveButton)
        buttons.addView(cancelButton)
        row.addView(buttons)
        return row
    }

    private fun deleteBookmark(bookmark: Bookmark) {
        thread {
            try {
                newStore().remove(bookmark.id)
                runOnUiThread {
                    statusText.text = "Bookmark deleted."
                    loadBookmarks()
                }
            } catch (t: Throwable) {
                runOnUiThread {
                    statusText.text = "Could not delete bookmark: ${t.message ?: t.javaClass.simpleName}"
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
