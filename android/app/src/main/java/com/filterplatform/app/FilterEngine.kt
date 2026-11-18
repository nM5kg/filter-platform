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
    val isPlaying: Boolean = false
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
 * On-device person detection. The prototype ships ONLY the stub below:
 * there is no model on the device yet, so [detect] always returns UNKNOWN
 * and the engine covers everything. A real implementation (e.g. a
 * MediaPipe/TFLite model — see the scanner's EfficientDet-Lite0 work)
 * implements this interface and is plugged in at the single call site in
 * [FilterEngine.decide]; nothing else changes.
 *
 * Implementations MUST NOT return NO_PERSON unless a real model ran on the
 * element's pixels with confidence >= the threshold. Returning NO_PERSON
 * on a guess would uncover content the filter has not checked.
 */
interface PersonDetector {
    fun detect(finding: ScanFinding): DetectionResult
}

/** The shipped detector: no model on device — everything is undecided. */
class StubPersonDetector : PersonDetector {
    override fun detect(finding: ScanFinding): DetectionResult =
        DetectionResult(
            DetectionOutcome.UNKNOWN, 0.0,
            "no on-device person-detection model in this prototype build"
        )
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
     *  2. Ask the detector (only when it has pixels to look at — a null
     *     thumbnail means "cannot check", not "clean").
     *  3. PERSON -> COVER (or BLOCK when the policy blocks images).
     *  4. NO_PERSON with confidence >= threshold -> ALLOW.
     *  5. Everything else (UNKNOWN, low confidence, no pixels) -> REVIEW,
     *     which the content script renders as COVER.
     */
    fun decide(finding: ScanFinding, policy: Policy): ElementDecision {
        if (!policy.blockImages) {
            return ElementDecision(finding.elementId, Verdict.ALLOW,
                "policy does not filter images")
        }
        val result = if (finding.thumbnailDataUrl != null) {
            detector.detect(finding)
        } else {
            DetectionResult(DetectionOutcome.UNKNOWN, 0.0,
                "no pixels available to check (cross-origin, tainted, " +
                    "WebGL or live stream)")
        }
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
         *    {"id":"fp-1","kind":"img","source":"https://...","thumb":"data:...", "playing":false},
         *    ...]}
         *  Unknown "kind" values are kept as DYNAMIC (never dropped: an
         *  element the script could not classify is still covered).
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
                        isPlaying = f.optBoolean("playing", false)
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
            val host = hostOf(lower) ?: return false
            return host in blockedHosts ||
                blockedHosts.any { host.endsWith(".$it") }
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
