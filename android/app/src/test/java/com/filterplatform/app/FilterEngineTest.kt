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

    /** A finding as the v1.2.0 content script reports it: the detectors
     *  ran and reported these numbers. */
    private fun detectedFinding(
        persons: Int = 0, personBest: Double = 0.0,
        faces: Int = 0, faceBest: Double = 0.0,
        detectionRan: Boolean = true, detectError: String = ""
    ) = finding().copy(
        persons = persons, personBest = personBest,
        faces = faces, faceBest = faceBest,
        detectionRan = detectionRan, detectError = detectError
    )

    /** A detector that always answers with the given fixed result. */
    private class FixedDetector(private val result: DetectionResult) : PersonDetector {
        override fun detect(finding: ScanFinding, humanThreshold: Double) = result
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
    fun noThumbnail_detectorResultStillApplies() {
        // v1.2.0: the thumbnail gate is GONE — the JS-reported detection
        // fields already encode "no pixels" as detectionRan=false. A
        // detector that positively says NO_PERSON still allows, even
        // with no thumbnail (cross-origin / tainted / WebGL / stream
        // content the script could not thumbnail but DID check).
        val engine = FilterEngine(FixedDetector(
            DetectionResult(DetectionOutcome.NO_PERSON, 0.99)))
        val d = engine.decide(finding(thumbnail = null), strictPolicy)
        assertEquals(Verdict.ALLOW, d.verdict)
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

    // --- JsReportedPersonDetector --------------------------------------------

    private val jsDetector = JsReportedPersonDetector()

    @Test
    fun jsDetector_personAboveThreshold_isPerson() {
        // Person at 0.87 clears both the 0.50 and the 0.70 threshold.
        val r50 = jsDetector.detect(detectedFinding(persons = 1, personBest = 0.87), 0.50)
        assertEquals(DetectionOutcome.PERSON, r50.outcome)
        assertEquals(0.87, r50.confidence, 0.001)
        val r70 = jsDetector.detect(detectedFinding(persons = 1, personBest = 0.87), 0.70)
        assertEquals(DetectionOutcome.PERSON, r70.outcome)
    }

    @Test
    fun jsDetector_thresholdBoundaries() {
        // Exactly at the threshold counts as a person (>=, not >).
        assertEquals(DetectionOutcome.PERSON,
            jsDetector.detect(detectedFinding(persons = 1, personBest = 0.50), 0.50).outcome)
        assertEquals(DetectionOutcome.PERSON,
            jsDetector.detect(detectedFinding(faces = 1, faceBest = 0.70), 0.70).outcome)
        // 0.60 is a person at the 0.50 threshold but a weak signal at 0.70
        // — this is the pending Yakob decision (0.50 vs 0.70).
        assertEquals(DetectionOutcome.PERSON,
            jsDetector.detect(detectedFinding(persons = 1, personBest = 0.60), 0.50).outcome)
        val weak = jsDetector.detect(detectedFinding(persons = 1, personBest = 0.60), 0.70)
        assertEquals(DetectionOutcome.UNKNOWN, weak.outcome)
        assertTrue(weak.detail.contains("weak signal"))
        // Best score is the max of person and face.
        val r = jsDetector.detect(
            detectedFinding(persons = 1, personBest = 0.55, faces = 1, faceBest = 0.75), 0.70)
        assertEquals(DetectionOutcome.PERSON, r.outcome)
        assertEquals(0.75, r.confidence, 0.001)
    }

    @Test
    fun jsDetector_weakSignal_isUnknown() {
        // A reported person below the threshold is not a clear human —
        // and not clear either: UNKNOWN, never NO_PERSON.
        val r = jsDetector.detect(detectedFinding(persons = 1, personBest = 0.45), 0.70)
        assertEquals(DetectionOutcome.UNKNOWN, r.outcome)
        assertEquals(0.0, r.confidence, 0.001)
    }

    @Test
    fun jsDetector_noHuman_isNoPersonWithFullConfidence() {
        // Detectors ran, found nothing, no weak signal: positively clean.
        val r = jsDetector.detect(detectedFinding(), 0.70)
        assertEquals(DetectionOutcome.NO_PERSON, r.outcome)
        assertEquals(1.0, r.confidence, 0.001)
    }

    @Test
    fun jsDetector_scoreFloorBoundary() {
        // SCORE_FLOOR is 0.40: a 0.40 best with zero counts is a weak
        // signal (UNKNOWN); 0.39 is clean (NO_PERSON).
        assertEquals(0.40, JsReportedPersonDetector.SCORE_FLOOR, 0.001)
        val atFloor = jsDetector.detect(
            detectedFinding(persons = 0, personBest = 0.40), 0.70)
        assertEquals(DetectionOutcome.UNKNOWN, atFloor.outcome)
        assertTrue(atFloor.detail.contains("weak signal below human threshold"))
        val belowFloor = jsDetector.detect(
            detectedFinding(persons = 0, personBest = 0.39), 0.70)
        assertEquals(DetectionOutcome.NO_PERSON, belowFloor.outcome)
    }

    @Test
    fun jsDetector_detectionNotRan_isUnknown() {
        // No detector ran (no pixels, or BOTH detectors failed/timed
        // out — detectError carries the detail): UNKNOWN, never ALLOW.
        val r = jsDetector.detect(
            detectedFinding(detectionRan = false, detectError = "person: timeout ; face: timeout"),
            0.70)
        assertEquals(DetectionOutcome.UNKNOWN, r.outcome)
        assertTrue(r.detail.contains("no detector ran"))
        // Even a stale-looking best score must not rescue it.
        val r2 = jsDetector.detect(
            detectedFinding(persons = 1, personBest = 0.99, detectionRan = false), 0.70)
        assertEquals(DetectionOutcome.UNKNOWN, r2.outcome)
    }

    @Test
    fun decide_withJsDetector_endToEnd() {
        // The full path: JS numbers + policy threshold -> verdict.
        val engine = FilterEngine(jsDetector)
        assertEquals(Verdict.ALLOW,
            engine.decide(detectedFinding(), strictPolicy).verdict)
        assertEquals(Verdict.COVER,
            engine.decide(detectedFinding(persons = 1, personBest = 0.87), strictPolicy).verdict)
        // 0.60 person: covered at the 0.70 default, allowed as a person
        // (cover) at 0.50 — the threshold decides, not the code.
        val lowPolicy = strictPolicy.copy(autoDecideThreshold = 0.50)
        assertEquals(Verdict.COVER,
            engine.decide(detectedFinding(persons = 1, personBest = 0.60), lowPolicy).verdict)
        assertEquals(Verdict.REVIEW,
            engine.decide(detectedFinding(persons = 1, personBest = 0.60), strictPolicy).verdict)
        // No detector ran: REVIEW (covered), even with no thumbnail.
        assertEquals(Verdict.REVIEW,
            engine.decide(detectedFinding(detectionRan = false).copy(thumbnailDataUrl = null),
                strictPolicy).verdict)
        // Old content script (no detection fields at all): REVIEW.
        assertEquals(Verdict.REVIEW,
            engine.decide(finding(), strictPolicy).verdict)
    }

    // --- parseScanMessage: v1.2.0 detection fields ---------------------------

    @Test
    fun parseScanMessage_withDetectionFields() {
        val json = JSONObject(
            """{"type":"scan","pageUrl":"https://example.com/","findings":[
            |{"id":"a","kind":"img","source":"https://x/y.jpg","thumb":"data:,",
            | "persons":2,"personBest":0.87,"faces":1,"faceBest":0.62,
            | "detected":true,"detectError":""},
            |{"id":"b","kind":"video","playing":true,
            | "persons":0,"personBest":0.0,"faces":0,"faceBest":0.0,
            | "detected":false,"detectError":"person: timeout ; face: timeout"}]}""".trimMargin()
        )
        val findings = FilterEngine.parseScanMessage(json)
        assertEquals(2, findings.size)
        assertEquals(2, findings[0].persons)
        assertEquals(0.87, findings[0].personBest, 0.001)
        assertEquals(1, findings[0].faces)
        assertEquals(0.62, findings[0].faceBest, 0.001)
        assertTrue(findings[0].detectionRan)
        assertEquals("", findings[0].detectError)
        assertFalse(findings[1].detectionRan)
        assertTrue(findings[1].detectError.contains("timeout"))
        assertTrue(findings[1].isPlaying)
    }

    @Test
    fun parseScanMessage_detectionFieldsAbsent_defaultToNotRan() {
        // An old content script sends no detection fields: the finding
        // must default to detectionRan=false (stays covered, never
        // allowed) — not to zeros-with-detected=true.
        val json = JSONObject(
            """{"type":"scan","pageUrl":"https://example.com/","findings":[
            |{"id":"a","kind":"img"}]}""".trimMargin()
        )
        val f = FilterEngine.parseScanMessage(json)[0]
        assertFalse(f.detectionRan)
        assertEquals(0, f.persons)
        assertEquals(0.0, f.personBest, 0.001)
        assertEquals(0, f.faces)
        assertEquals(0.0, f.faceBest, 0.001)
        assertEquals("", f.detectError)
    }

    // --- rewriteSafeSearch ---------------------------------------------------

    @Test
    fun rewriteSafeSearch_google() {
        assertEquals(
            "https://www.google.com/search?q=cats&safe=active",
            FilterEngine.rewriteSafeSearch("https://www.google.com/search?q=cats", true))
        // Country domain, no www, existing other params preserved.
        assertEquals(
            "https://google.co.uk/search?q=cats&hl=en&safe=active",
            FilterEngine.rewriteSafeSearch("https://google.co.uk/search?q=cats&hl=en", true))
        assertEquals(
            "https://google.com.au/search?q=cats&safe=active",
            FilterEngine.rewriteSafeSearch("https://google.com.au/search?q=cats", true))
        // Images search is still /search.
        assertEquals(
            "https://www.google.de/search?q=cats&tbm=isch&safe=active",
            FilterEngine.rewriteSafeSearch("https://www.google.de/search?q=cats&tbm=isch", true))
        // Wrong value is replaced in place, not duplicated.
        assertEquals(
            "https://www.google.com/search?q=cats&safe=active",
            FilterEngine.rewriteSafeSearch("https://www.google.com/search?q=cats&safe=off", true))
    }

    @Test
    fun rewriteSafeSearch_bingAndDuckDuckGo() {
        assertEquals(
            "https://www.bing.com/search?q=cats&adlt=strict",
            FilterEngine.rewriteSafeSearch("https://www.bing.com/search?q=cats", true))
        assertEquals(
            "https://duckduckgo.com/?q=cats&kp=1",
            FilterEngine.rewriteSafeSearch("https://duckduckgo.com/?q=cats", true))
        assertEquals(
            "https://duckduckgo.com/html/?q=cats&kp=1",
            FilterEngine.rewriteSafeSearch("https://duckduckgo.com/html/?q=cats", true))
    }

    @Test
    fun rewriteSafeSearch_alreadyTagged_returnsNull() {
        // Idempotent: a rewritten URL passed back in returns null, so
        // the navigation delegate can never loop.
        assertNull(FilterEngine.rewriteSafeSearch(
            "https://www.google.com/search?q=cats&safe=active", true))
        assertNull(FilterEngine.rewriteSafeSearch(
            "https://www.bing.com/search?q=cats&adlt=strict", true))
        assertNull(FilterEngine.rewriteSafeSearch(
            "https://duckduckgo.com/?q=cats&kp=1", true))
        // ...including when the param is first and when a fragment is present.
        assertNull(FilterEngine.rewriteSafeSearch(
            "https://www.google.com/search?safe=active&q=cats", true))
        assertNull(FilterEngine.rewriteSafeSearch(
            "https://www.google.com/search?q=cats&safe=active#top", true))
    }

    @Test
    fun rewriteSafeSearch_notApplicable_returnsNull() {
        // forceSafeSearch off: never rewrite.
        assertNull(FilterEngine.rewriteSafeSearch(
            "https://www.google.com/search?q=cats", false))
        // Not a search URL: homepage, other paths, other engines.
        assertNull(FilterEngine.rewriteSafeSearch("https://www.google.com/", true))
        assertNull(FilterEngine.rewriteSafeSearch("https://www.google.com/maps?q=cats", true))
        assertNull(FilterEngine.rewriteSafeSearch("https://www.bing.com/", true))
        assertNull(FilterEngine.rewriteSafeSearch("https://example.com/search?q=cats", true))
        // DuckDuckGo without a query is not a search.
        assertNull(FilterEngine.rewriteSafeSearch("https://duckduckgo.com/", true))
        // Non-https / lookalike hosts do not match.
        assertNull(FilterEngine.rewriteSafeSearch("http://www.google.com/search?q=cats", true))
        assertNull(FilterEngine.rewriteSafeSearch("https://notgoogle.com/search?q=cats", true))
    }

    // --- matchedBlockedHost --------------------------------------------------

    @Test
    fun matchedBlockedHost_matches() {
        val blocked = setOf("facebook.com", "example-bad.org")
        assertEquals("facebook.com",
            FilterEngine.matchedBlockedHost("https://facebook.com/x", blocked))
        assertEquals("facebook.com",
            FilterEngine.matchedBlockedHost("https://www.facebook.com/", blocked))
        assertEquals("example-bad.org",
            FilterEngine.matchedBlockedHost("https://sub.example-bad.org/", blocked))
        assertNull(FilterEngine.matchedBlockedHost("https://example.com/", blocked))
        assertNull(FilterEngine.matchedBlockedHost("https://notfacebook.com/", blocked))
        // No host (data: URL) never matches.
        assertNull(FilterEngine.matchedBlockedHost("data:text/html,hi", blocked))
        assertNull(FilterEngine.matchedBlockedHost("", blocked))
    }

    // --- escapeHtml ----------------------------------------------------------

    @Test
    fun escapeHtml_escapes() {
        assertEquals("facebook.com", FilterEngine.escapeHtml("facebook.com"))
        assertEquals("&lt;script&gt; &amp; &quot;q&quot; &#39;s&#39;",
            FilterEngine.escapeHtml("<script> & \"q\" 's'"))
    }
}
