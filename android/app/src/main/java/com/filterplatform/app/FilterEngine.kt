// Filter Platform — GeckoView browser prototype: the filtering engine.
//
// This file is PURE Kotlin: no GeckoView, no Android framework imports.
// Every page load and every visual element the content script finds passes
// through here, so the decisions are unit-testable on the JVM (see
// FilterEngineTest) without a device or a GeckoView runtime.
//
// FAIL-CLOSED RULE (the whole point of this engine): an element whose
// content has not been positively decided is COVERED, never shown
// uncovered. In particular:
//   * no person detector available  -> every visual element is REVIEW -> COVER
//   * detector says "unknown"       -> REVIEW -> COVER
//   * detector says "person"        -> COVER (or BLOCK, per policy)
//   * detector says "no person" with confidence >= the policy threshold
//                                     -> ALLOW (and only then)
// A verdict of ALLOW is the only one that uncovers an element. Nothing in
// this file ever returns ALLOW on a guess.
package com.filterplatform.app

import org.json.JSONArray
import org.json.JSONObject

/** The kinds of visual content the content script can report. */
enum class ContentType {
    HTML_IMAGE,      // <img>, <picture>, <input type=image>
    CSS_BACKGROUND,  // background-image (incl. data: URIs and sprites)
    CANVAS,          // <canvas> 2D (pixels readable via toDataURL when not tainted)
    SVG,             // inline <svg> and <img src="*.svg">
    WEBGL,           // <canvas> with a WebGL context (pixels NOT reliably readable)
    VIDEO_FRAME,     // <video> element (frame sampled via drawImage)
    LIVE_STREAM,     // <video> fed by a MediaStream (camera, captureStream, WebRTC)
    DYNAMIC          // anything injected after page load (MutationObserver catch)
}

/** What the engine decides about one element. */
enum class Verdict {
    ALLOW,   // positively decided: no person, confidence >= threshold
    COVER,   // hide behind the filter overlay (element stays in layout)
    BLOCK,   // remove/hide the element entirely (policy: block_images)
    REVIEW   // undecided — the engine treats this exactly like COVER
}

/** One visual element reported by the content script. */
data class ScanFinding(
    val elementId: String,
    val type: ContentType,
    /** Page URL the element was found on (for logging / audit). */
    val pageUrl: String,
    /** Element source where meaningful (img src, video src, CSS url). */
    val sourceUrl: String?,
    /** Downscaled thumbnail (data: URL, JPEG, max 320px) when the content
     *  script could read the pixels at all; null for cross-origin/tainted
     *  content, WebGL, and live streams. */
    val thumbnailDataUrl: String?,
    /** True when the element is a <video> that is currently playing. */
    val isPlaying: Boolean = false,
    /** v1.2.0 JS-reported detection numbers (see extension/content.js
     *  detectImg). The content script runs the person + face detectors
     *  on the element's pixels and reports the counts and best scores;
     *  Kotlin only maps them to a verdict — it never re-runs a model. */
    /** Number of persons the person detector found. */
    val persons: Int = 0,
    /** Best person-detection score (0.0..1.0). */
    val personBest: Double = 0.0,
    /** Number of faces the face detector found. */
    val faces: Int = 0,
    /** Best face-detection score (0.0..1.0). */
    val faceBest: Double = 0.0,
    /** True when at least one detector RAN on the element's pixels.
     *  False means no pixels were checkable (or both detectors failed)
     *  — the finding must stay covered, never allowed. */
    val detectionRan: Boolean = false,
    /** Set only when BOTH detectors failed or timed out (detail for
     *  logging; the verdict is decided by [detectionRan]). */
    val detectError: String = ""
)

/** Result of a person-detection call. */
enum class DetectionOutcome {
    PERSON,     // a person was detected
    NO_PERSON,  // no person, at the reported confidence
    UNKNOWN     // the detector could not decide (no model, no pixels, error)
}

data class DetectionResult(
    val outcome: DetectionOutcome,
    /** 0.0..1.0 confidence for PERSON / NO_PERSON; 0.0 for UNKNOWN. */
    val confidence: Double,
    val detail: String = ""
)

/**
 * On-device person detection. The v1.2.0 engine reports detection
 * numbers from the content script (see [JsReportedPersonDetector]);
 * a future on-device model would implement this interface instead.
 *
 * [detect] receives the policy's [humanThreshold] — the score at or
 * above which a reported person/face counts as a human. That is the
 * policy threshold (pending Yakob decision: 0.50 vs 0.70; the default
 * policy uses 0.70). Implementations MUST NOT return NO_PERSON unless
 * a real detector ran on the element's pixels with confidence >= the
 * threshold. Returning NO_PERSON on a guess would uncover content the
 * filter has not checked.
 */
interface PersonDetector {
    fun detect(finding: ScanFinding, humanThreshold: Double): DetectionResult
}

/** The shipped detector: no model on device — everything is undecided.
 *  Kept for tests only; BrowserActivity wires [JsReportedPersonDetector]. */
class StubPersonDetector : PersonDetector {
    override fun detect(finding: ScanFinding, humanThreshold: Double): DetectionResult =
        DetectionResult(
            DetectionOutcome.UNKNOWN, 0.0,
            "no on-device person-detection model in this prototype build"
        )
}

/**
 * The v1.2.0 detector: it does not run a model — it maps the numbers
 * the content script already reported (extension/content.js detectImg)
 * to a [DetectionResult], using the POLICY threshold in place of
 * content.js's hardcoded HUMAN_THRESHOLD (0.50).
 *
 * Mapping (mirrors detectImg, with the policy threshold swapped in):
 *   * no detector ran on this element ([ScanFinding.detectionRan] false
 *     — no pixels, or BOTH detectors failed/timed out)
 *       -> UNKNOWN ("no detector ran on this element")
 *   * at least one person or face reported:
 *       best = max(personBest, faceBest)
 *       best >= humanThreshold -> PERSON (confidence = best)
 *       best <  humanThreshold -> UNKNOWN ("weak signal")
 *   * no person and no face reported:
 *       best >= SCORE_FLOOR (0.40 — a weak signal below the human
 *         threshold) -> UNKNOWN ("weak signal below human threshold")
 *       best <  SCORE_FLOOR -> NO_PERSON (confidence = 1.0)
 *         At least one detector ran and found nothing, so the element
 *         is positively clean.
 * FAIL CLOSED throughout: anything uncertain is UNKNOWN, and UNKNOWN
 * is REVIEW -> COVER in [FilterEngine.decide].
 */
class JsReportedPersonDetector : PersonDetector {
    companion object {
        /** Same floor as extension/content.js detectImg (and the
         *  scanner/detector.js): a best score in [SCORE_FLOOR,
         *  humanThreshold) is a weak signal — not a clear human, but
         *  not clear either. */
        const val SCORE_FLOOR = 0.40
    }

    override fun detect(finding: ScanFinding, humanThreshold: Double): DetectionResult {
        if (!finding.detectionRan) {
            return DetectionResult(
                DetectionOutcome.UNKNOWN, 0.0,
                "no detector ran on this element"
            )
        }
        val best = maxOf(finding.personBest, finding.faceBest)
        if (finding.persons > 0 || finding.faces > 0) {
            return if (best >= humanThreshold) {
                DetectionResult(
                    DetectionOutcome.PERSON, best,
                    "person detected (best score $best)"
                )
            } else {
                DetectionResult(
                    DetectionOutcome.UNKNOWN, 0.0,
                    "weak signal $best below human threshold $humanThreshold"
                )
            }
        }
        return if (best >= SCORE_FLOOR) {
            DetectionResult(
                DetectionOutcome.UNKNOWN, 0.0,
                "weak signal below human threshold $humanThreshold"
            )
        } else {
            DetectionResult(
                DetectionOutcome.NO_PERSON, 1.0,
                "no person or face detected"
            )
        }
    }
}

/**
 * RF-DETR Nano — the on-device person detector (0.2.2).
 *
 * The model is the OFFICIALLY AGREED person model (Apache 2.0, free
 * commercial use; README explicitly allows closed-source commercial
 * products). CPU benchmark on this project's 16-photo test set
 * (scanner/models/RF-DETR-BENCHMARK.md): Nano 327 ms infer, recall
 * 1.000 @0.50 / 0.909 @0.70, precision 1.000, 0 FP — Nano is the pick
 * (Small is slower with no accuracy gain here; do NOT swap it in).
 *
 * Model file: assets/rfdetr-nano.onnx (116,607,449 bytes, sha256
 * 26728b72ccbb264678566993bc63007d48622490d547aff950814c9f9bee0851),
 * exported with the repo's own model.export() (opset 17, rfdetr 1.12.1).
 * Input "input" [1,3,384,384] float32; outputs "dets" [1,300,4] and
 * "labels" [1,300,91] (raw logits).
 *
 * Preprocessing — replicated EXACTLY from the benchmark
 * (scanner/models/rf-detr/benchmark.py, which uses the official
 * rfdetr 1.12.1 runtime helpers preprocess_to_nchw / decode_detections):
 *   * stretch the image to 384x384 (aspect ratio NOT preserved — that
 *     is RFDETR.predict()'s own default convention);
 *   * resize bilinear, half-pixel centres, antialias=False (the
 *     torch-free numpy fallback _bilinear_resize_half_pixel);
 *   * ImageNet normalise: mean [0.485, 0.456, 0.406],
 *     std [0.229, 0.224, 0.225]; NCHW float32.
 *   * decode: per-class sigmoid on the "labels" logits (NOT softmax);
 *     person = class slot 1 (COCO category id 1 — verified by probe:
 *     portrait top detection is slot 1 @ 0.981, dog is slot 18);
 *     background_class_id=None (slot 90 is the real class "toothbrush",
 *     not background). Boxes are irrelevant to the verdict — only the
 *     best person score is needed.
 * The resize + normalise live in [RfDetrOrtBackend] (Android/ORT code);
 * the score -> outcome mapping lives here, pure and unit-testable.
 * One known approximation: Android has no torchvision, so the resize is
 * a hand-rolled half-pixel bilinear in Kotlin matching the reference
 * numpy fallback up to float32 op-order noise. Scores may therefore
 * differ from the benchmark by a hair on borderline images; the
 * SCORE_FLOOR band below absorbs that (anything in [0.40, threshold)
 * is UNKNOWN, never a guess either way).
 */
data class DecodedImage(val pixels: IntArray, val width: Int, val height: Int)

/**
 * The Android + ONNX Runtime half of RF-DETR: JPEG decoding and the
 * OrtSession itself. Kept behind this interface so [RfDetrPersonDetector]
 * stays pure Kotlin (no android.*, no ai.onnxruntime.*) and unit-testable
 * on the JVM — the real implementation is [RfDetrOrtBackend], and the
 * tests use a fake. [bestPersonScore] runs the model and returns the
 * best person score (max sigmoid over the 300 queries at class slot 1),
 * or null when the model is not loaded or inference failed.
 */
interface RfDetrBackend {
    /** Decode JPEG bytes to ARGB pixels, or null when undecodable. */
    fun decodeJpeg(jpegBytes: ByteArray): DecodedImage?
    /** Run RF-DETR Nano on ARGB pixels; best person score, or null. */
    fun bestPersonScore(image: DecodedImage): Double?
}

/**
 * RF-DETR person detector. Input is the finding's thumbnailDataUrl
 * (JPEG data URL, max 320px) — the same thumbnail the content script
 * already sends. The model runs on the calling thread, which is the
 * WebExtension message-delegate thread (already a background thread);
 * it must NEVER be called from the UI thread (a cold session load is
 * ~0.6 s on the benchmark VM and inference ~0.3 s per image).
 *
 * Mapping (fail closed, same floor as [JsReportedPersonDetector]):
 *   * no backend / no thumbnail / undecodable thumbnail / model not
 *     loaded / inference error -> UNKNOWN (never NO_PERSON on a guess)
 *   * best person score >= humanThreshold -> PERSON (confidence = best)
 *   * best in [SCORE_FLOOR, humanThreshold) -> UNKNOWN ("weak signal")
 *   * best < SCORE_FLOOR (0.40) -> NO_PERSON (confidence = 1.0, the
 *     same "positively clean" convention as JsReportedPersonDetector:
 *     the model ran on the pixels and found nothing)
 * The threshold flows from policy (autoDecideThreshold); no default is
 * hardcoded here — Yakob has not decided 0.50 vs 0.70.
 */
class RfDetrPersonDetector(
    private val backend: RfDetrBackend? = null
) : PersonDetector {
    companion object {
        /** Same floor as JsReportedPersonDetector.SCORE_FLOOR. */
        const val SCORE_FLOOR = 0.40

        /**
         * Pure score -> outcome mapping (no ORT, no Android — unit-tested
         * in FilterEngineTest). [bestPersonScore] is null when the model
         * did not produce a score at all (not loaded / inference error).
         */
        fun mapBestPersonScore(
            bestPersonScore: Double?,
            humanThreshold: Double
        ): DetectionResult {
            if (bestPersonScore == null) {
                return DetectionResult(
                    DetectionOutcome.UNKNOWN, 0.0,
                    "RF-DETR did not produce a score " +
                        "(model not loaded or inference failed)"
                )
            }
            return when {
                bestPersonScore >= humanThreshold -> DetectionResult(
                    DetectionOutcome.PERSON, bestPersonScore,
                    "RF-DETR person detected (best score $bestPersonScore)"
                )
                bestPersonScore >= SCORE_FLOOR -> DetectionResult(
                    DetectionOutcome.UNKNOWN, 0.0,
                    "RF-DETR weak signal $bestPersonScore below " +
                        "human threshold $humanThreshold"
                )
                else -> DetectionResult(
                    DetectionOutcome.NO_PERSON, 1.0,
                    "RF-DETR found no person (best score $bestPersonScore)"
                )
            }
        }

        /** Decode a "data:image/jpeg;base64,..." URL to bytes, or null
         *  when malformed. A bare base64 string (no comma) is accepted. */
        fun decodeDataUrl(dataUrl: String): ByteArray? {
            return try {
                val base64 = dataUrl.substringAfter(",", dataUrl)
                    .trim()
                    .ifBlank { return null }
                java.util.Base64.getDecoder().decode(base64)
            } catch (_: IllegalArgumentException) {
                null
            }
        }
    }

    override fun detect(finding: ScanFinding, humanThreshold: Double): DetectionResult {
        val backend = this.backend
            ?: return DetectionResult(
                DetectionOutcome.UNKNOWN, 0.0,
                "RF-DETR backend not available on this build"
            )
        val dataUrl = finding.thumbnailDataUrl
            ?: return DetectionResult(
                DetectionOutcome.UNKNOWN, 0.0,
                "RF-DETR: no thumbnail for this element"
            )
        val jpeg = decodeDataUrl(dataUrl)
            ?: return DetectionResult(
                DetectionOutcome.UNKNOWN, 0.0,
                "RF-DETR: thumbnail is not decodable base64"
            )
        val image = try {
            backend.decodeJpeg(jpeg)
        } catch (e: Throwable) {
            return DetectionResult(
                DetectionOutcome.UNKNOWN, 0.0,
                "RF-DETR: JPEG decode failed (${e.javaClass.simpleName})"
            )
        } ?: return DetectionResult(
            DetectionOutcome.UNKNOWN, 0.0,
            "RF-DETR: JPEG decode failed"
        )
        val best = try {
            backend.bestPersonScore(image)
        } catch (e: Throwable) {
            return DetectionResult(
                DetectionOutcome.UNKNOWN, 0.0,
                "RF-DETR: inference failed (${e.javaClass.simpleName})"
            )
        }
        return mapBestPersonScore(best, humanThreshold)
    }
}

/**
 * Combines several person detectors into one vote.
 *
 *   * PERSON if ANY detector says PERSON;
 *   * NO_PERSON only if ALL detectors say NO_PERSON;
 *   * else UNKNOWN (any UNKNOWN vetoes a clean verdict).
 *
 * The OR for PERSON is the fail-closed choice: one detector seeing a
 * person is enough to keep the element covered. The AND for NO_PERSON
 * is equally fail-closed: every detector must have run clean.
 *
 * Decision (0.2.2): RF-DETR Nano is the AUTHORITATIVE person model
 * (officially agreed, Apache 2.0, best benchmark recall). The JS
 * EfficientDet + face-api numbers stay as COMPLEMENTARY signals —
 * they catch what RF-DETR might miss and vice versa. BrowserActivity
 * wires CombinedPersonDetector(JsReportedPersonDetector(),
 * RfDetrPersonDetector(...)).
 *
 * Behaviour change to know about: a finding the JS detectors checked
 * but could NOT thumbnail (cross-origin / tainted / WebGL / stream —
 * previously ALLOWable on the JS NO_PERSON alone) now stays covered,
 * because RF-DETR answers UNKNOWN with no thumbnail and one UNKNOWN
 * vetoes NO_PERSON. That is the intended price of requiring two
 * independent clean verdicts; it only ever keeps content covered,
 * never uncovers anything unchecked.
 *
 * NO_PERSON confidence is the minimum of the detectors' confidences
 * (all 1.0 in practice today, so the combined confidence is 1.0).
 * An empty detector list is UNKNOWN — no detectors means no decision.
 */
class CombinedPersonDetector(
    private val detectors: List<PersonDetector>
) : PersonDetector {
    override fun detect(finding: ScanFinding, humanThreshold: Double): DetectionResult {
        if (detectors.isEmpty()) {
            return DetectionResult(
                DetectionOutcome.UNKNOWN, 0.0,
                "no person detectors configured"
            )
        }
        var sawUnknown = false
        var unknownDetail = ""
        var minNoPersonConfidence = 1.0
        for (detector in detectors) {
            val result = detector.detect(finding, humanThreshold)
            when (result.outcome) {
                DetectionOutcome.PERSON -> return result
                DetectionOutcome.NO_PERSON ->
                    minNoPersonConfidence =
                        minOf(minNoPersonConfidence, result.confidence)
                DetectionOutcome.UNKNOWN -> {
                    sawUnknown = true
                    if (unknownDetail.isEmpty()) unknownDetail = result.detail
                }
            }
        }
        return if (sawUnknown) {
            DetectionResult(
                DetectionOutcome.UNKNOWN, 0.0,
                "undecided: $unknownDetail"
            )
        } else {
            DetectionResult(
                DetectionOutcome.NO_PERSON, minNoPersonConfidence,
                "all detectors found no person"
            )
        }
    }
}

/** One element's decision, as sent back to the content script. */
data class ElementDecision(
    val elementId: String,
    val verdict: Verdict,
    val reason: String
)

/**
 * The filtering engine. Stateless except for the injected [PersonDetector]
 * and the [Policy] it decides against; both are supplied per page load by
 * [BrowserActivity], which owns the GeckoView session.
 */
class FilterEngine(
    private val detector: PersonDetector = StubPersonDetector()
) {
    /**
     * Decide one finding. The order matters — fail closed first:
     *  1. If the policy does not filter images at all, allow everything
     *     (explicit operator choice, not a default).
     *  2. Ask the detector with the policy's threshold. There is NO
     *     thumbnail gate any more (v1.2.0): the JS-reported numbers
     *     already encode "no pixels" as detectionRan=false, which the
     *     detector maps to UNKNOWN -> REVIEW -> COVER. A finding with
     *     no thumbnail but a positive NO_PERSON result is allowed.
     *  3. PERSON -> COVER (or BLOCK when the policy blocks images).
     *  4. NO_PERSON with confidence >= threshold -> ALLOW.
     *  5. Everything else (UNKNOWN, low confidence) -> REVIEW, which
     *     the content script renders as COVER.
     */
    fun decide(finding: ScanFinding, policy: Policy): ElementDecision {
        if (!policy.blockImages) {
            return ElementDecision(finding.elementId, Verdict.ALLOW,
                "policy does not filter images")
        }
        val result = detector.detect(finding, policy.autoDecideThreshold)
        return when (result.outcome) {
            DetectionOutcome.PERSON -> ElementDecision(
                finding.elementId,
                if (policy.coverImages) Verdict.COVER else Verdict.BLOCK,
                "person detected (confidence ${result.confidence})"
            )
            DetectionOutcome.NO_PERSON -> {
                if (result.confidence >= policy.autoDecideThreshold) {
                    ElementDecision(finding.elementId, Verdict.ALLOW,
                        "no person (confidence ${result.confidence})")
                } else {
                    ElementDecision(finding.elementId, Verdict.REVIEW,
                        "no-person confidence ${result.confidence} below " +
                            "threshold ${policy.autoDecideThreshold}")
                }
            }
            DetectionOutcome.UNKNOWN -> ElementDecision(
                finding.elementId, Verdict.REVIEW,
                "undecided: ${result.detail}"
            )
        }
    }

    /** Decide a whole scan report at once. */
    fun decideAll(findings: List<ScanFinding>, policy: Policy): List<ElementDecision> =
        findings.map { decide(it, policy) }

    companion object {
        /** The policy used when the device has no server policy yet
         *  (not registered / offline): filter everything, cover (don't
         *  remove) — the strictest fail-closed default. */
        val DEFAULT_POLICY = Policy(
            id = "local-default",
            name = "Default — block images, cover (fail closed)",
            blockImages = true,
            coverImages = true,
            filterAds = false,
            forceSafeSearch = true,
            autoDecideThreshold = 0.70,
            requireApprovalForNewSites = false
        )

        /** Parse a content-script scan message into findings.
         *  Expected shape (see assets/filter-extension/content.js):
         *  {"type":"scan","pageUrl":"...","findings":[
         *    {"id":"fp-1","kind":"img","source":"https://...","thumb":"data:...", "playing":false,
         *     "persons":1,"personBest":0.87,"faces":0,"faceBest":0.0,
         *     "detected":true,"detectError":""},
         *    ...]}
         *  Unknown "kind" values are kept as DYNAMIC (never dropped: an
         *  element the script could not classify is still covered).
         *  The six detection fields default to "nothing ran" when
         *  absent (detectionRan=false, all zeros): a finding from an
         *  OLD content script therefore comes back UNKNOWN from the
         *  detector and stays covered, never allowed.
         *  A malformed message throws IllegalArgumentException — the caller
         *  (BrowserActivity) logs it and keeps everything covered. */
        fun parseScanMessage(json: JSONObject): List<ScanFinding> {
            if (json.optString("type") != "scan") {
                throw IllegalArgumentException(
                    "not a scan message: type=${json.optString("type")}")
            }
            val pageUrl = json.optString("pageUrl", "")
            val arr: JSONArray = json.optJSONArray("findings")
                ?: throw IllegalArgumentException("scan message has no findings array")
            val out = ArrayList<ScanFinding>(arr.length())
            for (i in 0 until arr.length()) {
                val f = arr.getJSONObject(i)
                val kind = f.optString("kind", "")
                val type = when (kind) {
                    "img" -> ContentType.HTML_IMAGE
                    "css" -> ContentType.CSS_BACKGROUND
                    "canvas" -> ContentType.CANVAS
                    "svg" -> ContentType.SVG
                    "webgl" -> ContentType.WEBGL
                    "video" -> ContentType.VIDEO_FRAME
                    "stream" -> ContentType.LIVE_STREAM
                    else -> ContentType.DYNAMIC
                }
                out.add(
                    ScanFinding(
                        elementId = f.optString("id", "fp-unknown-$i"),
                        type = type,
                        pageUrl = pageUrl,
                        sourceUrl = f.optString("source", "").ifBlank { null },
                        thumbnailDataUrl = f.optString("thumb", "").ifBlank { null },
                        isPlaying = f.optBoolean("playing", false),
                        persons = f.optInt("persons", 0),
                        personBest = f.optDouble("personBest", 0.0),
                        faces = f.optInt("faces", 0),
                        faceBest = f.optDouble("faceBest", 0.0),
                        detectionRan = f.optBoolean("detected", false),
                        detectError = f.optString("detectError", "")
                    )
                )
            }
            return out
        }

        /** Build the reply the content script applies:
         *  {"type":"decisions","decisions":[{"id":"fp-1","verdict":"cover"}, ...]}
         *  REVIEW is sent as "cover" — the content script has no "review"
         *  state; anything not ALLOW stays covered. */
        fun buildDecisionsMessage(decisions: List<ElementDecision>): JSONObject {
            val arr = JSONArray()
            for (d in decisions) {
                val wire = when (d.verdict) {
                    Verdict.ALLOW -> "allow"
                    Verdict.BLOCK -> "block"
                    Verdict.COVER, Verdict.REVIEW -> "cover"
                }
                arr.put(JSONObject().put("id", d.elementId).put("verdict", wire))
            }
            return JSONObject().put("type", "decisions").put("decisions", arr)
        }

        /** Navigation hook: should this top-level navigation be stopped?
         *  The prototype blocks only exact blocklist hits and non-http(s)
         *  schemes the browser cannot handle safely. Domain verdicts from
         *  the server (ApiClient.checkDomain) are wired in by BrowserActivity;
         *  this pure function covers the part that needs no network. */
        fun shouldBlockNavigation(url: String, blockedHosts: Set<String>): Boolean {
            val lower = url.trim().lowercase()
            if (lower.isBlank()) return true
            if (!lower.startsWith("http://") && !lower.startsWith("https://") &&
                !lower.startsWith("file://") && !lower.startsWith("about:") &&
                !lower.startsWith("data:") && !lower.startsWith("resource://")
            ) {
                // Unknown scheme (intent:, javascript:, ...): do not hand it
                // to the engine blindly.
                return true
            }
            return matchedBlockedHost(lower, blockedHosts) != null
        }

        /** Return the blocked host matching this URL (exact host or a
         *  subdomain of a blocked host), or null when no blocked host
         *  matches. Same matching as [shouldBlockNavigation]; the
         *  returned host is the blocklist entry (so the caller can show
         *  it on the block page). A URL with no host (e.g. a data: URL)
         *  never matches. */
        fun matchedBlockedHost(url: String, blockedHosts: Set<String>): String? {
            val host = hostOf(url.trim().lowercase()) ?: return null
            if (host in blockedHosts) return host
            return blockedHosts.firstOrNull { host.endsWith(".$it") }
        }

        /**
         * SafeSearch rewrite for search-engine navigations (mirrors the
         * extension's SAFESEARCH_FALLBACK in extension/background.js):
         *   Google (google.com + country domains, /search) -> safe=active
         *   Bing (bing.com/search)                        -> adlt=strict
         *   DuckDuckGo (duckduckgo.com, any URL with ?q=) -> kp=1
         * YouTube Restricted Mode has no query param — it needs the DNS
         * lock and is deliberately NOT attempted here.
         *
         * Returns the URL with the engine's SafeSearch param added (or
         * replaced when present with the wrong value), or null when
         * [forceSafeSearch] is false, the URL is not a matching search
         * URL, or the param is already present with the correct value.
         * IDEMPOTENT: a rewritten URL passed back in returns null, so
         * the navigation delegate can never loop (rewrite -> deny ->
         * load rewritten URL -> rewrite again -> ...).
         */
        fun rewriteSafeSearch(url: String, forceSafeSearch: Boolean): String? {
            if (!forceSafeSearch) return null
            val rule = SAFESEARCH_RULES.firstOrNull { it.first.containsMatchIn(url) }
                ?: return null
            val (paramKey, paramValue) = rule.second
            // Split off the fragment (a query param never belongs there).
            val hashIdx = url.indexOf('#')
            val fragment = if (hashIdx >= 0) url.substring(hashIdx) else ""
            val noFrag = if (hashIdx >= 0) url.substring(0, hashIdx) else url
            val qIdx = noFrag.indexOf('?')
            val base = if (qIdx >= 0) noFrag.substring(0, qIdx) else noFrag
            val query = if (qIdx >= 0) noFrag.substring(qIdx + 1) else ""
            val params = ArrayList<Pair<String, String>>()
            if (query.isNotEmpty()) {
                for (part in query.split('&')) {
                    val eq = part.indexOf('=')
                    if (eq >= 0) params.add(part.substring(0, eq) to part.substring(eq + 1))
                    else params.add(part to "")
                }
            }
            val existing = params.indexOfFirst { it.first == paramKey }
            if (existing >= 0) {
                if (params[existing].second == paramValue) return null // already tagged
                params[existing] = paramKey to paramValue
            } else {
                params.add(paramKey to paramValue)
            }
            val newQuery = params.joinToString("&") { (k, v) ->
                if (v.isEmpty()) k else "$k=$v"
            }
            return "$base?$newQuery$fragment"
        }

        /** SafeSearch rules, in the same order as the extension's
         *  SAFESEARCH_FALLBACK (first match wins — the engines' hosts
         *  do not overlap, so order is only a tie-break). */
        private val SAFESEARCH_RULES: List<Pair<Regex, Pair<String, String>>> = listOf(
            Regex(
                "^https://(?:www\\.)?google\\.(?:com(?:\\.[a-z]{2})?|co\\.[a-z]{2}|[a-z]{2,3})/search",
                RegexOption.IGNORE_CASE
            ) to ("safe" to "active"),
            Regex(
                "^https://(?:www\\.)?bing\\.com/search",
                RegexOption.IGNORE_CASE
            ) to ("adlt" to "strict"),
            Regex(
                "^https://(?:www\\.)?duckduckgo\\.com/.*[?&]q=",
                RegexOption.IGNORE_CASE
            ) to ("kp" to "1")
        )

        /** Minimal HTML escaping for values substituted into the block
         *  page (host and policy name). Escapes & first, then the
         *  characters that can break out of an attribute or element. */
        fun escapeHtml(value: String): String {
            val sb = StringBuilder(value.length)
            for (c in value) {
                when (c) {
                    '&' -> sb.append("&amp;")
                    '<' -> sb.append("&lt;")
                    '>' -> sb.append("&gt;")
                    '"' -> sb.append("&quot;")
                    '\'' -> sb.append("&#39;")
                    else -> sb.append(c)
                }
            }
            return sb.toString()
        }

        /** Extract the host from a URL string without java.net (pure, testable). */
        fun hostOf(url: String): String? {
            val afterScheme = url.substringAfter("://", "")
            if (afterScheme.isEmpty() || afterScheme == url) return null
            val hostPort = afterScheme.substringBefore("/").substringBefore("?")
                .substringBefore("#")
            val host = hostPort.substringBefore(":").lowercase()
            return host.ifBlank { null }
        }
    }
}
