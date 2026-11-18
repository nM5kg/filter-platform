package com.filterplatform.app

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit tests for the filter engine — pure Kotlin, no GeckoView runtime.
 * The core property under test: FAIL CLOSED. Nothing returns ALLOW unless
 * a detector positively said NO_PERSON above the policy threshold.
 * Run with ./gradlew testDebugUnitTest, or on this VM with
 * manual-build/run-tests.sh (kotlinc + JUnitCore, same as ApiClientTest).
 */
class FilterEngineTest {

    private val thumb = "data:image/jpeg;base64,/9j/4AAQ=="
    private val strictPolicy = Policy(
        id = "p1", name = "Standard", blockImages = true, coverImages = true,
        filterAds = false, forceSafeSearch = true,
        autoDecideThreshold = 0.70, requireApprovalForNewSites = false
    )
    private val blockPolicy = strictPolicy.copy(coverImages = false)
    private val openPolicy = strictPolicy.copy(blockImages = false)

    private fun finding(
        type: ContentType = ContentType.HTML_IMAGE,
        thumbnail: String? = thumb
    ) = ScanFinding(
        elementId = "fp-1", type = type, pageUrl = "https://example.com/",
        sourceUrl = "https://example.com/pic.jpg",
        thumbnailDataUrl = thumbnail
    )

    /** A detector that always answers with the given fixed result. */
    private class FixedDetector(private val result: DetectionResult) : PersonDetector {
        override fun detect(finding: ScanFinding) = result
    }

    // --- fail closed -------------------------------------------------------

    @Test
    fun stubDetector_neverAllows() {
        // The shipped prototype detector: no model -> UNKNOWN -> REVIEW.
        val engine = FilterEngine(StubPersonDetector())
        val d = engine.decide(finding(), strictPolicy)
        assertEquals(Verdict.REVIEW, d.verdict)
    }

    @Test
    fun noThumbnail_isReviewNotAllow() {
        // Cross-origin / tainted / WebGL / stream content has no pixels to
        // check — "cannot check" must never read as "clean".
        val engine = FilterEngine(FixedDetector(
            DetectionResult(DetectionOutcome.NO_PERSON, 0.99)))
        val d = engine.decide(finding(thumbnail = null), strictPolicy)
        assertEquals(Verdict.REVIEW, d.verdict)
    }

    @Test
    fun lowConfidenceNoPerson_isReview() {
        val engine = FilterEngine(FixedDetector(
            DetectionResult(DetectionOutcome.NO_PERSON, 0.5)))
        val d = engine.decide(finding(), strictPolicy)
        assertEquals(Verdict.REVIEW, d.verdict)
    }

    @Test
    fun unknownDetectorResult_isReview() {
        val engine = FilterEngine(FixedDetector(
            DetectionResult(DetectionOutcome.UNKNOWN, 0.0, "model error")))
        val d = engine.decide(finding(), strictPolicy)
        assertEquals(Verdict.REVIEW, d.verdict)
    }

    // --- positive decisions ------------------------------------------------

    @Test
    fun personDetected_coverPolicy_covers() {
        val engine = FilterEngine(FixedDetector(
            DetectionResult(DetectionOutcome.PERSON, 0.9)))
        assertEquals(Verdict.COVER, engine.decide(finding(), strictPolicy).verdict)
    }

    @Test
    fun personDetected_blockPolicy_blocks() {
        val engine = FilterEngine(FixedDetector(
            DetectionResult(DetectionOutcome.PERSON, 0.9)))
        assertEquals(Verdict.BLOCK, engine.decide(finding(), blockPolicy).verdict)
    }

    @Test
    fun confidentNoPerson_allows() {
        val engine = FilterEngine(FixedDetector(
            DetectionResult(DetectionOutcome.NO_PERSON, 0.95)))
        assertEquals(Verdict.ALLOW, engine.decide(finding(), strictPolicy).verdict)
    }

    @Test
    fun policyNotFilteringImages_allows() {
        // Explicit operator choice (block_images=false), not a default.
        val engine = FilterEngine(StubPersonDetector())
        assertEquals(Verdict.ALLOW, engine.decide(finding(), openPolicy).verdict)
    }

    @Test
    fun defaultPolicy_isFailClosed() {
        assertTrue(FilterEngine.DEFAULT_POLICY.blockImages)
        assertTrue(FilterEngine.DEFAULT_POLICY.coverImages)
    }

    // --- scan message parsing ----------------------------------------------

    @Test
    fun parseScanMessage_allKinds() {
        val json = JSONObject(
            """{"type":"scan","pageUrl":"https://example.com/","findings":[
            |{"id":"a","kind":"img","source":"https://x/y.jpg","thumb":"data:,"},
            |{"id":"b","kind":"css","source":"url(https://x/bg.png)"},
            |{"id":"c","kind":"canvas"},
            |{"id":"d","kind":"svg"},
            |{"id":"e","kind":"webgl"},
            |{"id":"f","kind":"video","playing":true},
            |{"id":"g","kind":"stream","playing":true},
            |{"id":"h","kind":"something-new"}]}""".trimMargin()
        )
        val findings = FilterEngine.parseScanMessage(json)
        assertEquals(8, findings.size)
        assertEquals(ContentType.HTML_IMAGE, findings[0].type)
        assertEquals(ContentType.CSS_BACKGROUND, findings[1].type)
        assertEquals(ContentType.CANVAS, findings[2].type)
        assertEquals(ContentType.SVG, findings[3].type)
        assertEquals(ContentType.WEBGL, findings[4].type)
        assertEquals(ContentType.VIDEO_FRAME, findings[5].type)
        assertTrue(findings[5].isPlaying)
        assertEquals(ContentType.LIVE_STREAM, findings[6].type)
        // Unknown kind is kept as DYNAMIC — never dropped, still covered.
        assertEquals(ContentType.DYNAMIC, findings[7].type)
        assertNull(findings[2].thumbnailDataUrl)
    }

    @Test(expected = IllegalArgumentException::class)
    fun parseScanMessage_wrongType_throws() {
        FilterEngine.parseScanMessage(JSONObject("""{"type":"decisions"}"""))
    }

    @Test(expected = IllegalArgumentException::class)
    fun parseScanMessage_noFindings_throws() {
        FilterEngine.parseScanMessage(JSONObject("""{"type":"scan"}"""))
    }

    // --- decisions message ---------------------------------------------------

    @Test
    fun buildDecisionsMessage_reviewSentAsCover() {
        // The content script has no "review" state: anything not ALLOW
        // stays covered. REVIEW must go over the wire as "cover".
        val msg = FilterEngine.buildDecisionsMessage(
            listOf(
                ElementDecision("a", Verdict.ALLOW, ""),
                ElementDecision("b", Verdict.REVIEW, ""),
                ElementDecision("c", Verdict.COVER, ""),
                ElementDecision("d", Verdict.BLOCK, "")
            )
        )
        assertEquals("decisions", msg.getString("type"))
        val arr = msg.getJSONArray("decisions")
        assertEquals("allow", arr.getJSONObject(0).getString("verdict"))
        assertEquals("cover", arr.getJSONObject(1).getString("verdict"))
        assertEquals("cover", arr.getJSONObject(2).getString("verdict"))
        assertEquals("block", arr.getJSONObject(3).getString("verdict"))
    }

    // --- navigation hook -----------------------------------------------------

    @Test
    fun shouldBlockNavigation_blocklistAndSchemes() {
        val blocked = setOf("facebook.com", "example-bad.org")
        assertTrue(FilterEngine.shouldBlockNavigation("https://facebook.com/x", blocked))
        assertTrue(FilterEngine.shouldBlockNavigation("https://www.facebook.com/", blocked))
        assertTrue(FilterEngine.shouldBlockNavigation("https://sub.example-bad.org/", blocked))
        assertFalse(FilterEngine.shouldBlockNavigation("https://example.com/", blocked))
        assertFalse(FilterEngine.shouldBlockNavigation("https://notfacebook.com/", blocked))
        assertFalse(FilterEngine.shouldBlockNavigation("file:///android_asset/test.html", blocked))
        assertTrue(FilterEngine.shouldBlockNavigation("intent://x#Intent;scheme=https", blocked))
        assertTrue(FilterEngine.shouldBlockNavigation("javascript:alert(1)", blocked))
        assertTrue(FilterEngine.shouldBlockNavigation("", blocked))
    }

    @Test
    fun hostOf_parses() {
        assertEquals("example.com", FilterEngine.hostOf("https://example.com/a?b=c"))
        assertEquals("example.com", FilterEngine.hostOf("https://example.com:8080/a"))
        assertEquals("sub.example.com", FilterEngine.hostOf("http://sub.example.com"))
        assertNull(FilterEngine.hostOf("not a url"))
        assertNull(FilterEngine.hostOf(""))
    }
}
