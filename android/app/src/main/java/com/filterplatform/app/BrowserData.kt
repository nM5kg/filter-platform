// Filter Platform — GeckoView browser prototype: pure-Kotlin data/state layer.
//
// This file is PURE Kotlin: no android.* imports (java.io.File, java.net
// and org.json only), so it is unit-testable on the JVM via
// manual-build/run-tests.sh, exactly like FilterEngine.kt.
//
// What lives here: the browser chrome's state — tabs, history, bookmarks,
// downloads, settings, omnibox resolution/suggestions, and the download
// policy that stops the filter being bypassed via downloads. The UI
// (BrowserActivity) owns the GeckoView session and calls into these
// stores; nothing here touches a view, a Context, or the network.
//
// Persistence: every store takes a [BrowserStorage]. On Android the
// activity passes FileBrowserStorage(filesDir); tests pass
// MemoryBrowserStorage. Private tabs are NEVER persisted (see [TabStore]).
package com.filterplatform.app

import java.io.File
import java.net.URLEncoder
import org.json.JSONArray
import org.json.JSONObject

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** Minimal key/value persistence behind every store in this file. */
interface BrowserStorage {
    fun load(key: String): String?
    fun save(key: String, value: String)
    fun delete(key: String)
}

/**
 * File-backed [BrowserStorage]: one JSON file per key inside [dir]
 * (the app's files dir on Android). Keys are sanitised to safe file
 * names; a missing or unreadable file loads as null.
 */
class FileBrowserStorage(private val dir: File) : BrowserStorage {
    private fun fileFor(key: String): File {
        val safe = key.map { c ->
            if (c.isLetterOrDigit() || c == '_' || c == '-' || c == '.') c else '_'
        }.joinToString("")
        return File(dir, "$safe.json")
    }

    override fun load(key: String): String? {
        val file = fileFor(key)
        if (!file.isFile) return null
        return try {
            file.readText(Charsets.UTF_8)
        } catch (_: Exception) {
            null
        }
    }

    override fun save(key: String, value: String) {
        try {
            dir.mkdirs()
            fileFor(key).writeText(value, Charsets.UTF_8)
        } catch (_: Exception) {
            // Persistence is best-effort: in-memory state keeps working
            // when the files dir is unavailable; nothing here throws.
        }
    }

    override fun delete(key: String) {
        try {
            fileFor(key).delete()
        } catch (_: Exception) {
            // Best-effort, see save().
        }
    }
}

/** In-memory [BrowserStorage] for tests (and for previews). */
class MemoryBrowserStorage : BrowserStorage {
    private val map = HashMap<String, String>()
    override fun load(key: String): String? = map[key]
    override fun save(key: String, value: String) {
        map[key] = value
    }
    override fun delete(key: String) {
        map.remove(key)
    }
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

/** One browser tab. [url]/[title] are null for a fresh blank tab. */
data class TabState(
    val id: String,
    val url: String?,
    val title: String?,
    val isPrivate: Boolean,
    val desktopSite: Boolean,
    val createdAt: Long
)

/**
 * Ordered tab list with a selection. Mutations persist automatically
 * (see [persist]).
 *
 * RESTORE RULE: [persist]/[serialize] write ONLY non-private tabs, and
 * [restore] only ever loads non-private tabs — a private tab is never
 * written to storage, so it can never come back after a relaunch.
 * [restore] is called by the constructor (launch restore) and can be
 * called again explicitly; it replaces the current non-private tabs
 * and drops any in-memory private tabs, so call it only at launch.
 */
class TabStore(private val storage: BrowserStorage) {
    companion object {
        const val STORAGE_KEY = "browser_tabs"
    }

    private val tabs = ArrayList<TabState>()
    private var selectedBacking: String? = null

    /** The selected tab's id, or null when there are no tabs. */
    val selectedId: String?
        get() = selectedBacking?.takeIf { id -> tabs.any { it.id == id } }

    init {
        restore()
    }

    /** Tabs in order (oldest first). */
    fun list(): List<TabState> = tabs.toList()

    /** The selected tab, or null. */
    fun selectedTab(): TabState? = tabs.firstOrNull { it.id == selectedId }

    /** Open a tab (blank when [url] is null) and select it. */
    fun newTab(url: String? = null, isPrivate: Boolean = false): TabState {
        val tab = TabState(
            id = java.util.UUID.randomUUID().toString(),
            url = url?.trim()?.ifBlank { null },
            title = null,
            isPrivate = isPrivate,
            desktopSite = false,
            createdAt = System.currentTimeMillis()
        )
        tabs.add(tab)
        selectedBacking = tab.id
        persist()
        return tab
    }

    /**
     * Close a tab. When the selected tab closes, the next tab at the
     * same position is selected, else the previous one, else none.
     * Returns false when no tab has [id].
     */
    fun closeTab(id: String): Boolean {
        val index = tabs.indexOfFirst { it.id == id }
        if (index < 0) return false
        val wasSelected = (selectedBacking == id)
        tabs.removeAt(index)
        if (wasSelected) {
            selectedBacking = when {
                tabs.isEmpty() -> null
                index < tabs.size -> tabs[index].id
                else -> tabs.last().id
            }
        }
        persist()
        return true
    }

    /** Select a tab. Returns false when no tab has [id]. */
    fun selectTab(id: String): Boolean {
        if (tabs.none { it.id == id }) return false
        selectedBacking = id
        persist()
        return true
    }

    /**
     * Move a tab to [toIndex] (clamped into range). Returns false when
     * no tab has [id].
     */
    fun moveTab(id: String, toIndex: Int): Boolean {
        val from = tabs.indexOfFirst { it.id == id }
        if (from < 0) return false
        val tab = tabs.removeAt(from)
        val clamped = toIndex.coerceIn(0, tabs.size)
        tabs.add(clamped, tab)
        persist()
        return true
    }

    /**
     * Update a tab's page state. Null arguments mean "unchanged"
     * (a tab's URL can therefore never be cleared back to null here —
     * close it and open a fresh tab instead). Returns false when no
     * tab has [id].
     */
    fun updateTab(
        id: String,
        url: String? = null,
        title: String? = null,
        desktopSite: Boolean? = null
    ): Boolean {
        val index = tabs.indexOfFirst { it.id == id }
        if (index < 0) return false
        val old = tabs[index]
        tabs[index] = old.copy(
            url = url ?: old.url,
            title = title ?: old.title,
            desktopSite = desktopSite ?: old.desktopSite
        )
        persist()
        return true
    }

    /** JSON for the non-private tabs + the selected id (private tabs excluded). */
    fun serialize(): String {
        val arr = JSONArray()
        for (tab in tabs) {
            if (tab.isPrivate) continue
            arr.put(
                JSONObject()
                    .put("id", tab.id)
                    .put("url", tab.url ?: JSONObject.NULL)
                    .put("title", tab.title ?: JSONObject.NULL)
                    .put("isPrivate", false)
                    .put("desktopSite", tab.desktopSite)
                    .put("createdAt", tab.createdAt)
            )
        }
        return JSONObject()
            .put("selectedId", selectedId ?: JSONObject.NULL)
            .put("tabs", arr)
            .toString()
    }

    /** Parse [serialize] output (or any equivalent JSON). Malformed JSON
     *  yields an empty list, never an exception; private tabs in the
     *  input are dropped defensively. */
    fun deserialize(json: String): List<TabState> {
        return try {
            val root = JSONObject(json)
            val arr = root.optJSONArray("tabs") ?: return emptyList()
            val out = ArrayList<TabState>(arr.length())
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                if (o.optBoolean("isPrivate", false)) continue
                out.add(
                    TabState(
                        id = o.optString("id", ""),
                        url = if (o.isNull("url")) null else o.optString("url"),
                        title = if (o.isNull("title")) null else o.optString("title"),
                        isPrivate = false,
                        desktopSite = o.optBoolean("desktopSite", false),
                        createdAt = o.optLong("createdAt", 0L)
                    )
                )
            }
            out.filter { it.id.isNotBlank() }
        } catch (_: Exception) {
            emptyList()
        }
    }

    /** Write the non-private tabs to storage. */
    fun persist() {
        storage.save(STORAGE_KEY, serialize())
    }

    /** Replace the current tabs with the persisted non-private tabs
     *  (selected id restored when it still exists, else the first tab).
     *  An empty/missing/corrupt store leaves zero tabs. */
    fun restore() {
        val json = storage.load(STORAGE_KEY) ?: run {
            tabs.clear()
            selectedBacking = null
            return
        }
        val restored = deserialize(json)
        tabs.clear()
        tabs.addAll(restored)
        val savedSelected = try {
            val sel = JSONObject(json).optString("selectedId", "")
            sel.ifBlank { null }
        } catch (_: Exception) {
            null
        }
        selectedBacking = when {
            savedSelected != null && tabs.any { it.id == savedSelected } -> savedSelected
            tabs.isNotEmpty() -> tabs.first().id
            else -> null
        }
    }
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/** One recorded visit. [visitedAt] is epoch millis. */
data class HistoryEntry(
    val url: String,
    val title: String,
    val visitedAt: Long
)

/** One host's visit count, as returned by [HistoryStore.topSites]. */
data class TopSite(val host: String, val visits: Int)

/**
 * Browsing history (a visit log: every [record] appends an entry, so
 * repeat visits count towards [topSites]).
 *
 * Only http(s) pages are recorded — blank, data:, about:, and other
 * non-http(s) URLs are ignored. Entries are capped at [maxEntries];
 * the oldest visits are dropped first. [all]/[search] return entries
 * newest first.
 */
class HistoryStore(
    private val storage: BrowserStorage,
    private val maxEntries: Int = 500
) {
    companion object {
        const val STORAGE_KEY = "browser_history"
    }

    private val entries = ArrayList<HistoryEntry>()

    init {
        loadFromStorage()
    }

    /** Record a visit. Returns false when the URL is ignored (see above). */
    fun record(url: String, title: String): Boolean {
        val clean = url.trim()
        val lower = clean.lowercase()
        if (clean.isBlank()) return false
        if (!lower.startsWith("http://") && !lower.startsWith("https://")) return false
        entries.add(HistoryEntry(clean, title.trim(), System.currentTimeMillis()))
        while (entries.size > maxEntries) entries.removeAt(0)
        persist()
        return true
    }

    /** All entries, newest first. */
    fun all(): List<HistoryEntry> = entries.reversed()

    /**
     * Case-insensitive substring match over url + title, newest first.
     * A blank query returns everything ([all]).
     */
    fun search(query: String): List<HistoryEntry> {
        val q = query.trim().lowercase()
        if (q.isBlank()) return all()
        return entries.reversed().filter {
            it.url.lowercase().contains(q) || it.title.lowercase().contains(q)
        }
    }

    /** Most-visited hosts, most visits first (ties broken by host name). */
    fun topSites(limit: Int): List<TopSite> {
        val counts = HashMap<String, Int>()
        for (entry in entries) {
            val host = FilterEngine.hostOf(entry.url) ?: continue
            counts[host] = (counts[host] ?: 0) + 1
        }
        return counts.entries
            .map { TopSite(it.key, it.value) }
            .sortedWith(compareByDescending<TopSite> { it.visits }.thenBy { it.host })
            .take(limit.coerceAtLeast(0))
    }

    /** Remove every entry. */
    fun clear() {
        entries.clear()
        persist()
    }

    private fun persist() {
        val arr = JSONArray()
        for (e in entries) {
            arr.put(
                JSONObject()
                    .put("url", e.url)
                    .put("title", e.title)
                    .put("visitedAt", e.visitedAt)
            )
        }
        storage.save(STORAGE_KEY, arr.toString())
    }

    private fun loadFromStorage() {
        val json = storage.load(STORAGE_KEY) ?: return
        try {
            val arr = JSONArray(json)
            entries.clear()
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                val url = o.optString("url", "")
                if (url.isBlank()) continue
                entries.add(
                    HistoryEntry(url, o.optString("title", ""), o.optLong("visitedAt", 0L))
                )
            }
            while (entries.size > maxEntries) entries.removeAt(0)
        } catch (_: Exception) {
            entries.clear()
        }
    }
}

// ---------------------------------------------------------------------------
// Bookmarks
// ---------------------------------------------------------------------------

/** One bookmark. [folder] is "" for the top level (no folder). */
data class Bookmark(
    val id: String,
    val url: String,
    val title: String,
    val folder: String,
    val createdAt: Long
)

/**
 * Bookmarks. [list]/[search] return bookmarks newest first.
 * One URL can only be bookmarked once: [add] returns the existing
 * bookmark when the exact URL is already saved (it does not move it
 * to another folder — use [update] for that).
 */
class BookmarkStore(private val storage: BrowserStorage) {
    companion object {
        const val STORAGE_KEY = "browser_bookmarks"
    }

    private val bookmarks = ArrayList<Bookmark>()

    init {
        loadFromStorage()
    }

    /**
     * Add a bookmark, or return the existing one for the same URL.
     * Throws IllegalArgumentException on a blank URL.
     */
    fun add(url: String, title: String, folder: String = ""): Bookmark {
        val cleanUrl = url.trim()
        require(cleanUrl.isNotBlank()) { "bookmark URL must not be blank" }
        bookmarks.firstOrNull { it.url == cleanUrl }?.let { return it }
        val bookmark = Bookmark(
            id = java.util.UUID.randomUUID().toString(),
            url = cleanUrl,
            title = title.trim(),
            folder = folder.trim(),
            createdAt = System.currentTimeMillis()
        )
        bookmarks.add(bookmark)
        persist()
        return bookmark
    }

    /** Change a bookmark's title and folder. Returns false when [id] is unknown. */
    fun update(id: String, title: String, folder: String): Boolean {
        val index = bookmarks.indexOfFirst { it.id == id }
        if (index < 0) return false
        bookmarks[index] = bookmarks[index].copy(title = title.trim(), folder = folder.trim())
        persist()
        return true
    }

    /** Remove a bookmark. Returns false when [id] is unknown. */
    fun remove(id: String): Boolean {
        val removed = bookmarks.removeIf { it.id == id }
        if (removed) persist()
        return removed
    }

    /** True when the exact URL (trimmed) is bookmarked. */
    fun isBookmarked(url: String): Boolean =
        bookmarks.any { it.url == url.trim() }

    /** All bookmarks, newest first. */
    fun list(): List<Bookmark> = bookmarks.reversed()

    /** Bookmarks grouped by folder ("" = top level), folders sorted with "" first. */
    fun listByFolder(): Map<String, List<Bookmark>> =
        list().groupBy { it.folder }.toSortedMap()

    /** Distinct non-blank folder names, sorted. */
    fun folders(): List<String> =
        bookmarks.map { it.folder }.filter { it.isNotBlank() }.distinct().sorted()

    /**
     * Case-insensitive substring match over url + title, newest first.
     * A blank query returns everything ([list]).
     */
    fun search(query: String): List<Bookmark> {
        val q = query.trim().lowercase()
        if (q.isBlank()) return list()
        return list().filter {
            it.url.lowercase().contains(q) || it.title.lowercase().contains(q)
        }
    }

    private fun persist() {
        val arr = JSONArray()
        for (b in bookmarks) {
            arr.put(
                JSONObject()
                    .put("id", b.id)
                    .put("url", b.url)
                    .put("title", b.title)
                    .put("folder", b.folder)
                    .put("createdAt", b.createdAt)
            )
        }
        storage.save(STORAGE_KEY, arr.toString())
    }

    private fun loadFromStorage() {
        val json = storage.load(STORAGE_KEY) ?: return
        try {
            val arr = JSONArray(json)
            bookmarks.clear()
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                val id = o.optString("id", "")
                val url = o.optString("url", "")
                if (id.isBlank() || url.isBlank()) continue
                bookmarks.add(
                    Bookmark(
                        id, url, o.optString("title", ""),
                        o.optString("folder", ""), o.optLong("createdAt", 0L)
                    )
                )
            }
        } catch (_: Exception) {
            bookmarks.clear()
        }
    }
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

/** One download. [status] is one of the STATUS_* constants below.
 *  [downloadManagerId] is the id DownloadManager returned when the
 *  download was enqueued (null until the browser stores it via
 *  [DownloadStore.setDownloadManagerId]) — it is the ONLY reliable key
 *  for looking the download up in DownloadManager again. */
data class DownloadRecord(
    val id: Long,
    val url: String,
    val fileName: String,
    val status: String,
    val bytesDownloaded: Long,
    val totalBytes: Long,
    val createdAt: Long,
    val downloadManagerId: Long? = null
)

/**
 * Download history. [list] returns records newest first.
 * [clearCompleted] removes only records whose status is "completed"
 * (failed/cancelled/in-progress records are kept).
 */
class DownloadStore(private val storage: BrowserStorage) {
    companion object {
        const val STORAGE_KEY = "browser_downloads"
        const val STATUS_IN_PROGRESS = "in_progress"
        const val STATUS_COMPLETED = "completed"
        const val STATUS_FAILED = "failed"
        const val STATUS_CANCELLED = "cancelled"
    }

    private val downloads = ArrayList<DownloadRecord>()

    init {
        loadFromStorage()
    }

    /**
     * Start tracking a download (status "in_progress", 0 bytes).
     * A blank [fileName] is derived from the URL's last path segment
     * ("download" when the URL has none). Throws
     * IllegalArgumentException on a blank URL.
     */
    fun add(url: String, fileName: String, totalBytes: Long = 0L): DownloadRecord {
        val cleanUrl = url.trim()
        require(cleanUrl.isNotBlank()) { "download URL must not be blank" }
        val name = fileName.trim().ifBlank { fileNameFromUrl(cleanUrl) }
        var id = System.currentTimeMillis()
        while (downloads.any { it.id == id }) id++
        val record = DownloadRecord(
            id = id,
            url = cleanUrl,
            fileName = name,
            status = STATUS_IN_PROGRESS,
            bytesDownloaded = 0L,
            totalBytes = totalBytes.coerceAtLeast(0L),
            createdAt = System.currentTimeMillis()
        )
        downloads.add(record)
        persist()
        return record
    }

    /** Replace the record with the same id. Returns false when unknown. */
    fun update(record: DownloadRecord): Boolean {
        val index = downloads.indexOfFirst { it.id == record.id }
        if (index < 0) return false
        downloads[index] = record
        persist()
        return true
    }

    /** Update progress/status of one download. Returns false when unknown. */
    fun updateProgress(id: Long, bytesDownloaded: Long, status: String): Boolean {
        val index = downloads.indexOfFirst { it.id == id }
        if (index < 0) return false
        val old = downloads[index]
        downloads[index] = old.copy(
            bytesDownloaded = bytesDownloaded.coerceAtLeast(0L),
            status = status
        )
        persist()
        return true
    }

    /** Store the DownloadManager id for a download (set by the browser
     *  right after enqueueing). Returns false when [id] is unknown. */
    fun setDownloadManagerId(id: Long, downloadManagerId: Long): Boolean {
        val index = downloads.indexOfFirst { it.id == id }
        if (index < 0) return false
        downloads[index] = downloads[index].copy(downloadManagerId = downloadManagerId)
        persist()
        return true
    }

    /** One record by id, or null. */
    fun get(id: Long): DownloadRecord? = downloads.firstOrNull { it.id == id }

    /** Remove a record. Returns false when [id] is unknown. */
    fun remove(id: Long): Boolean {
        val removed = downloads.removeIf { it.id == id }
        if (removed) persist()
        return removed
    }

    /** All records, newest first. */
    fun list(): List<DownloadRecord> = downloads.sortedByDescending { it.createdAt }

    /** Remove completed downloads; returns how many were removed. */
    fun clearCompleted(): Int {
        val before = downloads.size
        downloads.removeIf { it.status == STATUS_COMPLETED }
        val removed = before - downloads.size
        if (removed > 0) persist()
        return removed
    }

    private fun fileNameFromUrl(url: String): String {
        val noQuery = url.substringBefore("?").substringBefore("#")
        val afterScheme = noQuery.substringAfter("://", noQuery)
        val afterHost = afterScheme.substringAfter("/", "")
        val last = afterHost.substringAfterLast("/")
        return last.ifBlank { "download" }
    }

    private fun persist() {
        val arr = JSONArray()
        for (d in downloads) {
            arr.put(
                JSONObject()
                    .put("id", d.id)
                    .put("url", d.url)
                    .put("fileName", d.fileName)
                    .put("status", d.status)
                    .put("bytesDownloaded", d.bytesDownloaded)
                    .put("totalBytes", d.totalBytes)
                    .put("createdAt", d.createdAt)
                    .apply { if (d.downloadManagerId != null) put("downloadManagerId", d.downloadManagerId) }
            )
        }
        storage.save(STORAGE_KEY, arr.toString())
    }

    private fun loadFromStorage() {
        val json = storage.load(STORAGE_KEY) ?: return
        try {
            val arr = JSONArray(json)
            downloads.clear()
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                downloads.add(
                    DownloadRecord(
                        id = o.optLong("id", 0L),
                        url = o.optString("url", ""),
                        fileName = o.optString("fileName", ""),
                        status = o.optString("status", STATUS_IN_PROGRESS),
                        bytesDownloaded = o.optLong("bytesDownloaded", 0L),
                        totalBytes = o.optLong("totalBytes", 0L),
                        createdAt = o.optLong("createdAt", 0L),
                        downloadManagerId =
                            if (o.has("downloadManagerId")) o.optLong("downloadManagerId") else null
                    )
                )
            }
            downloads.removeIf { it.url.isBlank() }
        } catch (_: Exception) {
            downloads.clear()
        }
    }
}

// ---------------------------------------------------------------------------
// Search engines + settings
// ---------------------------------------------------------------------------

/** The search engines offered in settings. DuckDuckGo is the default. */
enum class SearchEngine {
    DUCKDUCKGO,
    GOOGLE,
    BING;

    /** The search URL for [query] on this engine (query URL-encoded). */
    fun searchUrl(query: String): String {
        val encoded = URLEncoder.encode(query.trim(), "UTF-8")
        return when (this) {
            DUCKDUCKGO -> "https://duckduckgo.com/?q=$encoded"
            GOOGLE -> "https://www.google.com/search?q=$encoded"
            BING -> "https://www.bing.com/search?q=$encoded"
        }
    }
}

/** Browser settings. Defaults: DuckDuckGo, the Filter Platform
 *  dashboard as homepage, desktop-site off, human images painted
 *  (not blocked) on review. */
data class BrowserSettings(
    val searchEngine: SearchEngine,
    val homepage: String,
    val desktopSiteDefault: Boolean,
    val humanImageMode: HumanImageMode = HumanImageMode.PAINT
)

/** Loads/saves [BrowserSettings]; missing or corrupt storage yields the defaults. */
class SettingsStore(private val storage: BrowserStorage) {
    companion object {
        const val STORAGE_KEY = "browser_settings"
        val DEFAULT_SETTINGS = BrowserSettings(
            searchEngine = SearchEngine.DUCKDUCKGO,
            homepage = "https://filter-platform-dashboard.pages.dev",
            desktopSiteDefault = false
        )
    }

    /** Current settings; assigning persists them immediately. */
    var settings: BrowserSettings = load()
        set(value) {
            field = value
            persist()
        }

    /** Persist [newSettings] and make them current. */
    fun save(newSettings: BrowserSettings) {
        settings = newSettings
    }

    /** Restore the defaults (and persist them). */
    fun reset() {
        settings = DEFAULT_SETTINGS
    }

    private fun load(): BrowserSettings {
        val json = storage.load(STORAGE_KEY) ?: return DEFAULT_SETTINGS
        return try {
            val o = JSONObject(json)
            val engine = try {
                SearchEngine.valueOf(o.optString("searchEngine", "DUCKDUCKGO"))
            } catch (_: IllegalArgumentException) {
                SearchEngine.DUCKDUCKGO
            }
            BrowserSettings(
                searchEngine = engine,
                homepage = o.optString("homepage", DEFAULT_SETTINGS.homepage)
                    .ifBlank { DEFAULT_SETTINGS.homepage },
                desktopSiteDefault = o.optBoolean(
                    "desktopSiteDefault", DEFAULT_SETTINGS.desktopSiteDefault
                ),
                humanImageMode = HumanImageMode.parse(
                    o.optString("humanImageMode", "")
                ) ?: DEFAULT_SETTINGS.humanImageMode
            )
        } catch (_: Exception) {
            DEFAULT_SETTINGS
        }
    }

    private fun persist() {
        val json = JSONObject()
            .put("searchEngine", settings.searchEngine.name)
            .put("homepage", settings.homepage)
            .put("desktopSiteDefault", settings.desktopSiteDefault)
            .put("humanImageMode", HumanImageMode.wireName(settings.humanImageMode))
            .toString()
        storage.save(STORAGE_KEY, json)
    }
}

// ---------------------------------------------------------------------------
// Review decisions (local cache)
// ---------------------------------------------------------------------------

/** One locally recorded review decision, as the engine honours it. */
data class StoredReviewDecision(
    val imageKey: String,
    val decision: ReviewDecision,
    val boxes: List<PersonBox>,
    val bestScore: Double,
    val humanImageMode: HumanImageMode,
    val imageUrl: String?,
    val pageUrl: String?,
    /** Epoch millis, for the eviction order (oldest first). */
    val recordedAt: Long
) {
    fun toCachedDecision(): CachedDecision = CachedDecision(
        ReviewDecision.wireName(decision), boxes
    )
}

/**
 * Local review-decision store (BrowserStorage key
 * "review_decisions"): image_key -> [StoredReviewDecision]. This is
 * the app's own memory of reviewed images — a reviewed image is not
 * re-asked on later scans (BrowserActivity attaches the stored
 * decision to the finding before deciding, and the engine honours it
 * verbatim). The server record (ApiClient.recordReviewDecision) is
 * the shared copy; this store is the offline fallback and the fast
 * path, and it is also what a review is honoured from when the
 * device is not registered. Capped at 500 entries (oldest evicted
 * first); a corrupt file loads as empty, never a crash.
 */
class ReviewDecisionStore(private val storage: BrowserStorage) {
    companion object {
        const val STORAGE_KEY = "review_decisions"
        const val MAX_ENTRIES = 500
    }

    private var entries: ArrayList<StoredReviewDecision> = loadFromStorage()

    fun lookup(imageKey: String): StoredReviewDecision? =
        entries.firstOrNull { it.imageKey == imageKey }

    fun count(): Int = entries.size

    /** Save (upsert) a decision: a later review of the same image
     *  replaces the earlier one, newest first in eviction order. */
    fun save(record: StoredReviewDecision) {
        entries.removeAll { it.imageKey == record.imageKey }
        entries.add(record)
        while (entries.size > MAX_ENTRIES) entries.removeAt(0)
        persist()
    }

    fun clear() {
        entries.clear()
        persist()
    }

    private fun persist() {
        try {
            val arr = JSONArray()
            for (e in entries) {
                val boxes = JSONArray()
                for (b in e.boxes) {
                    boxes.put(
                        JSONObject().put("x", b.x).put("y", b.y)
                            .put("w", b.w).put("h", b.h).put("score", b.score)
                    )
                }
                val o = JSONObject()
                    .put("imageKey", e.imageKey)
                    .put("decision", ReviewDecision.wireName(e.decision))
                    .put("boxes", boxes)
                    .put("bestScore", e.bestScore)
                    .put("humanImageMode", HumanImageMode.wireName(e.humanImageMode))
                    .put("recordedAt", e.recordedAt)
                if (e.imageUrl != null) o.put("imageUrl", e.imageUrl)
                if (e.pageUrl != null) o.put("pageUrl", e.pageUrl)
                arr.put(o)
            }
            storage.save(STORAGE_KEY, arr.toString())
        } catch (_: Exception) {
            // Best-effort persistence, like every store here.
        }
    }

    private fun loadFromStorage(): ArrayList<StoredReviewDecision> {
        val out = ArrayList<StoredReviewDecision>()
        val json = storage.load(STORAGE_KEY) ?: return out
        try {
            val arr = JSONArray(json)
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                val decision = ReviewDecision.parse(o.optString("decision", ""))
                    ?: continue
                val key = o.optString("imageKey", "").ifBlank { continue }
                val boxes = ArrayList<PersonBox>()
                val barr = o.optJSONArray("boxes")
                if (barr != null) {
                    for (j in 0 until barr.length()) {
                        val b = barr.optJSONObject(j) ?: continue
                        PersonBox.fromWire(
                            if (b.has("x")) b.optDouble("x") else null,
                            if (b.has("y")) b.optDouble("y") else null,
                            if (b.has("w")) b.optDouble("w") else null,
                            if (b.has("h")) b.optDouble("h") else null,
                            if (b.has("score")) b.optDouble("score") else null
                        )?.let { boxes.add(it) }
                    }
                }
                out.add(
                    StoredReviewDecision(
                        imageKey = key,
                        decision = decision,
                        boxes = boxes,
                        bestScore = o.optDouble("bestScore", 0.0),
                        humanImageMode = HumanImageMode.parse(
                            o.optString("humanImageMode", "")
                        ) ?: HumanImageMode.PAINT,
                        imageUrl = if (o.has("imageUrl")) o.optString("imageUrl") else null,
                        pageUrl = if (o.has("pageUrl")) o.optString("pageUrl") else null,
                        recordedAt = o.optLong("recordedAt", 0L)
                    )
                )
            }
        } catch (_: Exception) {
            out.clear()
        }
        while (out.size > MAX_ENTRIES) out.removeAt(0)
        return out
    }
}

// ---------------------------------------------------------------------------
// Omnibox
// ---------------------------------------------------------------------------

/** Where an omnibox suggestion came from. */
enum class SuggestionKind { BOOKMARK, HISTORY, TAB }

/** One omnibox suggestion. */
data class Suggestion(
    val title: String,
    val url: String,
    val kind: SuggestionKind
)

/**
 * Pure omnibox logic: turn what the user typed into a URL or a search,
 * and offer completions from bookmarks, history, and open tabs.
 */
object Omnibox {
    private val IPV4_REGEX =
        Regex("""^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})([:/].*)?$""")
    private val SCHEME_REGEX = Regex("""^[a-zA-Z][a-zA-Z0-9+.-]*$""")

    /**
     * True when [input] looks like a URL to navigate to directly:
     * a domain (contains a dot, valid labels, TLD of 2+ letters),
     * an IPv4 address, or localhost — each optionally with a :port
     * and/or a path. Anything with a space, and bare words such as
     * "example", are NOT URL-like (they are searches).
     */
    fun isUrlLike(input: String): Boolean {
        val t = input.trim()
        if (t.isEmpty() || t.contains(' ') || t.contains('\t')) return false
        // Strip any path/query/fragment, then any :port.
        val hostPort = t.substringBefore("/").substringBefore("?").substringBefore("#")
        val host = hostPort.substringBefore(":")
        val lower = host.lowercase()
        if (lower == "localhost") return true
        val ipv4 = IPV4_REGEX.matchEntire(hostPort)
        if (ipv4 != null) {
            // Octets must be 0-255 ("999.1.1.1" is not an address).
            return (1..4).all { (ipv4.groupValues[it].toIntOrNull() ?: 256) <= 255 }
        }
        if (!host.contains('.')) return false
        val labels = host.split(".")
        if (labels.any { it.isEmpty() || it.startsWith("-") || it.endsWith("-") }) return false
        if (labels.any { label -> label.any { c -> !c.isLetterOrDigit() && c != '-' } }) return false
        val tld = labels.last()
        return tld.length >= 2 && tld.all { it.isLetter() }
    }

    /** True when [input] already carries a scheme ("https://…",
     *  "about:blank", "mailto:…"). "example.com:8080" and
     *  "localhost:8080" are NOT schemes — the part before ':' is a
     *  host (or a port follows), so they resolve as URLs instead. */
    private fun hasScheme(input: String): Boolean {
        val colon = input.indexOf(':')
        if (colon <= 0) return false
        val prefix = input.substring(0, colon)
        if ('.' in prefix) return false
        if (prefix.lowercase() == "localhost") return false
        if (!SCHEME_REGEX.matches(prefix)) return false
        // "host:8080" — a digit after ':' means a port, not a scheme.
        val after = input.getOrNull(colon + 1) ?: return false
        return !after.isDigit()
    }

    /**
     * Resolve omnibox [input] to a URL using [settings]:
     *   blank input                    -> the homepage
     *   already has a scheme           -> as-is
     *   contains a space, or is not
     *   URL-like ("example", "how to
     *   bake")                         -> the search engine's search URL
     *   a domain, IP, or localhost     -> "https://" + input
     */
    fun resolve(input: String, settings: BrowserSettings): String {
        val t = input.trim()
        if (t.isBlank()) return settings.homepage
        if (hasScheme(t)) return t
        if (t.contains(' ') || t.contains('\t')) return settings.searchEngine.searchUrl(t)
        if (isUrlLike(t)) return "https://$t"
        return settings.searchEngine.searchUrl(t)
    }

    /**
     * Suggestions for [query]: case-insensitive substring match on
     * title or URL. Matching bookmarks come first, then matching
     * history (newest first, as passed in), then matching open tabs.
     * Results are de-duplicated by URL (first occurrence wins, so a
     * bookmark beats the same URL in history) and capped at [limit].
     * A blank query returns no suggestions.
     */
    fun suggestions(
        query: String,
        history: List<HistoryEntry>,
        bookmarks: List<Bookmark>,
        openTabs: List<TabState>,
        limit: Int = 8
    ): List<Suggestion> {
        val q = query.trim().lowercase()
        if (q.isBlank()) return emptyList()
        val seen = HashSet<String>()
        val out = ArrayList<Suggestion>()
        fun matches(title: String?, url: String): Boolean =
            (title?.lowercase()?.contains(q) == true) || url.lowercase().contains(q)
        fun offer(title: String, url: String, kind: SuggestionKind) {
            if (url.isBlank()) return
            if (!seen.add(url)) return
            out.add(Suggestion(title.ifBlank { url }, url, kind))
        }
        for (b in bookmarks) {
            if (out.size >= limit) break
            if (matches(b.title, b.url)) offer(b.title, b.url, SuggestionKind.BOOKMARK)
        }
        for (h in history) {
            if (out.size >= limit) break
            if (matches(h.title, h.url)) offer(h.title, h.url, SuggestionKind.HISTORY)
        }
        for (tab in openTabs) {
            if (out.size >= limit) break
            val url = tab.url ?: continue
            if (matches(tab.title, url)) offer(tab.title ?: url, url, SuggestionKind.TAB)
        }
        return out
    }
}

// ---------------------------------------------------------------------------
// Download policy
// ---------------------------------------------------------------------------

/**
 * Whether a download may proceed.
 *
 *   [DownloadDecision.ALLOW] — the download may proceed.
 *   [DownloadDecision.BLOCK] — the download must not start, with a
 *   human-readable [DownloadDecision.BLOCK.reason] for the UI/block page.
 */
sealed class DownloadDecision {
    object ALLOW : DownloadDecision()
    data class BLOCK(val reason: String) : DownloadDecision()
}

/**
 * Download policy — FAIL CLOSED, so a download can never be used to
 * get around the visual filter:
 *
 *  1. Blank URLs and non-http(s) schemes (ftp:, file:, data:, …) are
 *     BLOCKED — the browser only downloads over http(s).
 *  2. A URL whose host is on the blocklist is BLOCKED (same host
 *     matching as [FilterEngine.matchedBlockedHost]: exact host or a
 *     subdomain of a blocked host).
 *  3. A download whose element verdict is COVER, BLOCK, or REVIEW is
 *     BLOCKED — a covered/blocked image must not be downloadable as
 *     a way around the filter. Only an ALLOW verdict clears a download.
 *  4. When the element verdict is unknown (null) AND the URL looks
 *     like an image (.jpg/.jpeg/.png/.gif/.webp/.svg/.bmp, before any
 *     ?query or #fragment), the download is BLOCKED — fail closed: an
 *     image download whose filter verdict is unknown is treated as
 *     unchecked content.
 *  5. Everything else (non-image http(s) URL, host not blocked, no
 *     covering verdict) is ALLOWED — including a download with a null
 *     verdict that is not an image (e.g. a PDF), and an image download
 *     whose element was positively ALLOWed.
 */
object DownloadPolicy {
    private val IMAGE_EXTENSIONS = setOf(
        "jpg", "jpeg", "png", "gif", "webp", "svg", "bmp"
    )

    /** True when [url] looks like an image file (extension check on the path only). */
    fun looksLikeImage(url: String): Boolean {
        val path = url.trim().lowercase()
            .substringBefore("?").substringBefore("#")
        val ext = path.substringAfterLast(".", "")
        if (ext.isEmpty() || ext == path) return false
        return ext in IMAGE_EXTENSIONS
    }

    fun decide(
        url: String,
        blockedHosts: Set<String>,
        elementVerdict: Verdict?
    ): DownloadDecision {
        val clean = url.trim()
        if (clean.isBlank()) {
            return DownloadDecision.BLOCK("empty download URL")
        }
        val lower = clean.lowercase()
        if (!lower.startsWith("http://") && !lower.startsWith("https://")) {
            return DownloadDecision.BLOCK("only http(s) downloads are allowed")
        }
        val blockedHost = FilterEngine.matchedBlockedHost(clean, blockedHosts)
        if (blockedHost != null) {
            return DownloadDecision.BLOCK("host $blockedHost is blocked")
        }
        when (elementVerdict) {
            Verdict.COVER -> return DownloadDecision.BLOCK(
                "content is covered by the filter"
            )
            Verdict.BLOCK -> return DownloadDecision.BLOCK(
                "content is blocked by the filter"
            )
            Verdict.REVIEW -> return DownloadDecision.BLOCK(
                "content has not been reviewed by the filter"
            )
            // PAINTED (0.3.1): the picture is visible with the person
            // painted over — but its raw bytes still contain the
            // person, so downloading it would bypass the paint.
            Verdict.PAINTED -> return DownloadDecision.BLOCK(
                "content is shown painted over; the original image cannot be downloaded"
            )
            Verdict.ALLOW, null -> { /* fall through to the image check */ }
        }
        if (elementVerdict == null && looksLikeImage(clean)) {
            return DownloadDecision.BLOCK(
                "image download with unknown filter verdict"
            )
        }
        return DownloadDecision.ALLOW
    }
}
