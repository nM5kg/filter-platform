package com.filterplatform.app

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit tests for the pure-Kotlin browser data/state layer (BrowserData.kt).
 * Run via manual-build/run-tests.sh (kotlinc + JUnitCore), like
 * ApiClientTest / FilterEngineTest.
 */
class BrowserDataTest {

    private val defaultSettings = SettingsStore.DEFAULT_SETTINGS

    // --- storage -----------------------------------------------------------

    @Test
    fun memoryStorage_roundTripAndDelete() {
        val storage = MemoryBrowserStorage()
        assertNull(storage.load("k"))
        storage.save("k", "v")
        assertEquals("v", storage.load("k"))
        storage.save("k", "v2")
        assertEquals("v2", storage.load("k"))
        storage.delete("k")
        assertNull(storage.load("k"))
    }

    @Test
    fun fileStorage_roundTripInTempDir() {
        val dir = File(System.getProperty("java.io.tmpdir"), "fp-browserdata-test-${System.nanoTime()}")
        try {
            val storage = FileBrowserStorage(dir)
            assertNull(storage.load("tabs"))
            storage.save("tabs", """{"tabs":[]}""")
            assertEquals("""{"tabs":[]}""", storage.load("tabs"))
            assertTrue(File(dir, "tabs.json").isFile)
            storage.delete("tabs")
            assertNull(storage.load("tabs"))
            assertFalse(File(dir, "tabs.json").exists())
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun fileStorage_sanitisesUnsafeKeys() {
        val dir = File(System.getProperty("java.io.tmpdir"), "fp-browserdata-test2-${System.nanoTime()}")
        try {
            val storage = FileBrowserStorage(dir)
            storage.save("a/b?c", "x")
            assertEquals("x", storage.load("a/b?c"))
            assertTrue(dir.listFiles()?.isNotEmpty() == true)
        } finally {
            dir.deleteRecursively()
        }
    }

    // --- tabs --------------------------------------------------------------

    @Test
    fun tabs_newTabIsSelectedAndListed() {
        val store = TabStore(MemoryBrowserStorage())
        assertTrue(store.list().isEmpty())
        assertNull(store.selectedId)
        val tab = store.newTab("https://example.com")
        assertEquals("https://example.com", tab.url)
        assertFalse(tab.isPrivate)
        assertFalse(tab.desktopSite)
        assertEquals(tab.id, store.selectedId)
        assertEquals(listOf(tab), store.list())
    }

    @Test
    fun tabs_closeSelectedSelectsNextThenPrevious() {
        val store = TabStore(MemoryBrowserStorage())
        val a = store.newTab("https://a.example")
        val b = store.newTab("https://b.example")
        val c = store.newTab("https://c.example")
        store.selectTab(b.id)
        assertTrue(store.closeTab(b.id))
        assertEquals(c.id, store.selectedId) // next tab at the same position
        assertTrue(store.closeTab(c.id))
        assertEquals(a.id, store.selectedId) // previous tab
        assertTrue(store.closeTab(a.id))
        assertNull(store.selectedId)
        assertTrue(store.list().isEmpty())
    }

    @Test
    fun tabs_closeAndSelectUnknownReturnFalse() {
        val store = TabStore(MemoryBrowserStorage())
        store.newTab("https://example.com")
        assertFalse(store.closeTab("nope"))
        assertFalse(store.selectTab("nope"))
        assertEquals(1, store.list().size)
    }

    @Test
    fun tabs_moveTabReorders() {
        val store = TabStore(MemoryBrowserStorage())
        val a = store.newTab("https://a.example")
        val b = store.newTab("https://b.example")
        val c = store.newTab("https://c.example")
        assertTrue(store.moveTab(a.id, 2))
        assertEquals(listOf(b.id, c.id, a.id), store.list().map { it.id })
        assertFalse(store.moveTab("nope", 0))
        // Out-of-range index clamps to the end.
        assertTrue(store.moveTab(b.id, 99))
        assertEquals(b.id, store.list().last().id)
    }

    @Test
    fun tabs_updateTabChangesFields() {
        val store = TabStore(MemoryBrowserStorage())
        val tab = store.newTab("https://example.com")
        assertTrue(store.updateTab(tab.id, title = "Example", desktopSite = true))
        val updated = store.list().first()
        assertEquals("Example", updated.title)
        assertTrue(updated.desktopSite)
        assertEquals("https://example.com", updated.url) // unchanged
        assertFalse(store.updateTab("nope", title = "x"))
    }

    @Test
    fun tabs_privateTabsAreNeverPersisted() {
        val storage = MemoryBrowserStorage()
        val store = TabStore(storage)
        store.newTab("https://public.example")
        store.newTab("https://secret.example", isPrivate = true)
        assertEquals(2, store.list().size)
        // A fresh store over the same storage restores only the public tab.
        val restored = TabStore(storage)
        assertEquals(1, restored.list().size)
        assertEquals("https://public.example", restored.list().first().url)
        assertFalse(restored.list().first().isPrivate)
        // And the persisted JSON itself contains no private URL.
        assertFalse(storage.load(TabStore.STORAGE_KEY)!!.contains("secret.example"))
    }

    @Test
    fun tabs_restoreRoundTripPreservesOrderAndSelection() {
        val storage = MemoryBrowserStorage()
        val store = TabStore(storage)
        val a = store.newTab("https://a.example")
        store.newTab("https://b.example")
        store.selectTab(a.id)
        val restored = TabStore(storage)
        assertEquals(listOf("https://a.example", "https://b.example"),
            restored.list().map { it.url })
        assertEquals(a.id, restored.selectedId)
    }

    @Test
    fun tabs_serializeDeserializeRoundTripAndBadJson() {
        val store = TabStore(MemoryBrowserStorage())
        store.newTab("https://a.example")
        store.newTab("https://b.example", isPrivate = true)
        val json = store.serialize()
        assertEquals(1, store.deserialize(json).size) // private excluded
        assertEquals("https://a.example", store.deserialize(json).first().url)
        assertTrue(store.deserialize("not json {{{").isEmpty())
        assertTrue(store.deserialize("{}").isEmpty())
    }

    // --- history -----------------------------------------------------------

    @Test
    fun history_recordIgnoresNonHttpUrls() {
        val store = HistoryStore(MemoryBrowserStorage())
        assertTrue(store.record("https://example.com/", "Example"))
        assertTrue(store.record("http://example.com/page", "Page"))
        assertFalse(store.record("", "blank"))
        assertFalse(store.record("   ", "blank"))
        assertFalse(store.record("ftp://example.com/file", "FTP"))
        assertFalse(store.record("data:text/html,<b>x</b>", "data"))
        assertFalse(store.record("about:blank", "about"))
        assertFalse(store.record("javascript:alert(1)", "js"))
        assertEquals(2, store.all().size)
    }

    @Test
    fun history_allIsNewestFirstAndSearchIsCaseInsensitive() {
        val store = HistoryStore(MemoryBrowserStorage())
        store.record("https://example.com/cats", "Cats")
        store.record("https://other.org/dogs", "Dogs")
        store.record("https://example.com/cat-videos", "Cat Videos")
        assertEquals("https://example.com/cat-videos", store.all().first().url)
        val found = store.search("CAT")
        assertEquals(2, found.size)
        assertEquals("https://example.com/cat-videos", found.first().url)
        assertEquals(3, store.search("").size) // blank query returns all
        assertTrue(store.search("zzz-no-match").isEmpty())
    }

    @Test
    fun history_topSitesCountsVisitsPerHost() {
        val store = HistoryStore(MemoryBrowserStorage())
        store.record("https://a.example/1", "1")
        store.record("https://a.example/2", "2")
        store.record("https://a.example/3", "3")
        store.record("https://b.example/1", "1")
        store.record("https://sub.a.example/1", "1")
        val top = store.topSites(2)
        assertEquals(2, top.size)
        assertEquals(TopSite("a.example", 3), top[0])
        assertEquals(TopSite("b.example", 1), top[1])
    }

    @Test
    fun history_maxEntriesDropsOldest() {
        val store = HistoryStore(MemoryBrowserStorage(), maxEntries = 3)
        store.record("https://a.example/1", "1")
        store.record("https://a.example/2", "2")
        store.record("https://a.example/3", "3")
        store.record("https://a.example/4", "4")
        assertEquals(3, store.all().size)
        assertEquals("https://a.example/4", store.all().first().url)
        assertFalse(store.all().any { it.url.endsWith("/1") })
    }

    @Test
    fun history_clearAndPersistAcrossStores() {
        val storage = MemoryBrowserStorage()
        val store = HistoryStore(storage)
        store.record("https://example.com/", "Example")
        assertEquals(1, HistoryStore(storage).all().size)
        store.clear()
        assertTrue(store.all().isEmpty())
        assertTrue(HistoryStore(storage).all().isEmpty())
    }

    // --- bookmarks ---------------------------------------------------------

    @Test
    fun bookmarks_addListAndIsBookmarked() {
        val store = BookmarkStore(MemoryBrowserStorage())
        val b = store.add("https://example.com", "Example", "News")
        assertTrue(store.isBookmarked("https://example.com"))
        assertFalse(store.isBookmarked("https://other.org"))
        assertEquals(listOf(b), store.list())
        assertEquals("News", store.folders().single())
    }

    @Test
    fun bookmarks_addSameUrlReturnsExisting() {
        val store = BookmarkStore(MemoryBrowserStorage())
        val first = store.add("https://example.com", "Example")
        val second = store.add("https://example.com", "Other title", "Other folder")
        assertEquals(first.id, second.id)
        assertEquals(1, store.list().size)
        assertEquals("Example", store.list().first().title)
    }

    @Test
    fun bookmarks_updateRemoveAndUnknownIds() {
        val store = BookmarkStore(MemoryBrowserStorage())
        val b = store.add("https://example.com", "Example")
        assertTrue(store.update(b.id, "Renamed", "Favourites"))
        assertEquals("Renamed", store.list().first().title)
        assertEquals("Favourites", store.list().first().folder)
        assertFalse(store.update("nope", "x", "y"))
        assertFalse(store.remove("nope"))
        assertTrue(store.remove(b.id))
        assertTrue(store.list().isEmpty())
    }

    @Test
    fun bookmarks_listByFolderAndSearch() {
        val store = BookmarkStore(MemoryBrowserStorage())
        store.add("https://news.example", "News Site", "News")
        store.add("https://blog.example", "Blog", "News")
        store.add("https://shop.example", "Shop", "")
        val byFolder = store.listByFolder()
        assertEquals(2, byFolder["News"]!!.size)
        assertEquals(1, byFolder[""]!!.size)
        assertEquals(listOf("News"), store.folders())
        val found = store.search("NEWS")
        assertEquals(1, found.size)
        assertEquals("https://news.example", found.first().url)
        assertEquals(3, store.search("example").size)
    }

    @Test
    fun bookmarks_persistAcrossStores() {
        val storage = MemoryBrowserStorage()
        BookmarkStore(storage).add("https://example.com", "Example", "News")
        val restored = BookmarkStore(storage)
        assertEquals(1, restored.list().size)
        assertTrue(restored.isBookmarked("https://example.com"))
    }

    // --- downloads ---------------------------------------------------------

    @Test
    fun downloads_addDefaultsAndFileNameFromUrl() {
        val store = DownloadStore(MemoryBrowserStorage())
        val d = store.add("https://example.com/files/report.pdf", "report.pdf", totalBytes = 1000)
        assertEquals(DownloadStore.STATUS_IN_PROGRESS, d.status)
        assertEquals(0L, d.bytesDownloaded)
        assertEquals(1000L, d.totalBytes)
        assertEquals(1, store.list().size)
        val derived = store.add("https://example.com/files/photo.jpg", "")
        assertEquals("photo.jpg", derived.fileName)
        val fallback = store.add("https://example.com/", "")
        assertEquals("download", fallback.fileName)
    }

    @Test
    fun downloads_updateProgressAndUpdateRecord() {
        val store = DownloadStore(MemoryBrowserStorage())
        val d = store.add("https://example.com/a.zip", "a.zip", totalBytes = 100)
        assertTrue(store.updateProgress(d.id, 50, DownloadStore.STATUS_IN_PROGRESS))
        assertEquals(50L, store.get(d.id)!!.bytesDownloaded)
        assertTrue(store.updateProgress(d.id, 100, DownloadStore.STATUS_COMPLETED))
        assertEquals(DownloadStore.STATUS_COMPLETED, store.get(d.id)!!.status)
        assertFalse(store.updateProgress(999999L, 1, DownloadStore.STATUS_FAILED))
        val replaced = store.get(d.id)!!.copy(fileName = "renamed.zip")
        assertTrue(store.update(replaced))
        assertEquals("renamed.zip", store.get(d.id)!!.fileName)
        assertFalse(store.update(replaced.copy(id = 424242L)))
    }

    @Test
    fun downloads_removeAndClearCompletedKeepsOthers() {
        val store = DownloadStore(MemoryBrowserStorage())
        val done = store.add("https://example.com/done.zip", "done.zip")
        val busy = store.add("https://example.com/busy.zip", "busy.zip")
        val failed = store.add("https://example.com/fail.zip", "fail.zip")
        store.updateProgress(done.id, 10, DownloadStore.STATUS_COMPLETED)
        store.updateProgress(failed.id, 0, DownloadStore.STATUS_FAILED)
        assertEquals(1, store.clearCompleted())
        assertEquals(2, store.list().size)
        assertNull(store.get(done.id))
        assertNotNull(store.get(failed.id)) // failed is NOT cleared
        assertTrue(store.remove(busy.id))
        assertFalse(store.remove(busy.id))
        assertEquals(1, store.list().size)
    }

    @Test
    fun downloads_setDownloadManagerIdRoundTrips() {
        val storage = MemoryBrowserStorage()
        val store = DownloadStore(storage)
        val d = store.add("https://example.com/f.zip", "f.zip")
        assertNull(d.downloadManagerId) // null until the browser enqueues
        assertTrue(store.setDownloadManagerId(d.id, 12345L))
        assertEquals(12345L, store.get(d.id)!!.downloadManagerId)
        assertFalse(store.setDownloadManagerId(999999L, 1L))
        // A fresh store over the same storage sees the manager id.
        val restored = DownloadStore(storage)
        assertEquals(12345L, restored.get(d.id)!!.downloadManagerId)
    }

    // --- search engines + settings ------------------------------------------

    @Test
    fun searchEngine_urls() {
        assertEquals(
            "https://duckduckgo.com/?q=how+to+bake",
            SearchEngine.DUCKDUCKGO.searchUrl("how to bake")
        )
        assertEquals(
            "https://www.google.com/search?q=how+to+bake",
            SearchEngine.GOOGLE.searchUrl("how to bake")
        )
        assertEquals(
            "https://www.bing.com/search?q=how+to+bake",
            SearchEngine.BING.searchUrl("how to bake")
        )
        // Query encoding: & must not leak into the URL as a second param.
        assertTrue(SearchEngine.DUCKDUCKGO.searchUrl("cats & dogs").contains("cats+%26+dogs"))
    }

    @Test
    fun settings_defaultsAreDuckDuckGoAndDashboard() {
        val store = SettingsStore(MemoryBrowserStorage())
        assertEquals(SearchEngine.DUCKDUCKGO, store.settings.searchEngine)
        assertEquals("https://filter-platform-dashboard.pages.dev", store.settings.homepage)
        assertFalse(store.settings.desktopSiteDefault)
    }

    @Test
    fun settings_savePersistsAndResetRestoresDefaults() {
        val storage = MemoryBrowserStorage()
        val store = SettingsStore(storage)
        store.save(BrowserSettings(SearchEngine.GOOGLE, "https://example.com", true))
        assertEquals(SearchEngine.GOOGLE, SettingsStore(storage).settings.searchEngine)
        assertEquals("https://example.com", SettingsStore(storage).settings.homepage)
        assertTrue(SettingsStore(storage).settings.desktopSiteDefault)
        store.reset()
        assertEquals(defaultSettings, SettingsStore(storage).settings)
    }

    @Test
    fun settings_corruptStorageFallsBackToDefaults() {
        val storage = MemoryBrowserStorage()
        storage.save(SettingsStore.STORAGE_KEY, "not json {{{")
        assertEquals(defaultSettings, SettingsStore(storage).settings)
    }

    // --- omnibox ------------------------------------------------------------

    @Test
    fun omnibox_blankInputGoesToHomepage() {
        assertEquals(defaultSettings.homepage, Omnibox.resolve("", defaultSettings))
        assertEquals(defaultSettings.homepage, Omnibox.resolve("   ", defaultSettings))
    }

    @Test
    fun omnibox_bareWordIsASearch() {
        val url = Omnibox.resolve("example", defaultSettings)
        assertEquals("https://duckduckgo.com/?q=example", url)
        val google = Omnibox.resolve(
            "example", defaultSettings.copy(searchEngine = SearchEngine.GOOGLE)
        )
        assertEquals("https://www.google.com/search?q=example", google)
    }

    @Test
    fun omnibox_domainGetsHttpsPrefix() {
        assertEquals("https://example.com", Omnibox.resolve("example.com", defaultSettings))
        assertEquals(
            "https://example.com/path?q=1",
            Omnibox.resolve("example.com/path?q=1", defaultSettings)
        )
        assertEquals("https://example.com:8080", Omnibox.resolve("example.com:8080", defaultSettings))
    }

    @Test
    fun omnibox_schemeIsKeptAsIs() {
        assertEquals("http://x", Omnibox.resolve("http://x", defaultSettings))
        assertEquals("https://example.com", Omnibox.resolve("https://example.com", defaultSettings))
        assertEquals("about:blank", Omnibox.resolve("about:blank", defaultSettings))
    }

    @Test
    fun omnibox_phraseWithSpaceIsASearch() {
        assertEquals(
            "https://duckduckgo.com/?q=how+to+bake",
            Omnibox.resolve("how to bake", defaultSettings)
        )
        // Even a domain followed by words is a search, not a URL.
        assertTrue(Omnibox.resolve("example.com news", defaultSettings).contains("duckduckgo.com"))
    }

    @Test
    fun omnibox_ipAndLocalhostAreUrls() {
        assertEquals("https://192.168.1.1", Omnibox.resolve("192.168.1.1", defaultSettings))
        assertEquals("https://192.168.1.1:8080", Omnibox.resolve("192.168.1.1:8080", defaultSettings))
        assertEquals("https://localhost", Omnibox.resolve("localhost", defaultSettings))
        assertEquals("https://localhost:8080", Omnibox.resolve("localhost:8080", defaultSettings))
        assertEquals("https://10.0.0.5/admin", Omnibox.resolve("10.0.0.5/admin", defaultSettings))
    }

    @Test
    fun omnibox_isUrlLikeEdgeCases() {
        assertTrue(Omnibox.isUrlLike("example.com"))
        assertTrue(Omnibox.isUrlLike("sub.example.co.uk"))
        assertFalse(Omnibox.isUrlLike("example"))
        assertFalse(Omnibox.isUrlLike("example.c")) // 1-letter TLD
        assertFalse(Omnibox.isUrlLike("999.1.1.1")) // octet > 255
        assertFalse(Omnibox.isUrlLike("exa mple.com"))
        assertFalse(Omnibox.isUrlLike(""))
        assertFalse(Omnibox.isUrlLike("example..com"))
    }

    @Test
    fun omnibox_suggestionsBookmarksFirstThenHistoryThenTabs() {
        val history = listOf(
            HistoryEntry("https://example.com/cats", "Cats", 3000L),
            HistoryEntry("https://example.com/dogs", "Dogs", 2000L),
            HistoryEntry("https://other.org/cats", "More cats", 1000L)
        )
        val bookmarks = listOf(
            Bookmark("b1", "https://example.com/cats", "Cats bookmark", "", 100L)
        )
        val tabs = listOf(
            TabState("t1", "https://example.com/cats-page", "Cats page", false, false, 1L)
        )
        val out = Omnibox.suggestions("cats", history, bookmarks, tabs)
        assertEquals(3, out.size)
        // Bookmark wins for the duplicated URL and comes first.
        assertEquals(SuggestionKind.BOOKMARK, out[0].kind)
        assertEquals("https://example.com/cats", out[0].url)
        // History next, newest first; the tab's cats-page last.
        assertEquals(SuggestionKind.HISTORY, out[1].kind)
        assertEquals("https://other.org/cats", out[1].url)
        assertEquals(SuggestionKind.TAB, out[2].kind)
    }

    @Test
    fun omnibox_suggestionsDedupeLimitAndBlankQuery() {
        val history = (10 downTo 1).map {
            HistoryEntry("https://example.com/page$it", "Page $it", it.toLong())
        }
        val out = Omnibox.suggestions("page", history, emptyList(), emptyList(), limit = 3)
        assertEquals(3, out.size)
        assertEquals("https://example.com/page10", out[0].url) // newest first
        assertTrue(Omnibox.suggestions("", history, emptyList(), emptyList()).isEmpty())
        assertTrue(Omnibox.suggestions("   ", history, emptyList(), emptyList()).isEmpty())
        assertTrue(Omnibox.suggestions("zzz", history, emptyList(), emptyList()).isEmpty())
    }

    @Test
    fun omnibox_suggestionsMatchIsCaseInsensitiveSubstring() {
        val history = listOf(
            HistoryEntry("https://Example.COM/Cats", "CATS", 1L)
        )
        val out = Omnibox.suggestions("cats", history, emptyList(), emptyList())
        assertEquals(1, out.size)
        // Title falls back to the URL when blank.
        val noTitle = Omnibox.suggestions(
            "example",
            listOf(HistoryEntry("https://example.com/", "", 1L)),
            emptyList(), emptyList()
        )
        assertEquals("https://example.com/", noTitle.first().title)
    }

    // --- download policy ----------------------------------------------------

    @Test
    fun downloadPolicy_blockedHostExactAndSubdomain() {
        val blocked = setOf("bad.example", "evil.org")
        val r1 = DownloadPolicy.decide("https://bad.example/file.zip", blocked, null)
        assertTrue(r1 is DownloadDecision.BLOCK)
        assertTrue((r1 as DownloadDecision.BLOCK).reason.contains("bad.example"))
        assertTrue(DownloadPolicy.decide("https://sub.bad.example/x", blocked, null)
            is DownloadDecision.BLOCK)
        // A host that merely contains the blocked string is NOT blocked.
        assertEquals(
            DownloadDecision.ALLOW,
            DownloadPolicy.decide("https://notbad.example/x.zip", blocked, null)
        )
    }

    @Test
    fun downloadPolicy_coveredBlockedOrReviewVerdictBlocks() {
        for (verdict in listOf(Verdict.COVER, Verdict.BLOCK, Verdict.REVIEW)) {
            val decision = DownloadPolicy.decide(
                "https://example.com/photo.jpg", emptySet(), verdict
            )
            assertTrue("verdict $verdict should block", decision is DownloadDecision.BLOCK)
        }
    }

    @Test
    fun downloadPolicy_allowVerdictClearsImageDownload() {
        assertEquals(
            DownloadDecision.ALLOW,
            DownloadPolicy.decide("https://example.com/photo.jpg", emptySet(), Verdict.ALLOW)
        )
        assertEquals(
            DownloadDecision.ALLOW,
            DownloadPolicy.decide(
                "https://example.com/photo.png?size=large", emptySet(), Verdict.ALLOW
            )
        )
    }

    @Test
    fun downloadPolicy_unknownVerdictBlocksImageButNotOtherFiles() {
        // Fail closed: image with unknown verdict is blocked …
        assertTrue(
            DownloadPolicy.decide("https://example.com/photo.jpg", emptySet(), null)
                is DownloadDecision.BLOCK
        )
        assertTrue(
            DownloadPolicy.decide("https://example.com/PHOTO.PNG", emptySet(), null)
                is DownloadDecision.BLOCK
        )
        assertTrue(
            DownloadPolicy.decide("https://example.com/img.svg#frag", emptySet(), null)
                is DownloadDecision.BLOCK
        )
        assertTrue(
            DownloadPolicy.decide("https://example.com/a.jpeg?x=1", emptySet(), null)
                is DownloadDecision.BLOCK
        )
        // … but a non-image with unknown verdict is a normal download.
        assertEquals(
            DownloadDecision.ALLOW,
            DownloadPolicy.decide("https://example.com/report.pdf", emptySet(), null)
        )
        assertEquals(
            DownloadDecision.ALLOW,
            DownloadPolicy.decide("https://example.com/archive.zip", emptySet(), null)
        )
        // A .jpg-looking path that is not really an image extension is fine.
        assertEquals(
            DownloadDecision.ALLOW,
            DownloadPolicy.decide("https://example.com/jpg", emptySet(), null)
        )
    }

    @Test
    fun downloadPolicy_nonHttpSchemesBlocked() {
        assertTrue(DownloadPolicy.decide("ftp://example.com/f.zip", emptySet(), null)
            is DownloadDecision.BLOCK)
        assertTrue(DownloadPolicy.decide("data:image/png;base64,xxxx", emptySet(), null)
            is DownloadDecision.BLOCK)
        assertTrue(DownloadPolicy.decide("about:blank", emptySet(), null)
            is DownloadDecision.BLOCK)
        assertTrue(DownloadPolicy.decide("", emptySet(), null)
            is DownloadDecision.BLOCK)
        assertTrue(DownloadPolicy.decide("   ", emptySet(), Verdict.ALLOW)
            is DownloadDecision.BLOCK)
    }

    @Test
    fun downloadPolicy_plainHttpDownloadAllowed() {
        assertEquals(
            DownloadDecision.ALLOW,
            DownloadPolicy.decide("https://example.com/file.pdf", emptySet(), null)
        )
        assertEquals(
            DownloadDecision.ALLOW,
            DownloadPolicy.decide("http://example.com/file.pdf", emptySet(), null)
        )
    }
}
