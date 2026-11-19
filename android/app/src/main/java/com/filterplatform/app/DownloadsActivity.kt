// Filter Platform — browser screens: Downloads.
//
// Programmatic UI only (no XML layouts), plain Activity, in the style of
// MainActivity.kt. Lists DownloadRecord rows from DownloadStore; every
// row's live status/size is re-read from DownloadManager when the screen
// opens (records stored earlier may be stale). Tap a row's Open button
// to view the file; Delete removes it from DownloadManager AND the
// store; "Clear completed" removes finished downloads from both.
//
// Uses the real BrowserData.kt (same package):
//   data class DownloadRecord(val id: Long, val url: String,
//       val fileName: String, val status: String, val bytesDownloaded: Long,
//       val totalBytes: Long, val createdAt: Long)
//   class DownloadStore(storage: BrowserStorage)
//     fun list(): List<DownloadRecord>   // newest first
//     fun remove(id: Long): Boolean
//     fun clearCompleted(): Int
//     fun updateProgress(id: Long, bytesDownloaded: Long, status: String)
//     companion STATUS_IN_PROGRESS / STATUS_COMPLETED / STATUS_FAILED /
//       STATUS_CANCELLED
// Constructed here with FileBrowserStorage(filesDir) — a fresh store is
// built on every load (the browser may have written while this screen
// was paused; a fresh store re-reads the file).
//
// DOWNLOADMANAGER MATCHING — DownloadRecord carries the DownloadManager
// id in downloadManagerId (stored by BrowserActivity.startDownload right
// after enqueueing). Rows are looked up by that id directly — no title
// matching, so two downloads of the same file name can never be mixed
// up. A record whose downloadManagerId is null (never enqueued, or an
// older record) is shown with its stored status and cannot be
// opened/deleted from the manager (the store record itself can still
// be deleted).
package com.filterplatform.app

import android.app.Activity
import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.Intent
import android.database.Cursor
import android.os.Bundle
import android.webkit.MimeTypeMap
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import kotlin.concurrent.thread

class DownloadsActivity : Activity() {

    private lateinit var listContainer: LinearLayout
    private lateinit var statusText: TextView

    /** One DownloadManager row, keyed by its manager id. */
    private data class ManagerRow(
        val managerId: Long,
        val status: Int,
        val bytesDownloaded: Long,
        val totalBytes: Long
    )

    /** Live DownloadManager state per record (keyed by record id). */
    private data class LiveState(
        val statusText: String,
        val isSuccessful: Boolean,
        val bytesDownloaded: Long,
        val totalBytes: Long,
        val managerId: Long?
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 32, 32, 32)
        }

        val header = TextView(this).apply {
            text = "Downloads"
            textSize = 22f
        }
        root.addView(header)

        statusText = TextView(this).apply {
            text = ""
            setPadding(0, 8, 0, 8)
        }
        root.addView(statusText)

        val clearCompletedButton = Button(this).apply { text = "Clear completed" }
        clearCompletedButton.setOnClickListener { clearCompleted() }
        root.addView(clearCompletedButton)

        val scroll = ScrollView(this)
        listContainer = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }
        scroll.addView(listContainer)
        root.addView(scroll, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))

        setContentView(root)
        loadDownloads()
    }

    override fun onResume() {
        super.onResume()
        // A download may have finished while this screen was in the back.
        if (::listContainer.isInitialized) loadDownloads()
    }

    /** Fresh store on every load, so edits made by the browser while
     *  this screen was paused are picked up (stores keep an in-memory
     *  copy loaded at construction). */
    private fun newStore(): DownloadStore =
        DownloadStore(FileBrowserStorage(filesDir))

    private fun loadDownloads() {
        thread {
            val store = try {
                newStore()
            } catch (t: Throwable) {
                runOnUiThread {
                    statusText.text = "Could not load downloads: ${t.message ?: t.javaClass.simpleName}"
                }
                return@thread
            }
            val records = try {
                store.list()
            } catch (t: Throwable) {
                runOnUiThread {
                    statusText.text = "Could not load downloads: ${t.message ?: t.javaClass.simpleName}"
                }
                return@thread
            }
            val managerRows = queryManagerRows()
            val live = HashMap<Long, LiveState>()
            for (record in records) {
                val row = record.downloadManagerId?.let { managerRows[it] }
                val state = liveState(record, row)
                live[record.id] = state
                // Write the live progress back into the store so the
                // stored record stops going stale. Best-effort only.
                if (row != null) {
                    try {
                        store.updateProgress(
                            record.id, state.bytesDownloaded,
                            when (row.status) {
                                DownloadManager.STATUS_SUCCESSFUL ->
                                    DownloadStore.STATUS_COMPLETED
                                DownloadManager.STATUS_FAILED ->
                                    DownloadStore.STATUS_FAILED
                                else -> DownloadStore.STATUS_IN_PROGRESS
                            }
                        )
                    } catch (_: Throwable) {
                    }
                }
            }
            runOnUiThread { render(records, live) }
        }
    }

    /** All DownloadManager downloads, keyed by manager id. Never
     *  throws; empty map when the manager is unreachable. */
    private fun queryManagerRows(): Map<Long, ManagerRow> {
        val out = HashMap<Long, ManagerRow>()
        val dm = try {
            getSystemService(DOWNLOAD_SERVICE) as? DownloadManager
        } catch (_: Throwable) {
            null
        } ?: return out
        var cursor: Cursor? = null
        try {
            cursor = dm.query(DownloadManager.Query())
            if (cursor == null) return out
            val idCol = cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_ID)
            val statusCol = cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS)
            val downloadedCol = cursor.getColumnIndexOrThrow(
                DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR)
            val totalCol = cursor.getColumnIndexOrThrow(
                DownloadManager.COLUMN_TOTAL_SIZE_BYTES)
            while (cursor.moveToNext()) {
                val managerId = try { cursor.getLong(idCol) } catch (_: Throwable) { continue }
                out[managerId] = ManagerRow(
                    managerId = managerId,
                    status = cursor.getInt(statusCol),
                    bytesDownloaded = cursor.getLong(downloadedCol),
                    totalBytes = cursor.getLong(totalCol)
                )
            }
        } catch (_: Throwable) {
            // Manager query failed: callers fall back to stored status.
        } finally {
            try { cursor?.close() } catch (_: Throwable) { }
        }
        return out
    }

    /** Live state for one record: the manager row when matched, else the
     *  stored record (status string mapped to display text). */
    private fun liveState(record: DownloadRecord, row: ManagerRow?): LiveState {
        if (row == null) {
            return LiveState(
                statusText = storedStatusText(record.status),
                isSuccessful = record.status == DownloadStore.STATUS_COMPLETED,
                bytesDownloaded = record.bytesDownloaded,
                totalBytes = record.totalBytes,
                managerId = null
            )
        }
        val text = when (row.status) {
            DownloadManager.STATUS_SUCCESSFUL -> "Completed"
            DownloadManager.STATUS_RUNNING -> "Downloading"
            DownloadManager.STATUS_PAUSED -> "Paused"
            DownloadManager.STATUS_PENDING -> "Pending"
            DownloadManager.STATUS_FAILED -> "Failed"
            else -> "Unknown (${row.status})"
        }
        return LiveState(
            statusText = text,
            isSuccessful = row.status == DownloadManager.STATUS_SUCCESSFUL,
            bytesDownloaded = row.bytesDownloaded,
            totalBytes = row.totalBytes,
            managerId = row.managerId
        )
    }

    private fun storedStatusText(status: String): String = when (status) {
        DownloadStore.STATUS_COMPLETED -> "Completed"
        DownloadStore.STATUS_IN_PROGRESS -> "Downloading"
        DownloadStore.STATUS_FAILED -> "Failed"
        DownloadStore.STATUS_CANCELLED -> "Cancelled"
        else -> status
    }

    private fun render(records: List<DownloadRecord>, live: Map<Long, LiveState>) {
        listContainer.removeAllViews()
        if (records.isEmpty()) {
            val empty = TextView(this).apply {
                text = "No downloads yet."
                setPadding(0, 24, 0, 0)
            }
            listContainer.addView(empty)
            return
        }
        for (record in records) {
            listContainer.addView(downloadRow(record, live[record.id]))
        }
    }

    private fun downloadRow(record: DownloadRecord, state: LiveState?): LinearLayout {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, 16, 0, 16)
        }
        val nameView = TextView(this).apply {
            text = record.fileName.ifBlank { record.url }
            textSize = 16f
        }
        val statusView = TextView(this).apply {
            text = state?.statusText ?: storedStatusText(record.status)
            textSize = 13f
        }
        val sizeView = TextView(this).apply {
            val downloaded = state?.bytesDownloaded ?: record.bytesDownloaded
            val total = state?.totalBytes ?: record.totalBytes
            text = if (total > 0) "${formatSize(downloaded)} of ${formatSize(total)}"
            else formatSize(downloaded)
            textSize = 13f
        }
        row.addView(nameView)
        row.addView(statusView)
        row.addView(sizeView)

        val buttons = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
        }
        val openButton = Button(this).apply { text = "Open" }
        openButton.setOnClickListener { openFile(record, state?.managerId) }
        val deleteButton = Button(this).apply { text = "Delete" }
        deleteButton.setOnClickListener { deleteDownload(record, state?.managerId) }
        buttons.addView(openButton)
        buttons.addView(deleteButton)
        row.addView(buttons)
        return row
    }

    private fun downloadManagerOrNull(): DownloadManager? {
        return try {
            getSystemService(DOWNLOAD_SERVICE) as? DownloadManager
        } catch (_: Throwable) {
            null
        }
    }

    private fun openFile(record: DownloadRecord, managerId: Long?) {
        val dm = downloadManagerOrNull()
        if (managerId == null || dm == null) {
            statusText.text = "Cannot open \"${record.fileName}\": " +
                "no matching download in DownloadManager."
            return
        }
        val uri = try {
            dm.getUriForDownloadedFile(managerId)
        } catch (_: Throwable) {
            null
        }
        if (uri == null) {
            statusText.text = "Cannot open \"${record.fileName}\": the downloaded file is no longer available."
            return
        }
        val extension = record.fileName.substringAfterLast(".", "").lowercase()
        val mime = MimeTypeMap.getSingleton()
            .getMimeTypeFromExtension(extension) ?: "*/*"
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, mime)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        try {
            startActivity(intent)
        } catch (_: ActivityNotFoundException) {
            statusText.text = "No app on this device can open \"${record.fileName}\"."
        } catch (t: Throwable) {
            statusText.text = "Could not open \"${record.fileName}\": ${t.message ?: t.javaClass.simpleName}"
        }
    }

    private fun deleteDownload(record: DownloadRecord, managerId: Long?) {
        thread {
            try {
                if (managerId != null) {
                    try { downloadManagerOrNull()?.remove(managerId) } catch (_: Throwable) { }
                }
                newStore().remove(record.id)
                runOnUiThread {
                    statusText.text = "Download deleted."
                    loadDownloads()
                }
            } catch (t: Throwable) {
                runOnUiThread {
                    statusText.text = "Could not delete download: ${t.message ?: t.javaClass.simpleName}"
                }
            }
        }
    }

    /** Remove every finished download from DownloadManager and the store. */
    private fun clearCompleted() {
        thread {
            val store = try {
                newStore()
            } catch (t: Throwable) {
                runOnUiThread {
                    statusText.text = "Could not load downloads: ${t.message ?: t.javaClass.simpleName}"
                }
                return@thread
            }
            val records = try {
                store.list()
            } catch (t: Throwable) {
                runOnUiThread {
                    statusText.text = "Could not load downloads: ${t.message ?: t.javaClass.simpleName}"
                }
                return@thread
            }
            // Remove the manager entries first (matched by the stored
            // DownloadManager id), then let the store drop its completed
            // records (it reports how many).
            val managerRows = queryManagerRows()
            val dm = downloadManagerOrNull()
            for (record in records) {
                val row = record.downloadManagerId?.let { managerRows[it] }
                val completed = row?.status == DownloadManager.STATUS_SUCCESSFUL ||
                    record.status == DownloadStore.STATUS_COMPLETED
                if (!completed || row == null || dm == null) continue
                try { dm.remove(row.managerId) } catch (_: Throwable) { }
            }
            val removed = try {
                store.clearCompleted()
            } catch (t: Throwable) {
                runOnUiThread {
                    statusText.text = "Could not clear completed downloads: ${t.message ?: t.javaClass.simpleName}"
                }
                return@thread
            }
            runOnUiThread {
                statusText.text = if (removed == 0) "No completed downloads to clear."
                else "Cleared $removed completed download${if (removed == 1) "" else "s"}."
                loadDownloads()
            }
        }
    }

    private fun formatSize(bytes: Long): String {
        if (bytes < 0) return "—"
        if (bytes < 1024) return "$bytes B"
        val units = arrayOf("KB", "MB", "GB")
        var value = bytes.toDouble()
        var unit = 0
        while (value >= 1024 && unit < units.size - 1) {
            value /= 1024
            unit++
        }
        // One decimal, without trailing ".0" (e.g. "12 KB", "3.4 MB").
        val rounded = (value * 10).toLong() / 10.0
        val text = if (rounded == rounded.toLong().toDouble()) "${rounded.toLong()}"
        else "$rounded"
        return "$text ${units[unit]}"
    }
}
