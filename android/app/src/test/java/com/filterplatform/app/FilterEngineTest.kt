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

    // "/9j/4A==" is valid base64 for the 4-byte JPEG SOI start FF D8 FF E0
    // (the old placeholder "/9j/4AAQ==" was not valid base64 — it never
    // mattered until 0.2.2, when RfDetrPersonDetector actually decodes it).
    private val thumb = "data:image/jpeg;base64,/9j/4A=="
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
    fun stubDetector_neverAllowsDynamic() {
        // BEHAVIOUR CHANGE (0.3.1, Yakob req 4): the old version of
        // this test asserted REVIEW for an unscanned HTML_IMAGE. A
        // no-data UNKNOWN on a STATIC kind is now ALLOW unscanned
        // (no person signal — see stubDetector_unscannedImageAllows).
        // A dynamic surface that cannot be proven clean still stays
        // REVIEW: the stub (no model at all) never allows it.
        val engine = FilterEngine(StubPersonDetector())
        val d = engine.decide(finding(ContentType.WEBGL), strictPolicy)
        assertEquals(Verdict.REVIEW, d.verdict)
        assertEquals(Verdict.REVIEW,
            engine.decide(finding(ContentType.VIDEO_FRAME), strictPolicy).verdict)
    }

    @Test
    fun stubDetector_unscannedImageAllows() {
        // BEHAVIOUR CHANGE (0.3.1, Yakob req 4): no detector produced
        // any signal for this image, and there is no person signal —
        // a static image is left visible (unscanned), not covered.
        val engine = FilterEngine(StubPersonDetector())
        val d = engine.decide(finding(), strictPolicy)
        assertEquals(Verdict.ALLOW, d.verdict)
        assertTrue(d.unscanned)
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
        assertEquals(HumanImageMode.PAINT, FilterEngine.DEFAULT_POLICY.humanImageMode)
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
        // BEHAVIOUR CHANGE (0.3.1, Yakob req 4): no detector ran on a
        // STATIC image is now ALLOW unscanned (was REVIEW) — there is
        // no person signal. A dynamic surface with no detector ran
        // still stays REVIEW.
        val unscannedImg = engine.decide(
            detectedFinding(detectionRan = false).copy(thumbnailDataUrl = null),
            strictPolicy)
        assertEquals(Verdict.ALLOW, unscannedImg.verdict)
        assertTrue(unscannedImg.unscanned)
        assertEquals(Verdict.REVIEW,
            engine.decide(
                detectedFinding(detectionRan = false).copy(type = ContentType.WEBGL),
                strictPolicy).verdict)
        // Old content script (no detection fields at all): same
        // unscanned-image rule — ALLOW unscanned (was REVIEW).
        val oldScript = engine.decide(finding(), strictPolicy)
        assertEquals(Verdict.ALLOW, oldScript.verdict)
        assertTrue(oldScript.unscanned)
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

    // --- RF-DETR Nano score mapping (pure, no ORT) ---------------------------
    //
    // The mapping is the fail-closed contract: PERSON at/above the policy
    // threshold, UNKNOWN for a weak signal in [0.40, threshold) or for no
    // score at all, NO_PERSON only when the model ran and its best person
    // score stayed below the 0.40 floor.

    @Test
    fun rfDetrMapping_personAboveThreshold() {
        val r = RfDetrPersonDetector.mapBestPersonScore(0.87, 0.70)
        assertEquals(DetectionOutcome.PERSON, r.outcome)
        assertEquals(0.87, r.confidence, 0.001)
        // Same score clears the 0.50 threshold too.
        assertEquals(DetectionOutcome.PERSON,
            RfDetrPersonDetector.mapBestPersonScore(0.87, 0.50).outcome)
    }

    @Test
    fun rfDetrMapping_thresholdBoundary() {
        // Exactly at the threshold counts as a person (>=, not >).
        assertEquals(DetectionOutcome.PERSON,
            RfDetrPersonDetector.mapBestPersonScore(0.70, 0.70).outcome)
        assertEquals(DetectionOutcome.PERSON,
            RfDetrPersonDetector.mapBestPersonScore(0.50, 0.50).outcome)
    }

    @Test
    fun rfDetrMapping_thresholdDecides() {
        // 0.60 is a person at the 0.50 threshold but a weak signal at
        // 0.70 — the pending Yakob decision (0.50 vs 0.70), same as the
        // JS detector. The benchmark's distant beach walker scores 0.568:
        // found at 0.50, missed at 0.70.
        assertEquals(DetectionOutcome.PERSON,
            RfDetrPersonDetector.mapBestPersonScore(0.60, 0.50).outcome)
        assertEquals(DetectionOutcome.PERSON,
            RfDetrPersonDetector.mapBestPersonScore(0.568, 0.50).outcome)
        val weak = RfDetrPersonDetector.mapBestPersonScore(0.60, 0.70)
        assertEquals(DetectionOutcome.UNKNOWN, weak.outcome)
        assertTrue(weak.detail.contains("weak signal"))
        assertEquals(DetectionOutcome.UNKNOWN,
            RfDetrPersonDetector.mapBestPersonScore(0.568, 0.70).outcome)
    }

    @Test
    fun rfDetrMapping_weakSignalIsUnknown() {
        val r = RfDetrPersonDetector.mapBestPersonScore(0.45, 0.70)
        assertEquals(DetectionOutcome.UNKNOWN, r.outcome)
        assertEquals(0.0, r.confidence, 0.001)
    }

    @Test
    fun rfDetrMapping_scoreFloorBoundary() {
        // SCORE_FLOOR is 0.40, same as the JS detector: 0.40 is a weak
        // signal (UNKNOWN); 0.39 is clean (NO_PERSON, confidence 1.0).
        assertEquals(0.40, RfDetrPersonDetector.SCORE_FLOOR, 0.001)
        assertEquals(DetectionOutcome.UNKNOWN,
            RfDetrPersonDetector.mapBestPersonScore(0.40, 0.70).outcome)
        val clean = RfDetrPersonDetector.mapBestPersonScore(0.39, 0.70)
        assertEquals(DetectionOutcome.NO_PERSON, clean.outcome)
        assertEquals(1.0, clean.confidence, 0.001)
        // The benchmark's worst no-person photo scores 0.219 — clean.
        assertEquals(DetectionOutcome.NO_PERSON,
            RfDetrPersonDetector.mapBestPersonScore(0.219, 0.70).outcome)
    }

    @Test
    fun rfDetrMapping_noScoreIsUnknown() {
        // Null = model not loaded / inference failed: UNKNOWN, never
        // NO_PERSON on a guess.
        val r = RfDetrPersonDetector.mapBestPersonScore(null, 0.70)
        assertEquals(DetectionOutcome.UNKNOWN, r.outcome)
        assertEquals(0.0, r.confidence, 0.001)
    }

    @Test
    fun rfDetrMapping_zeroScoreIsNoPerson() {
        val r = RfDetrPersonDetector.mapBestPersonScore(0.0, 0.70)
        assertEquals(DetectionOutcome.NO_PERSON, r.outcome)
        assertEquals(1.0, r.confidence, 0.001)
    }

    // --- RfDetrPersonDetector with a fake backend ----------------------------

    /** Fake ORT backend: canned score, canned decode result. */
    private class FakeRfDetrBackend(
        private val score: Double? = null,
        private val decodeResult: DecodedImage? = DecodedImage(IntArray(4), 2, 2)
    ) : RfDetrBackend {
        var lastJpegBytes: ByteArray? = null
        override fun decodeJpeg(jpegBytes: ByteArray): DecodedImage? {
            lastJpegBytes = jpegBytes
            return decodeResult
        }

        override fun bestPersonScore(image: DecodedImage): Double? = score
    }

    @Test
    fun rfDetrDetector_noBackendIsUnknown() {
        // No backend wired in (should not happen in the shipped app,
        // which always passes RfDetrOrtBackend): UNKNOWN, never ALLOW.
        val r = RfDetrPersonDetector().detect(finding(), 0.70)
        assertEquals(DetectionOutcome.UNKNOWN, r.outcome)
        assertTrue(r.detail.contains("not available"))
    }

    @Test
    fun rfDetrDetector_noThumbnailIsUnknown() {
        val d = RfDetrPersonDetector(FakeRfDetrBackend(score = 0.01))
        val r = d.detect(finding(thumbnail = null), 0.70)
        assertEquals(DetectionOutcome.UNKNOWN, r.outcome)
        assertTrue(r.detail.contains("no thumbnail"))
    }

    @Test
    fun rfDetrDetector_malformedThumbnailIsUnknown() {
        val d = RfDetrPersonDetector(FakeRfDetrBackend(score = 0.01))
        val r = d.detect(
            finding(thumbnail = "data:image/jpeg;base64,!!!not-base64!!!"), 0.70)
        assertEquals(DetectionOutcome.UNKNOWN, r.outcome)
    }

    @Test
    fun rfDetrDetector_decodeFailureIsUnknown() {
        val d = RfDetrPersonDetector(FakeRfDetrBackend(score = 0.01, decodeResult = null))
        val r = d.detect(finding(), 0.70)
        assertEquals(DetectionOutcome.UNKNOWN, r.outcome)
    }

    @Test
    fun rfDetrDetector_nullScoreIsUnknown() {
        // Backend ran but produced no score (model not loaded / inference
        // failed inside the backend): UNKNOWN.
        val d = RfDetrPersonDetector(FakeRfDetrBackend(score = null))
        assertEquals(DetectionOutcome.UNKNOWN, d.detect(finding(), 0.70).outcome)
    }

    @Test
    fun rfDetrDetector_scoreMappingApplies() {
        assertEquals(DetectionOutcome.PERSON,
            RfDetrPersonDetector(FakeRfDetrBackend(score = 0.87))
                .detect(finding(), 0.70).outcome)
        assertEquals(DetectionOutcome.NO_PERSON,
            RfDetrPersonDetector(FakeRfDetrBackend(score = 0.20))
                .detect(finding(), 0.70).outcome)
        assertEquals(DetectionOutcome.UNKNOWN,
            RfDetrPersonDetector(FakeRfDetrBackend(score = 0.55))
                .detect(finding(), 0.70).outcome)
    }

    @Test
    fun rfDetrDetector_thumbnailBytesReachBackend() {
        // The data URL is base64-decoded before the backend sees it:
        // "/9j/4A==" is the 4-byte JPEG SOI marker start.
        val backend = FakeRfDetrBackend(score = 0.01)
        RfDetrPersonDetector(backend).detect(finding(), 0.70)
        val bytes = backend.lastJpegBytes
        assertEquals(4, bytes?.size)
        assertEquals(0xFF.toByte(), bytes?.get(0))
        assertEquals(0xD8.toByte(), bytes?.get(1))
        assertEquals(0xFF.toByte(), bytes?.get(2))
        assertEquals(0xE0.toByte(), bytes?.get(3))
    }

    @Test
    fun rfDetrDecodeDataUrl() {
        val bytes = RfDetrPersonDetector.decodeDataUrl("data:image/jpeg;base64,/9j/4A==")
        assertEquals(4, bytes?.size)
        // Bare base64 (no data: prefix) is accepted too.
        assertEquals(4, RfDetrPersonDetector.decodeDataUrl("/9j/4A==")?.size)
        assertNull(RfDetrPersonDetector.decodeDataUrl("data:image/jpeg;base64,!!!"))
        assertNull(RfDetrPersonDetector.decodeDataUrl(""))
        assertNull(RfDetrPersonDetector.decodeDataUrl("data:image/jpeg;base64,"))
    }

    // --- CombinedPersonDetector ----------------------------------------------

    private fun combined(vararg detectors: PersonDetector) =
        CombinedPersonDetector(detectors.toList())

    @Test
    fun combined_personWinsEitherSide() {
        // JS says person, RF says clean -> PERSON (OR for PERSON).
        val a = combined(
            FixedDetector(DetectionResult(DetectionOutcome.PERSON, 0.9)),
            RfDetrPersonDetector(FakeRfDetrBackend(score = 0.01))
        )
        assertEquals(DetectionOutcome.PERSON, a.detect(finding(), 0.70).outcome)
        // RF says person, JS says clean -> PERSON.
        val b = combined(
            jsDetector,
            RfDetrPersonDetector(FakeRfDetrBackend(score = 0.95))
        )
        val r = b.detect(detectedFinding(), 0.70)
        assertEquals(DetectionOutcome.PERSON, r.outcome)
        assertEquals(0.95, r.confidence, 0.001)
    }

    @Test
    fun combined_noPersonRequiresAll() {
        // Both clean -> NO_PERSON, confidence 1.0.
        val bothClean = combined(
            jsDetector,
            RfDetrPersonDetector(FakeRfDetrBackend(score = 0.05))
        )
        val r = bothClean.detect(detectedFinding(), 0.70)
        assertEquals(DetectionOutcome.NO_PERSON, r.outcome)
        assertEquals(1.0, r.confidence, 0.001)
    }

    @Test
    fun combined_unknownVetoesNoPerson() {
        // BEHAVIOUR CHANGE (0.3.1, Yakob req 4): only a WEAK-signal
        // UNKNOWN vetoes a clean verdict now. A NO-DATA unknown (no
        // thumbnail, no detector ran) does not — it is the absence of
        // a signal, not a signal.
        // JS clean but RF undecided for lack of a thumbnail -> NO_PERSON.
        val a = combined(
            jsDetector,
            RfDetrPersonDetector(FakeRfDetrBackend(score = 0.01))
        )
        assertEquals(DetectionOutcome.NO_PERSON,
            a.detect(detectedFinding().copy(thumbnailDataUrl = null), 0.70).outcome)
        // RF clean but JS undecided (detector never ran — no data) -> NO_PERSON.
        val b = combined(
            jsDetector,
            RfDetrPersonDetector(FakeRfDetrBackend(score = 0.01))
        )
        assertEquals(DetectionOutcome.NO_PERSON,
            b.detect(detectedFinding(detectionRan = false), 0.70).outcome)
        // One weak signal is still enough to veto.
        val c = combined(
            jsDetector,
            RfDetrPersonDetector(FakeRfDetrBackend(score = 0.55))
        )
        assertEquals(DetectionOutcome.UNKNOWN,
            c.detect(detectedFinding(), 0.70).outcome)
        // ...and a weak JS signal vetoes an RF clean verdict too.
        val d = combined(
            jsDetector,
            RfDetrPersonDetector(FakeRfDetrBackend(score = 0.01))
        )
        val weakJs = d.detect(
            detectedFinding(persons = 1, personBest = 0.45), 0.70)
        assertEquals(DetectionOutcome.UNKNOWN, weakJs.outcome)
        assertFalse(weakJs.noData)
    }

    @Test
    fun combined_noDataUnknownIsNoData() {
        // All detectors no-data -> combined UNKNOWN with noData=true,
        // so decide() can apply its kind-aware unscanned rule.
        val d = combined(
            StubPersonDetector(),
            RfDetrPersonDetector(FakeRfDetrBackend(score = 0.01))
        )
        val r = d.detect(finding(thumbnail = null), 0.70)
        assertEquals(DetectionOutcome.UNKNOWN, r.outcome)
        assertTrue(r.noData)
        // One clean verdict plus one no-data unknown -> NO_PERSON.
        val e = combined(
            FixedDetector(DetectionResult(DetectionOutcome.NO_PERSON, 1.0)),
            FixedDetector(DetectionResult(DetectionOutcome.UNKNOWN, 0.0,
                "no thumbnail", noData = true))
        )
        assertEquals(DetectionOutcome.NO_PERSON, e.detect(finding(), 0.70).outcome)
        // Same, but the unknown is a WEAK signal -> UNKNOWN, noData=false.
        val f = combined(
            FixedDetector(DetectionResult(DetectionOutcome.NO_PERSON, 1.0)),
            FixedDetector(DetectionResult(DetectionOutcome.UNKNOWN, 0.0,
                "weak signal 0.45", noData = false))
        )
        val rf = f.detect(finding(), 0.70)
        assertEquals(DetectionOutcome.UNKNOWN, rf.outcome)
        assertFalse(rf.noData)
    }

    @Test
    fun combined_allUnknownIsUnknown() {
        val d = combined(StubPersonDetector(), StubPersonDetector())
        assertEquals(DetectionOutcome.UNKNOWN, d.detect(finding(), 0.70).outcome)
    }

    @Test
    fun combined_emptyListIsUnknown() {
        // No detectors configured means no decision — fail closed.
        assertEquals(DetectionOutcome.UNKNOWN,
            CombinedPersonDetector(emptyList()).detect(finding(), 0.70).outcome)
    }

    @Test
    fun combined_noPersonConfidenceIsMinimum() {
        // A detector reporting NO_PERSON with low confidence drags the
        // combined confidence down (FilterEngine then reviews it).
        val d = combined(
            FixedDetector(DetectionResult(DetectionOutcome.NO_PERSON, 0.6)),
            FixedDetector(DetectionResult(DetectionOutcome.NO_PERSON, 1.0))
        )
        val r = d.detect(finding(), 0.70)
        assertEquals(DetectionOutcome.NO_PERSON, r.outcome)
        assertEquals(0.6, r.confidence, 0.001)
    }

    // --- combined detector end to end ----------------------------------------

    @Test
    fun decide_withCombinedDetector_endToEnd() {
        val engine = FilterEngine(combined(
            jsDetector,
            RfDetrPersonDetector(FakeRfDetrBackend(score = 0.05))
        ))
        // Both clean -> ALLOW.
        assertEquals(Verdict.ALLOW,
            engine.decide(detectedFinding(), strictPolicy).verdict)
        // RF sees a person the JS detectors missed -> COVER.
        val enginePerson = FilterEngine(combined(
            jsDetector,
            RfDetrPersonDetector(FakeRfDetrBackend(score = 0.98))
        ))
        assertEquals(Verdict.COVER,
            enginePerson.decide(detectedFinding(), strictPolicy).verdict)
        // JS sees a person RF missed -> COVER (PERSON wins either side).
        val engineJsPerson = FilterEngine(combined(
            jsDetector,
            RfDetrPersonDetector(FakeRfDetrBackend(score = 0.01))
        ))
        assertEquals(Verdict.COVER,
            engineJsPerson.decide(
                detectedFinding(persons = 1, personBest = 0.87), strictPolicy).verdict)
        // BEHAVIOUR CHANGE (0.3.1, Yakob req 4): no thumbnail means
        // RF answers no-data UNKNOWN, which no longer vetoes the JS
        // clean verdict — ALLOW (was REVIEW in 0.2.2).
        assertEquals(Verdict.ALLOW,
            engine.decide(
                detectedFinding().copy(thumbnailDataUrl = null), strictPolicy).verdict)
    }

    // --- 0.3.1 decide() rules: kind-aware unscanned, cached decisions --

    @Test
    fun decide_unscannedStaticKinds_allowUnscanned() {
        // No signal at all (stub = no model): static kinds allow.
        val engine = FilterEngine(StubPersonDetector())
        for (type in listOf(
            ContentType.HTML_IMAGE, ContentType.CSS_BACKGROUND, ContentType.SVG
        )) {
            val d = engine.decide(finding(type), strictPolicy)
            assertEquals("type $type", Verdict.ALLOW, d.verdict)
            assertTrue("type $type", d.unscanned)
        }
    }

    @Test
    fun decide_unscannedDynamicKinds_stayCovered() {
        // Same no-signal finding, dynamic kinds: REVIEW (fail closed —
        // a surface that cannot be snapshotted cannot be proven clean).
        val engine = FilterEngine(StubPersonDetector())
        for (type in listOf(
            ContentType.CANVAS, ContentType.WEBGL, ContentType.VIDEO_FRAME,
            ContentType.LIVE_STREAM, ContentType.DYNAMIC
        )) {
            val d = engine.decide(finding(type), strictPolicy)
            assertEquals("type $type", Verdict.REVIEW, d.verdict)
            assertFalse("type $type", d.unscanned)
        }
    }

    @Test
    fun decide_weakSignal_isReviewEvenForImages() {
        // A weak but REAL signal is genuinely uncertain — REVIEW,
        // never the unscanned ALLOW. (The unscanned rule keys on
        // noData, not on "no person found".)
        val engine = FilterEngine(jsDetector)
        val d = engine.decide(
            detectedFinding(persons = 1, personBest = 0.45), strictPolicy)
        assertEquals(Verdict.REVIEW, d.verdict)
        assertFalse(d.unscanned)
        val d2 = engine.decide(
            detectedFinding(persons = 0, personBest = 0.40), strictPolicy)
        assertEquals(Verdict.REVIEW, d2.verdict)
    }

    @Test
    fun decide_personIsCoverNotPainted() {
        // The INITIAL verdict for a confirmed person is COVER (the
        // user must request a review for paint/block); decide() never
        // paints on its own, in either human-image mode.
        val engine = FilterEngine(jsDetector)
        val person = detectedFinding(persons = 1, personBest = 0.87)
        assertEquals(Verdict.COVER, engine.decide(person, strictPolicy).verdict)
        val paintPolicy = strictPolicy.copy(humanImageMode = HumanImageMode.PAINT)
        assertEquals(Verdict.COVER, engine.decide(person, paintPolicy).verdict)
        val blockPolicy2 = strictPolicy.copy(humanImageMode = HumanImageMode.BLOCK)
        assertEquals(Verdict.COVER, engine.decide(person, blockPolicy2).verdict)
    }

    @Test
    fun decide_cachedDecision_honouredVerbatim() {
        // A reviewed image is never re-decided: even a detector that
        // would say PERSON does not override the cached decision.
        val engine = FilterEngine(jsDetector)
        val base = detectedFinding(persons = 1, personBest = 0.95)
        val box = PersonBox(0.1, 0.1, 0.5, 0.6, 0.9)
        val painted = engine.decide(
            base.copy(cachedDecision = CachedDecision("allow_painted", listOf(box))),
            strictPolicy)
        assertEquals(Verdict.PAINTED, painted.verdict)
        assertEquals(listOf(box), painted.boxes)
        assertEquals(Verdict.ALLOW,
            engine.decide(
                base.copy(cachedDecision = CachedDecision("allow")),
                strictPolicy).verdict)
        assertEquals(Verdict.BLOCK,
            engine.decide(
                base.copy(cachedDecision = CachedDecision("block")),
                strictPolicy).verdict)
        assertEquals(Verdict.REVIEW,
            engine.decide(
                base.copy(cachedDecision = CachedDecision("uncertain")),
                strictPolicy).verdict)
        // An unknown decision string falls through to detection.
        assertEquals(Verdict.COVER,
            engine.decide(
                base.copy(cachedDecision = CachedDecision("nonsense")),
                strictPolicy).verdict)
    }

    // --- 0.3.1 review decisions ------------------------------------------

    private val smallBox = PersonBox(0.1, 0.1, 0.4, 0.4, 0.9) // area 0.16
    private val bigBox = PersonBox(0.0, 0.0, 0.9, 0.9, 0.98) // area 0.81
    private val midBox = PersonBox(0.1, 0.1, 0.6, 0.5, 0.9) // area 0.30

    @Test
    fun reviewDecision_bands() {
        // best < 0.30 -> allow; [0.30, 0.50) -> uncertain; >= 0.50
        // -> painted (small box, paint mode) or block.
        assertEquals(ReviewDecision.ALLOW,
            FilterEngine.reviewDecision(0.0, emptyList(), HumanImageMode.PAINT))
        assertEquals(ReviewDecision.ALLOW,
            FilterEngine.reviewDecision(0.29, emptyList(), HumanImageMode.PAINT))
        assertEquals(ReviewDecision.UNCERTAIN,
            FilterEngine.reviewDecision(0.30, listOf(smallBox), HumanImageMode.PAINT))
        assertEquals(ReviewDecision.UNCERTAIN,
            FilterEngine.reviewDecision(0.49, listOf(smallBox), HumanImageMode.PAINT))
        assertEquals(ReviewDecision.ALLOW_PAINTED,
            FilterEngine.reviewDecision(0.50, listOf(smallBox), HumanImageMode.PAINT))
        assertEquals(ReviewDecision.ALLOW_PAINTED,
            FilterEngine.reviewDecision(0.98, listOf(smallBox), HumanImageMode.PAINT))
    }

    @Test
    fun reviewDecision_areaRule_paintMode() {
        // Largest single box area > 0.60 -> block even in paint mode
        // (the p1 portrait decodes to a 0.998 x 0.965 box, area 0.96).
        assertEquals(ReviewDecision.BLOCK,
            FilterEngine.reviewDecision(0.98, listOf(bigBox), HumanImageMode.PAINT))
        // Sum of areas > 0.60 -> block, even when no single box is big.
        assertEquals(ReviewDecision.BLOCK,
            FilterEngine.reviewDecision(0.90,
                listOf(midBox, midBox, midBox), HumanImageMode.PAINT))
        // Exactly 0.60 is NOT over the limit: two 0.30 boxes sum to
        // 0.60 exactly -> painted (the rule is strictly greater).
        assertEquals(ReviewDecision.ALLOW_PAINTED,
            FilterEngine.reviewDecision(0.90,
                listOf(midBox, midBox), HumanImageMode.PAINT))
        // One 0.30 box alone -> painted.
        assertEquals(ReviewDecision.ALLOW_PAINTED,
            FilterEngine.reviewDecision(0.90,
                listOf(midBox), HumanImageMode.PAINT))
    }

    @Test
    fun reviewDecision_areaRule_blockMode() {
        // Block mode blocks a confirmed person whatever the boxes are.
        assertEquals(ReviewDecision.BLOCK,
            FilterEngine.reviewDecision(0.98, listOf(smallBox), HumanImageMode.BLOCK))
        assertEquals(ReviewDecision.BLOCK,
            FilterEngine.reviewDecision(0.50, listOf(smallBox), HumanImageMode.BLOCK))
        // ...but the uncertain / allow bands still apply in block mode.
        assertEquals(ReviewDecision.UNCERTAIN,
            FilterEngine.reviewDecision(0.40, listOf(smallBox), HumanImageMode.BLOCK))
        assertEquals(ReviewDecision.ALLOW,
            FilterEngine.reviewDecision(0.10, emptyList(), HumanImageMode.BLOCK))
    }

    @Test
    fun reviewDecision_confirmedPersonWithoutBoxes_blocks() {
        // A confirmed person with nothing to paint cannot be shown
        // painted — the whole picture is blocked instead.
        assertEquals(ReviewDecision.BLOCK,
            FilterEngine.reviewDecision(0.95, emptyList(), HumanImageMode.PAINT))
    }

    // --- 0.3.1 RF-DETR box decode (pure, cxcywh verified) ---------------

    /** Labels for [n] queries: every slot -10 (sigmoid ~0) except the
     *  given (query, logit) overrides. A zero-filled labels array
     *  would read as 0.5 everywhere — this helper avoids that trap. */
    private fun labelsWith(vararg overrides: Pair<Int, Double>): FloatArray {
        val labels = FloatArray(RfDetrPersonDetector.NUM_QUERIES *
            RfDetrPersonDetector.NUM_CLASSES) { -10f }
        for ((q, logit) in overrides) {
            labels[q * RfDetrPersonDetector.NUM_CLASSES +
                RfDetrPersonDetector.PERSON_SLOT] = logit.toFloat()
        }
        return labels
    }

    @Test
    fun decodePersonDetections_cxcywhPortrait() {
        // The empirical check (2026-11-19): the p1 portrait's top
        // query is dets [0.500, 0.510, 0.998, 0.965] at score 0.981
        // (logit ~3.94). As cxcywh that is the full-frame portrait;
        // as xyxy it would be a bottom-right quadrant box.
        val dets = FloatArray(300 * 4)
        dets[0] = 0.500185f; dets[1] = 0.509599f
        dets[2] = 0.997952f; dets[3] = 0.964976f
        val decoded = RfDetrPersonDetector.decodePersonDetections(
            dets, labelsWith(0 to 3.944))
        assertEquals(0.981, decoded.bestScore, 0.002)
        assertEquals(1, decoded.boxes.size)
        val b = decoded.boxes[0]
        assertEquals(0.001, b.x, 0.002)
        assertEquals(0.027, b.y, 0.002)
        assertEquals(0.998, b.w, 0.002)
        assertEquals(0.965, b.h, 0.002)
        assertEquals(0.981, b.score, 0.002)
        // Area 0.963 > 0.60: the review blocks even in paint mode.
        assertEquals(ReviewDecision.BLOCK,
            FilterEngine.reviewDecision(
                decoded.bestScore, decoded.boxes, HumanImageMode.PAINT))
    }

    @Test
    fun decodePersonDetections_tinyDistantBox() {
        // The d3 beach walker: dets [0.855, 0.648, 0.012, 0.026] at
        // 0.568 — a small distant figure. Read as xyxy this would be
        // a NEGATIVE width (x2=0.012 < x1=0.855); as cxcywh it is a
        // real tiny box.
        val dets = FloatArray(300 * 4)
        dets[0] = 0.855192f; dets[1] = 0.648129f
        dets[2] = 0.011566f; dets[3] = 0.026075f
        val decoded = RfDetrPersonDetector.decodePersonDetections(
            dets, labelsWith(0 to 0.274))
        assertEquals(0.568, decoded.bestScore, 0.002)
        assertEquals(1, decoded.boxes.size)
        val b = decoded.boxes[0]
        assertEquals(0.849, b.x, 0.002)
        assertEquals(0.635, b.y, 0.002)
        assertEquals(0.012, b.w, 0.002)
        assertEquals(0.026, b.h, 0.002)
    }

    @Test
    fun decodePersonDetections_thresholdAndBest() {
        // Best score is the max over ALL queries, even below the box
        // threshold; boxes only include queries >= 0.30.
        val dets = FloatArray(300 * 4)
        dets[0] = 0.5f; dets[1] = 0.5f; dets[2] = 0.2f; dets[3] = 0.2f
        dets[4] = 0.2f; dets[5] = 0.2f; dets[6] = 0.1f; dets[7] = 0.1f
        // q0 logit for 0.45, q1 logit for 0.10, rest ~0.
        val decoded = RfDetrPersonDetector.decodePersonDetections(
            dets, labelsWith(0 to -0.201, 1 to -2.197))
        assertEquals(0.45, decoded.bestScore, 0.002)
        assertEquals(1, decoded.boxes.size)
        assertEquals(0.45, decoded.boxes[0].score, 0.002)
        // Nothing above threshold: best is still the true max, boxes empty.
        val none = RfDetrPersonDetector.decodePersonDetections(
            FloatArray(300 * 4), labelsWith())
        assertEquals(0.0, none.bestScore, 0.01)
        assertTrue(none.boxes.isEmpty())
    }

    @Test
    fun decodePersonDetections_clipsToFrame() {
        // A box hanging off the frame edge is trimmed, not dropped.
        val dets = FloatArray(300 * 4)
        dets[0] = 0.95f; dets[1] = 0.95f; dets[2] = 0.4f; dets[3] = 0.4f
        val decoded = RfDetrPersonDetector.decodePersonDetections(
            dets, labelsWith(0 to 2.0))
        assertEquals(1, decoded.boxes.size)
        val b = decoded.boxes[0]
        assertEquals(0.75, b.x, 0.001)
        assertEquals(0.75, b.y, 0.001)
        assertEquals(0.25, b.w, 0.001)
        assertEquals(0.25, b.h, 0.001)
    }

    // --- 0.3.1 parse/build round-trip ------------------------------------

    @Test
    fun parseScanMessage_withBoxesAndCachedDecision() {
        val json = JSONObject(
            """{"type":"scan","pageUrl":"https://example.com/","findings":[
            |{"id":"a","kind":"img","source":"https://x/y.jpg","thumb":"data:,",
            | "persons":1,"personBest":0.87,"faces":0,"faceBest":0.0,
            | "detected":true,"detectError":"",
            | "boxes":[{"x":0.1,"y":0.2,"w":0.5,"h":0.6,"score":0.87}],
            | "image_key":"u:abc123",
            | "cachedDecision":{"decision":"allow_painted",
            |   "boxes":[{"x":0.1,"y":0.2,"w":0.5,"h":0.6,"score":0.87}]}}]}""".trimMargin()
        )
        val f = FilterEngine.parseScanMessage(json)[0]
        assertEquals(1, f.boxes.size)
        assertEquals(0.1, f.boxes[0].x, 0.001)
        assertEquals(0.6, f.boxes[0].h, 0.001)
        assertEquals(0.87, f.boxes[0].score, 0.001)
        assertEquals("u:abc123", f.imageKey)
        assertEquals("allow_painted", f.cachedDecision?.decision)
        assertEquals(1, f.cachedDecision?.boxes?.size)
    }

    @Test
    fun parseScanMessage_boxesAndCacheAbsent_defaultEmpty() {
        // The pre-sync Android script sends neither: empty, not null.
        val json = JSONObject(
            """{"type":"scan","pageUrl":"https://example.com/","findings":[
            |{"id":"a","kind":"img"}]}""".trimMargin()
        )
        val f = FilterEngine.parseScanMessage(json)[0]
        assertTrue(f.boxes.isEmpty())
        assertNull(f.imageKey)
        assertNull(f.cachedDecision)
    }

    @Test
    fun parseScanMessage_malformedBoxesSkipped() {
        val json = JSONObject(
            """{"type":"scan","pageUrl":"https://example.com/","findings":[
            |{"id":"a","kind":"img",
            | "boxes":[{"x":0.1,"y":0.2,"w":0.5,"h":0.6,"score":0.9},
            |          {"x":0.1},
            |          {"x":2.0,"y":-1.0,"w":0.5,"h":0.5,"score":0.5}]}]}""".trimMargin()
        )
        val f = FilterEngine.parseScanMessage(json)[0]
        // One good box, one incomplete (skipped), one clamped into range.
        assertEquals(2, f.boxes.size)
        assertEquals(1.0, f.boxes[1].x, 0.001)
        assertEquals(0.0, f.boxes[1].y, 0.001)
    }

    @Test
    fun buildDecisionsMessage_paintedCarriesBoxes() {
        val msg = FilterEngine.buildDecisionsMessage(
            listOf(
                ElementDecision("a", Verdict.ALLOW, "clean"),
                ElementDecision("b", Verdict.PAINTED, "painted",
                    boxes = listOf(PersonBox(0.1, 0.2, 0.5, 0.6, 0.9))),
                ElementDecision("c", Verdict.ALLOW, "unscanned", unscanned = true),
                ElementDecision("d", Verdict.REVIEW, "uncertain")
            )
        )
        val arr = msg.getJSONArray("decisions")
        assertEquals("allow", arr.getJSONObject(0).getString("verdict"))
        assertEquals("painted", arr.getJSONObject(1).getString("verdict"))
        val boxes = arr.getJSONObject(1).getJSONArray("boxes")
        assertEquals(1, boxes.length())
        assertEquals(0.1, boxes.getJSONObject(0).getDouble("x"), 0.001)
        assertEquals(0.6, boxes.getJSONObject(0).getDouble("h"), 0.001)
        assertTrue(arr.getJSONObject(2).getBoolean("unscanned"))
        assertEquals("cover", arr.getJSONObject(3).getString("verdict"))
        assertTrue(arr.getJSONObject(3).getString("reason").isNotBlank())
    }

    // --- 0.3.1 image keys, boxes, modes -----------------------------------

    @Test
    fun imageKeys_prefixesAndDeterminism() {
        val bytes = "hello".toByteArray(Charsets.UTF_8)
        val b = FilterEngine.imageKeyForContent(bytes)
        assertTrue(b.startsWith("b:"))
        assertEquals(66, b.length) // 'b:' + 64 hex chars
        assertEquals(b, FilterEngine.imageKeyForContent(bytes))
        val u = FilterEngine.imageKeyForUrl("https://example.com/pic.jpg")
        assertTrue(u.startsWith("u:"))
        assertEquals(66, u.length)
        assertEquals(u, FilterEngine.imageKeyForUrl("https://example.com/pic.jpg"))
        // SHA-256 of "hello" is a known constant.
        assertEquals(
            "b:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
            b)
    }

    @Test
    fun personBox_areaAndClamp() {
        assertEquals(0.25, PersonBox(0.1, 0.1, 0.5, 0.5, 0.9).area(), 0.001)
        val clamped = PersonBox.fromWire(2.0, -1.0, 0.5, 0.5, 1.5)
        assertEquals(1.0, clamped?.x)
        assertEquals(0.0, clamped?.y)
        assertEquals(1.0, clamped?.score)
        assertNull(PersonBox.fromWire(0.1, 0.1, null, 0.5, 0.9))
        assertNull(PersonBox.fromWire(0.1, 0.1, 0.5, 0.5, Double.NaN))
    }

    @Test
    fun humanImageMode_parseAndWire() {
        assertEquals(HumanImageMode.PAINT, HumanImageMode.parse("paint"))
        assertEquals(HumanImageMode.BLOCK, HumanImageMode.parse("block"))
        assertEquals(HumanImageMode.BLOCK, HumanImageMode.parse(" BLOCK "))
        assertNull(HumanImageMode.parse(null))
        assertNull(HumanImageMode.parse(""))
        assertNull(HumanImageMode.parse("nonsense"))
        assertEquals("paint", HumanImageMode.wireName(HumanImageMode.PAINT))
        assertEquals("block", HumanImageMode.wireName(HumanImageMode.BLOCK))
        assertEquals(ReviewDecision.ALLOW_PAINTED, ReviewDecision.parse("allow_painted"))
        assertEquals(ReviewDecision.ALLOW, ReviewDecision.parse("allow"))
        assertEquals(ReviewDecision.BLOCK, ReviewDecision.parse("block"))
        assertEquals(ReviewDecision.UNCERTAIN, ReviewDecision.parse("uncertain"))
        assertNull(ReviewDecision.parse("cover"))
        assertEquals("allow_painted", ReviewDecision.wireName(ReviewDecision.ALLOW_PAINTED))
    }

    @Test
    fun rfDetrMapping_noScoreIsNoData() {
        // Null = model not loaded / inference failed: UNKNOWN with
        // noData=true (0.3.1: it must not veto another detector).
        val r = RfDetrPersonDetector.mapBestPersonScore(null, 0.70)
        assertEquals(DetectionOutcome.UNKNOWN, r.outcome)
        assertTrue(r.noData)
        // A weak signal is UNKNOWN with noData=false.
        assertFalse(RfDetrPersonDetector.mapBestPersonScore(0.45, 0.70).noData)
    }

    @Test
    fun jsDetector_noDataFlag() {
        assertTrue(jsDetector.detect(
            detectedFinding(detectionRan = false), 0.70).noData)
        assertFalse(jsDetector.detect(
            detectedFinding(persons = 1, personBest = 0.45), 0.70).noData)
        assertFalse(jsDetector.detect(detectedFinding(), 0.70).noData)
    }
}
