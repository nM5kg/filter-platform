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
//
// 0.3.1 EXCEPTION (Yakob req 4, 2026-11-19): NON-human pictures must
// NEVER be blocked or covered. An element with NO detection signal at
// all (no detector ran on its pixels — no thumbnail, both detectors
// failed) and NO person signal is not "undecided with a weak signal";
// it is unscanned, and for a static kind (HTML_IMAGE, CSS_BACKGROUND,
// SVG) it is ALLOWed with unscanned=true, because covering it would
// block a picture nothing ever said was human. A dynamic surface
// (CANVAS, WEBGL, VIDEO_FRAME, LIVE_STREAM, DYNAMIC) that cannot be
// snapshotted still stays REVIEW -> COVER (fail closed — it cannot be
// proven clean). This is a deliberate trade-off, documented in
// [FilterEngine.decide]: an image whose pixels cannot be read is left
// visible because there is no person signal. The distinction between
// "no data" and "weak signal" is carried explicitly on
// [DetectionResult.noData] — a weak signal still vetoes clean, no-data
// never does (see [CombinedPersonDetector]).
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
    REVIEW,  // undecided — the engine treats this exactly like COVER
    PAINTED  // visible with the person boxes painted over (review outcome)
}

/**
 * How a confirmed human picture is shown (Yakob req 3, 2026-11-19).
 * PAINT (default): the picture stays visible with only the person
 * region painted over. BLOCK: the whole picture is blocked. Either
 * way, when the person region covers most of the image (largest single
 * person box area > 0.60 of the image area, or the sum of person-box
 * areas > 0.60) the whole picture is BLOCKed — even in paint mode.
 */
enum class HumanImageMode {
    PAINT,
    BLOCK;

    companion object {
        /** Parse a server / settings string ("paint" | "block"); null
         *  (and anything else) means "not specified". */
        fun parse(value: String?): HumanImageMode? = when (value?.trim()?.lowercase()) {
            "paint" -> PAINT
            "block" -> BLOCK
            else -> null
        }

        fun wireName(mode: HumanImageMode): String = when (mode) {
            PAINT -> "paint"
            BLOCK -> "block"
        }
    }
}

/**
 * One person box, as FRACTIONS 0..1 of the image (x/y = top-left,
 * w/h = size). The wire format is {x, y, w, h, score}; the same shape
 * is used by the content script, the review record, and the RF-DETR
 * box decoder ([RfDetrPersonDetector.decodePersonDetections]).
 */
data class PersonBox(
    val x: Double,
    val y: Double,
    val w: Double,
    val h: Double,
    val score: Double
) {
    /** Fraction of the image area this box covers (0..1). */
    fun area(): Double = (w * h).coerceIn(0.0, 1.0)

    companion object {
        /** Clamp a wire box into 0..1 fractions; null when it is not
         *  a box at all (missing / non-numeric fields). A box with a
         *  zero or negative size is kept (it paints nothing) — the
         *  caller decides whether to use it. */
        fun fromWire(x: Double?, y: Double?, w: Double?, h: Double?, score: Double?): PersonBox? {
            if (x == null || y == null || w == null || h == null || score == null) return null
            if (x.isNaN() || y.isNaN() || w.isNaN() || h.isNaN() || score.isNaN()) return null
            return PersonBox(
                x.coerceIn(0.0, 1.0), y.coerceIn(0.0, 1.0),
                w.coerceIn(0.0, 1.0), h.coerceIn(0.0, 1.0),
                score.coerceIn(0.0, 1.0)
            )
        }
    }
}

/**
 * A recorded review outcome for one image, as the content script
 * sends it back in a finding (and as the local/server review stores
 * hold it). [decision] is the REVIEW decision vocabulary:
 * "allow" | "allow_painted" | "block" | "uncertain". The engine
 * honours it VERBATIM — it never re-decides a reviewed image.
 */
data class CachedDecision(
    val decision: String,
    val boxes: List<PersonBox> = emptyList()
)

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
     *  — see [FilterEngine.decide] for how that is handled per kind
     *  (static kinds: ALLOW unscanned; dynamic kinds: REVIEW). */
    val detectionRan: Boolean = false,
    /** Set only when BOTH detectors failed or timed out (detail for
     *  logging; the verdict is decided by [detectionRan]). */
    val detectError: String = "",
    /** Person/face boxes the content script reported for this element
     *  (fractions 0..1 of the image; person boxes win, face boxes are
     *  the fallback). Empty when the script reported none — the
     *  review flow re-derives authoritative boxes from RF-DETR. */
    val boxes: List<PersonBox> = emptyList(),
    /** Review-cache key for this image ('u:<sha256 of canonical URL>'
     *  when the source is an http(s) URL, 'b:<sha256 of image bytes>'
     *  when the bytes were hashed, else null). The content script
     *  sends the 'u:' key; the native side computes the 'b:' key from
     *  the thumbnail bytes when it runs a review. */
    val imageKey: String? = null,
    /** A recorded review outcome for this image, if the content
     *  script (or the native side, before deciding) already knows one.
     *  [FilterEngine.decide] returns it verbatim — a reviewed image
     *  is never re-decided on a later scan. */
    val cachedDecision: CachedDecision? = null
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
    val detail: String = "",
    /**
     * True ONLY for an UNKNOWN that means "no data": no detector
     * produced any signal at all (no thumbnail, backend unavailable,
     * inference produced nothing, no detector ran). A no-data UNKNOWN
     * must NOT veto a positive NO_PERSON from another detector (see
     * [CombinedPersonDetector]) and is what [FilterEngine.decide]'s
     * kind-aware unscanned rule keys on. A weak-signal UNKNOWN
     * (a real signal below the threshold) has noData=false and DOES
     * veto — it is genuinely uncertain, not absent. Never infer this
     * from [detail]: the flag is the contract.
     */
    val noData: Boolean = false
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
            "no on-device person-detection model in this prototype build",
            noData = true
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
 *       -> UNKNOWN, noData=true ("no detector ran on this element")
 *   * at least one person or face reported:
 *       best = max(personBest, faceBest)
 *       best >= humanThreshold -> PERSON (confidence = best)
 *       best <  humanThreshold -> UNKNOWN, noData=false ("weak signal")
 *   * no person and no face reported:
 *       best >= SCORE_FLOOR (0.40 — a weak signal below the human
 *         threshold) -> UNKNOWN, noData=false ("weak signal below
 *         human threshold")
 *       best <  SCORE_FLOOR -> NO_PERSON (confidence = 1.0)
 *         At least one detector ran and found nothing, so the element
 *         is positively clean.
 * FAIL CLOSED throughout: anything uncertain is UNKNOWN, and UNKNOWN
 * is REVIEW -> COVER in [FilterEngine.decide] — except a no-data
 * UNKNOWN on a static kind, which decide() allows unscanned (req 4).
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
                "no detector ran on this element",
                noData = true
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
                    "weak signal $best below human threshold $humanThreshold",
                    noData = false
                )
            }
        }
        return if (best >= SCORE_FLOOR) {
            DetectionResult(
                DetectionOutcome.UNKNOWN, 0.0,
                "weak signal below human threshold $humanThreshold",
                noData = false
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
 * One RF-DETR run: the best person score over all 300 queries, plus
 * every person box at or above the box threshold (fractions 0..1 of
 * the image — see [RfDetrPersonDetector.decodePersonDetections]).
 */
data class RfDetrDetections(
    val bestScore: Double,
    val boxes: List<PersonBox>
)

/**
 * The Android + ONNX Runtime half of RF-DETR: JPEG decoding and the
 * OrtSession itself. Kept behind this interface so [RfDetrPersonDetector]
 * stays pure Kotlin (no android.*, no ai.onnxruntime.*) and unit-testable
 * on the JVM — the real implementation is [RfDetrOrtBackend], and the
 * tests use a fake. [bestPersonScore] runs the model and returns the
 * best person score (max sigmoid over the 300 queries at class slot 1),
 * or null when the model is not loaded or inference failed.
 * [personDetections] is the same run with boxes; its default
 * implementation degrades to the score alone (no boxes) so older
 * backends and test fakes keep working.
 */
interface RfDetrBackend {
    /** Decode JPEG bytes to ARGB pixels, or null when undecodable. */
    fun decodeJpeg(jpegBytes: ByteArray): DecodedImage?
    /** Run RF-DETR Nano on ARGB pixels; best person score, or null. */
    fun bestPersonScore(image: DecodedImage): Double?
    /** Run RF-DETR Nano on ARGB pixels; best score + person boxes, or
     *  null when the model is not loaded or inference failed. */
    fun personDetections(image: DecodedImage): RfDetrDetections? {
        val best = bestPersonScore(image) ?: return null
        return RfDetrDetections(best, emptyList())
    }
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
 *     loaded / inference error -> UNKNOWN, noData=true (never
 *     NO_PERSON on a guess — and never a veto of another detector's
 *     clean verdict, see [CombinedPersonDetector])
 *   * best person score >= humanThreshold -> PERSON (confidence = best)
 *   * best in [SCORE_FLOOR, humanThreshold) -> UNKNOWN, noData=false
 *     ("weak signal")
 *   * best < SCORE_FLOOR (0.40) -> NO_PERSON (confidence = 1.0, the
 *     same "positively clean" convention as JsReportedPersonDetector:
 *     the model ran on the pixels and found nothing)
 * The threshold flows from policy (autoDecideThreshold); no default is
 * hardcoded here — Yakob has not decided 0.50 vs 0.70.
 *
 * Boxes: the raw "dets" output is normalised cxcywh — VERIFIED
 * empirically 2026-11-19 against the shipped asset
 * (android/app/src/main/assets/rfdetr-nano.onnx) with the official
 * decode (rfdetr/export/_runtime/decode.py): the p1 portrait's top
 * query (score 0.981) decodes as cxcywh to x=0.001 y=0.027 w=0.998
 * h=0.965 — the full-frame portrait; read as xyxy it would be a
 * 0.498 x 0.455 box in the bottom-right quadrant, which is not the
 * person. On the no-person lake photo the top query read as xyxy
 * gives a NEGATIVE width — impossible for xyxy, conclusive for
 * cxcywh. [decodePersonDetections] converts cxcywh to fraction
 * {x, y, w, h} the same way decode_detections does
 * (x = cx - w/2, y = cy - h/2, clipped to 0..1).
 */
class RfDetrPersonDetector(
    private val backend: RfDetrBackend? = null
) : PersonDetector {
    companion object {
        /** Same floor as JsReportedPersonDetector.SCORE_FLOOR. */
        const val SCORE_FLOOR = 0.40
        /** "labels" output shape: [1,300,91]; person = class slot 1.
         *  (Same values as RfDetrOrtBackend's constants, repeated here
         *  because this file must compile without the Android/ORT
         *  backend — see run-tests.sh.) */
        const val NUM_QUERIES = 300
        const val NUM_CLASSES = 91
        const val PERSON_SLOT = 1

        /**
         * Pure score -> outcome mapping (no ORT, no Android — unit-tested
         * in FilterEngineTest). [bestPersonScore] is null when the model
         * did not produce a score at all (not loaded / inference error)
         * — that is a no-data UNKNOWN, not a weak signal.
         */
        fun mapBestPersonScore(
            bestPersonScore: Double?,
            humanThreshold: Double
        ): DetectionResult {
            if (bestPersonScore == null) {
                return DetectionResult(
                    DetectionOutcome.UNKNOWN, 0.0,
                    "RF-DETR did not produce a score " +
                        "(model not loaded or inference failed)",
                    noData = true
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
                        "human threshold $humanThreshold",
                    noData = false
                )
                else -> DetectionResult(
                    DetectionOutcome.NO_PERSON, 1.0,
                    "RF-DETR found no person (best score $bestPersonScore)"
                )
            }
        }

        /**
         * Pure decode of one RF-DETR run into person boxes (no ORT, no
         * Android — unit-tested in FilterEngineTest).
         *
         * [dets] is the flat [1,300,4] "dets" output (row-major, 4
         * floats per query) and [labels] the flat [1,300,91] "labels"
         * logits. Per query: sigmoid of the class-slot-1 logit is the
         * person score (logits clipped to [-88, 88], exactly as the
         * reference decode does); [dets] is normalised cxcywh, so the
         * fraction box is x = cx - w/2, y = cy - h/2, w, h — clipped
         * to 0..1 (a box hanging off the frame edge is trimmed, never
         * dropped for that alone). [bestScore] is the max person score
         * over ALL 300 queries, including ones below the box
         * threshold; [boxes] holds every query at or above
         * [boxScoreThreshold] (default 0.30 — the review's uncertain
         * floor, so a confirmed person is always painted with all its
         * plausible boxes, and weak boxes can only push the review
         * area rule towards BLOCK, never towards ALLOW). Boxes come
         * back sorted by score, best first.
         */
        const val BOX_SCORE_THRESHOLD = 0.30

        fun decodePersonDetections(
            dets: FloatArray,
            labels: FloatArray,
            boxScoreThreshold: Double = BOX_SCORE_THRESHOLD
        ): RfDetrDetections {
            var best = 0.0
            val boxes = ArrayList<PersonBox>()
            val queries = minOf(
                NUM_QUERIES,
                dets.size / 4,
                labels.size / NUM_CLASSES
            )
            for (q in 0 until queries) {
                val logit = labels[q * NUM_CLASSES +
                    PERSON_SLOT].toDouble()
                val clipped = logit.coerceIn(-88.0, 88.0)
                val score = 1.0 / (1.0 + kotlin.math.exp(-clipped))
                if (score > best) best = score
                if (score < boxScoreThreshold) continue
                val cx = dets[q * 4].toDouble()
                val cy = dets[q * 4 + 1].toDouble()
                val w = dets[q * 4 + 2].toDouble()
                val h = dets[q * 4 + 3].toDouble()
                if (w <= 0.0 || h <= 0.0) continue
                val x = (cx - w / 2).coerceIn(0.0, 1.0)
                val y = (cy - h / 2).coerceIn(0.0, 1.0)
                val cw = w.coerceIn(0.0, 1.0 - x)
                val ch = h.coerceIn(0.0, 1.0 - y)
                if (cw <= 0.0 || ch <= 0.0) continue
                boxes.add(PersonBox(x, y, cw, ch, score))
            }
            boxes.sortByDescending { it.score }
            return RfDetrDetections(best, boxes)
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
                "RF-DETR backend not available on this build",
                noData = true
            )
        val dataUrl = finding.thumbnailDataUrl
            ?: return DetectionResult(
                DetectionOutcome.UNKNOWN, 0.0,
                "RF-DETR: no thumbnail for this element",
                noData = true
            )
        val jpeg = decodeDataUrl(dataUrl)
            ?: return DetectionResult(
                DetectionOutcome.UNKNOWN, 0.0,
                "RF-DETR: thumbnail is not decodable base64",
                noData = true
            )
        val image = try {
            backend.decodeJpeg(jpeg)
        } catch (e: Throwable) {
            return DetectionResult(
                DetectionOutcome.UNKNOWN, 0.0,
                "RF-DETR: JPEG decode failed (${e.javaClass.simpleName})",
                noData = true
            )
        } ?: return DetectionResult(
            DetectionOutcome.UNKNOWN, 0.0,
            "RF-DETR: JPEG decode failed",
            noData = true
        )
        val best = try {
            backend.bestPersonScore(image)
        } catch (e: Throwable) {
            return DetectionResult(
                DetectionOutcome.UNKNOWN, 0.0,
                "RF-DETR: inference failed (${e.javaClass.simpleName})",
                noData = true
            )
        }
        return mapBestPersonScore(best, humanThreshold)
    }
}

/**
 * Combines several person detectors into one vote.
 *
 *   * PERSON if ANY detector says PERSON;
 *   * NO_PERSON only if ALL detectors say NO_PERSON, ignoring
 *     no-data UNKNOWNs — an UNKNOWN that means "no data" (no
 *     thumbnail, backend unavailable, inference produced nothing,
 *     no detector ran: [DetectionResult.noData] == true) is NOT a
 *     veto. It is the absence of a signal, not a signal;
 *   * else UNKNOWN — a WEAK-SIGNAL unknown (noData == false) vetoes
 *     a clean verdict, because a real signal below the threshold is
 *     genuinely uncertain (Yakob req 4: cover only on a person
 *     signal or a genuinely uncertain signal with a real detection
 *     signal).
 *
 * The OR for PERSON is the fail-closed choice: one detector seeing a
 * person is enough to keep the element covered. The AND for NO_PERSON
 * is equally fail-closed: every detector that produced a signal must
 * have run clean.
 *
 * Decision (0.2.2): RF-DETR Nano is the AUTHORITATIVE person model
 * (officially agreed, Apache 2.0, best benchmark recall). The JS
 * EfficientDet + face-api numbers stay as COMPLEMENTARY signals —
 * they catch what RF-DETR might miss and vice versa. BrowserActivity
 * wires CombinedPersonDetector(JsReportedPersonDetector(),
 * RfDetrPersonDetector(...)).
 *
 * Behaviour change in 0.3.1 (Yakob req 4): a finding the JS
 * detectors checked but could NOT thumbnail (cross-origin / tainted /
 * WebGL / stream) now ALLOWS on the JS NO_PERSON alone, because
 * RF-DETR's no-thumbnail UNKNOWN is no-data and no longer vetoes.
 * The 0.2.2 behaviour (one UNKNOWN vetoes NO_PERSON) still holds for
 * a WEAK-signal unknown from either side. When NO detector produced
 * any signal at all (every UNKNOWN is no-data), the combined result
 * is a no-data UNKNOWN, and [FilterEngine.decide] applies its
 * kind-aware unscanned rule.
 *
 * NO_PERSON confidence is the minimum of the detectors' confidences
 * (all 1.0 in practice today, so the combined confidence is 1.0).
 * An empty detector list is UNKNOWN (no-data — no detectors means no
 * decision).
 */
class CombinedPersonDetector(
    private val detectors: List<PersonDetector>
) : PersonDetector {
    override fun detect(finding: ScanFinding, humanThreshold: Double): DetectionResult {
        if (detectors.isEmpty()) {
            return DetectionResult(
                DetectionOutcome.UNKNOWN, 0.0,
                "no person detectors configured",
                noData = true
            )
        }
        var sawWeakUnknown = false
        var weakDetail = ""
        var sawNoDataUnknown = false
        var noDataDetail = ""
        var sawNoPerson = false
        var minNoPersonConfidence = 1.0
        for (detector in detectors) {
            val result = detector.detect(finding, humanThreshold)
            when (result.outcome) {
                DetectionOutcome.PERSON -> return result
                DetectionOutcome.NO_PERSON -> {
                    sawNoPerson = true
                    minNoPersonConfidence =
                        minOf(minNoPersonConfidence, result.confidence)
                }
                DetectionOutcome.UNKNOWN -> {
                    if (result.noData) {
                        sawNoDataUnknown = true
                        if (noDataDetail.isEmpty()) noDataDetail = result.detail
                    } else {
                        sawWeakUnknown = true
                        if (weakDetail.isEmpty()) weakDetail = result.detail
                    }
                }
            }
        }
        // A weak signal vetoes clean even when another detector ran
        // clean — but only a weak signal does. No-data unknowns are
        // ignored here; they surface below only when nothing else did.
        if (sawWeakUnknown) {
            return DetectionResult(
                DetectionOutcome.UNKNOWN, 0.0,
                "undecided: $weakDetail",
                noData = false
            )
        }
        if (sawNoPerson) {
            return DetectionResult(
                DetectionOutcome.NO_PERSON, minNoPersonConfidence,
                "all detectors that produced a signal found no person"
            )
        }
        // Every detector answered no-data UNKNOWN (or there was only
        // no-data): no signal at all — decide() applies its kind-aware
        // unscanned rule to this.
        return DetectionResult(
            DetectionOutcome.UNKNOWN, 0.0,
            "undecided: ${noDataDetail.ifBlank { "no detector produced a signal" }}",
            noData = sawNoDataUnknown
        )
    }
}

/** One element's decision, as sent back to the content script. */
data class ElementDecision(
    val elementId: String,
    val verdict: Verdict,
    val reason: String,
    /** Person boxes to paint, when [verdict] is PAINTED (fractions
     *  0..1 of the image). Empty for every other verdict. */
    val boxes: List<PersonBox> = emptyList(),
    /** True when the verdict was reached with NO detection signal at
     *  all (unscanned — see [FilterEngine.decide] rule 4). The
     *  content script can show this; it never changes the verdict. */
    val unscanned: Boolean = false
)

/**
 * Second-stage review outcome (Yakob req 2 + 3, 2026-11-19): the
 * decision the review engine returns for one covered image. This is
 * the REVIEW vocabulary (allow | allow_painted | block | uncertain),
 * shared with the web review engine and the server record
 * (POST /api/v1/review-decisions) — NOT the [Verdict] vocabulary.
 * ALLOW_PAINTED maps to [Verdict.PAINTED] when it is honoured as a
 * cached decision; UNCERTAIN maps to [Verdict.REVIEW] (stays covered).
 */
enum class ReviewDecision {
    ALLOW,
    ALLOW_PAINTED,
    BLOCK,
    UNCERTAIN;

    companion object {
        /** Wire name of a review decision ("allow_painted" etc.). */
        fun wireName(decision: ReviewDecision): String = when (decision) {
            ALLOW -> "allow"
            ALLOW_PAINTED -> "allow_painted"
            BLOCK -> "block"
            UNCERTAIN -> "uncertain"
        }

        /** Parse a wire/cache decision string; null when unknown. */
        fun parse(value: String?): ReviewDecision? = when (value?.trim()?.lowercase()) {
            "allow" -> ALLOW
            "allow_painted" -> ALLOW_PAINTED
            "block" -> BLOCK
            "uncertain" -> UNCERTAIN
            else -> null
        }
    }
}

/**
 * The filtering engine. Stateless except for the injected [PersonDetector]
 * and the [Policy] it decides against; both are supplied per page load by
 * [BrowserActivity], which owns the GeckoView session.
 */
class FilterEngine(
    private val detector: PersonDetector = StubPersonDetector()
) {
    /**
     * Decide one finding. The order matters:
     *  1. If the policy does not filter images at all, allow everything
     *     (explicit operator choice, not a default).
     *  2. A recorded review decision ([ScanFinding.cachedDecision]) is
     *     returned VERBATIM — a reviewed image is never re-decided.
     *     "allow" -> ALLOW, "allow_painted" -> PAINTED (with the
     *     recorded boxes), "block" -> BLOCK, "uncertain" -> REVIEW.
     *     An unknown decision string falls through to detection.
     *  3. Ask the detector with the policy's threshold.
     *  4. PERSON -> COVER (or BLOCK when the policy blocks images).
     *     This is the INITIAL verdict only — the paint/block choice
     *     for a confirmed person is made by the review flow
     *     ([reviewDecision]), after the user requests a decision.
     *  5. NO_PERSON with confidence >= threshold -> ALLOW.
     *  6. UNKNOWN with NO data ([DetectionResult.noData]) — no
     *     detector produced any signal — is decided by KIND (req 4):
     *       * HTML_IMAGE / CSS_BACKGROUND / SVG -> ALLOW with
     *         unscanned=true. There is no person signal; covering
     *         it would block a picture nothing ever said was human.
     *         TRADE-OFF (documented, deliberate): an image whose
     *         pixels cannot be read is left visible because there
     *         is no person signal. A cross-origin picture of a
     *         person that neither detector could read will be
     *         shown. The review request button on a covered image
     *         does not apply here — the image was never covered.
     *       * CANVAS / WEBGL / VIDEO_FRAME / LIVE_STREAM / DYNAMIC
     *         -> REVIEW (cover). A dynamic surface that cannot be
     *         snapshotted cannot be proven clean — fail closed.
     *  7. Everything else (weak-signal UNKNOWN, low confidence)
     *     -> REVIEW, which the content script renders as COVER.
     */
    fun decide(finding: ScanFinding, policy: Policy): ElementDecision {
        if (!policy.blockImages) {
            return ElementDecision(finding.elementId, Verdict.ALLOW,
                "policy does not filter images")
        }
        val cachedDecision = finding.cachedDecision
        val cached = cachedDecision?.let {
            ReviewDecision.parse(it.decision)
        }
        if (cached != null) {
            return when (cached) {
                ReviewDecision.ALLOW -> ElementDecision(
                    finding.elementId, Verdict.ALLOW,
                    "reviewed earlier: allow"
                )
                ReviewDecision.ALLOW_PAINTED -> ElementDecision(
                    finding.elementId, Verdict.PAINTED,
                    "reviewed earlier: allow, person painted over",
                    boxes = cachedDecision.boxes
                )
                ReviewDecision.BLOCK -> ElementDecision(
                    finding.elementId, Verdict.BLOCK,
                    "reviewed earlier: block"
                )
                ReviewDecision.UNCERTAIN -> ElementDecision(
                    finding.elementId, Verdict.REVIEW,
                    "reviewed earlier: uncertain, stays covered"
                )
            }
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
            DetectionOutcome.UNKNOWN -> {
                if (result.noData) {
                    when (finding.type) {
                        ContentType.HTML_IMAGE,
                        ContentType.CSS_BACKGROUND,
                        ContentType.SVG -> ElementDecision(
                            finding.elementId, Verdict.ALLOW,
                            "unscanned: no detector produced a signal " +
                                "(${result.detail}); no person signal, " +
                                "left visible",
                            unscanned = true
                        )
                        ContentType.CANVAS,
                        ContentType.WEBGL,
                        ContentType.VIDEO_FRAME,
                        ContentType.LIVE_STREAM,
                        ContentType.DYNAMIC -> ElementDecision(
                            finding.elementId, Verdict.REVIEW,
                            "unscanned dynamic surface: no detector " +
                                "produced a signal (${result.detail}); " +
                                "cannot be proven clean, stays covered"
                        )
                    }
                } else {
                    ElementDecision(
                        finding.elementId, Verdict.REVIEW,
                        "undecided: ${result.detail}"
                    )
                }
            }
        }
    }

    /** Decide a whole scan report at once. */
    fun decideAll(findings: List<ScanFinding>, policy: Policy): List<ElementDecision> =
        findings.map { decide(it, policy) }

    companion object {
        /** The policy used when the device has no server policy yet
         *  (not registered / offline): filter everything, cover (don't
         *  remove) — the strictest fail-closed default. Human images
         *  are painted, not blocked, on review (Yakob req 3 default). */
        val DEFAULT_POLICY = Policy(
            id = "local-default",
            name = "Default — block images, cover (fail closed)",
            blockImages = true,
            coverImages = true,
            filterAds = false,
            forceSafeSearch = true,
            autoDecideThreshold = 0.70,
            requireApprovalForNewSites = false,
            humanImageMode = HumanImageMode.PAINT
        )

        /**
         * Second-stage review decision (Yakob req 2 + 3, 2026-11-19).
         * Pure and unit-testable — the same bands as the web review
         * engine (sibling A), so web and app reviews agree on the
         * same image. [bestScore] is the RF-DETR best person score
         * (0..1); [boxes] the person boxes as fractions 0..1;
         * [mode] the policy's human-image mode.
         *
         *   * best >= 0.50 -> person confirmed:
         *       mode BLOCK -> BLOCK;
         *       else largest single person-box area > 0.60 of the
         *       image area, or the SUM of person-box areas > 0.60
         *       -> BLOCK (the person covers most of the picture, so
         *       painting would leave almost nothing — even in paint
         *       mode);
         *       else ALLOW_PAINTED.
         *   * best in [0.30, 0.50) -> UNCERTAIN (stays covered).
         *   * best < 0.30 -> ALLOW.
         *
         * One deliberate deviation from the literal bands: a
         * confirmed person (best >= 0.50) with NO boxes to paint is
         * BLOCKed, not ALLOW_PAINTED — painting nothing would show
         * the person unpainted. In practice RF-DETR always returns a
         * box for a score >= 0.50 (boxes are decoded at 0.30), so
         * this only fires when the caller passed no boxes.
         */
        const val REVIEW_CONFIRM_THRESHOLD = 0.50
        const val REVIEW_UNCERTAIN_THRESHOLD = 0.30
        const val REVIEW_PAINT_AREA_LIMIT = 0.60

        fun reviewDecision(
            bestScore: Double,
            boxes: List<PersonBox>,
            mode: HumanImageMode
        ): ReviewDecision {
            if (bestScore < REVIEW_UNCERTAIN_THRESHOLD) return ReviewDecision.ALLOW
            if (bestScore < REVIEW_CONFIRM_THRESHOLD) return ReviewDecision.UNCERTAIN
            if (mode == HumanImageMode.BLOCK) return ReviewDecision.BLOCK
            if (boxes.isEmpty()) return ReviewDecision.BLOCK
            val largest = boxes.maxOf { it.area() }
            val total = boxes.sumOf { it.area() }
            if (largest > REVIEW_PAINT_AREA_LIMIT || total > REVIEW_PAINT_AREA_LIMIT) {
                return ReviewDecision.BLOCK
            }
            return ReviewDecision.ALLOW_PAINTED
        }

        /** SHA-256 hex of bytes (lowercase, no prefix). */
        fun sha256Hex(bytes: ByteArray): String {
            val digest = java.security.MessageDigest.getInstance("SHA-256")
            val hash = digest.digest(bytes)
            val sb = StringBuilder(hash.size * 2)
            for (b in hash) sb.append(String.format("%02x", b.toInt() and 0xFF))
            return sb.toString()
        }

        /** Review-cache key from image BYTES: 'b:<sha256 hex>'. */
        fun imageKeyForContent(bytes: ByteArray): String = "b:" + sha256Hex(bytes)

        /** Review-cache key from a canonical image URL: 'u:<sha256 hex>'. */
        fun imageKeyForUrl(url: String): String =
            "u:" + sha256Hex(url.toByteArray(Charsets.UTF_8))

        /** Parse a content-script scan message into findings.
         *  Expected shape (see assets/filter-extension/content.js):
         *  {"type":"scan","pageUrl":"...","findings":[
         *    {"id":"fp-1","kind":"img","source":"https://...","thumb":"data:...", "playing":false,
         *     "persons":1,"personBest":0.87,"faces":0,"faceBest":0.0,
         *     "detected":true,"detectError":"",
         *     "boxes":[{"x":0.1,"y":0.1,"w":0.5,"h":0.6,"score":0.87}],
         *     "image_key":"u:<sha256hex>",
         *     "cachedDecision":{"decision":"allow_painted","boxes":[...]}},
         *    ...]}
         *  Unknown "kind" values are kept as DYNAMIC (never dropped: an
         *  element the script could not classify is still covered).
         *  The six detection fields default to "nothing ran" when
         *  absent (detectionRan=false, all zeros): a finding from an
         *  OLD content script therefore comes back no-data UNKNOWN
         *  from the detector, and [FilterEngine.decide] applies its
         *  kind-aware unscanned rule. "boxes", "image_key" and
         *  "cachedDecision" are all optional — the current Android
         *  content script (0.3.0) sends none of them; the synced
         *  0.3.1 script sends all three.
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
                        detectError = f.optString("detectError", ""),
                        boxes = parseBoxes(f.optJSONArray("boxes")),
                        imageKey = f.optString("image_key", "")
                            .ifBlank { f.optString("imageKey", "").ifBlank { null } },
                        cachedDecision = parseCachedDecision(
                            f.optJSONObject("cachedDecision")
                        )
                    )
                )
            }
            return out
        }

        /** Parse a wire boxes array [{x,y,w,h,score}] into fraction
         *  boxes; malformed entries are skipped, never fatal. Null
         *  (absent) parses to an empty list. */
        fun parseBoxes(arr: JSONArray?): List<PersonBox> {
            if (arr == null) return emptyList()
            val out = ArrayList<PersonBox>(arr.length())
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                val box = PersonBox.fromWire(
                    if (o.has("x")) o.optDouble("x") else null,
                    if (o.has("y")) o.optDouble("y") else null,
                    if (o.has("w")) o.optDouble("w") else null,
                    if (o.has("h")) o.optDouble("h") else null,
                    if (o.has("score")) o.optDouble("score") else null
                ) ?: continue
                out.add(box)
            }
            return out
        }

        /** Parse a wire cached decision {"decision": "...", "boxes":
         *  [...]}; null when absent, or when the decision string is
         *  not one of the review vocabulary (an unknown decision is
         *  ignored — the finding is decided normally instead). */
        fun parseCachedDecision(obj: JSONObject?): CachedDecision? {
            if (obj == null) return null
            val decision = obj.optString("decision", "").ifBlank { return null }
            if (ReviewDecision.parse(decision) == null) return null
            return CachedDecision(decision, parseBoxes(obj.optJSONArray("boxes")))
        }

        /** Serialise fraction boxes to a wire JSONArray. */
        fun boxesToJson(boxes: List<PersonBox>): JSONArray {
            val arr = JSONArray()
            for (b in boxes) {
                arr.put(
                    JSONObject()
                        .put("x", b.x).put("y", b.y)
                        .put("w", b.w).put("h", b.h)
                        .put("score", b.score)
                )
            }
            return arr
        }

        /** Build the reply the content script applies:
         *  {"type":"decisions","decisions":[{"id":"fp-1","verdict":"cover"}, ...]}
         *  REVIEW is sent as "cover" — the content script has no "review"
         *  state; anything not ALLOW stays covered. PAINTED is sent as
         *  "painted" with its boxes, so the script can paint over just
         *  the person region. Every decision carries its reason, and an
         *  unscanned ALLOW carries "unscanned":true. */
        fun buildDecisionsMessage(decisions: List<ElementDecision>): JSONObject {
            val arr = JSONArray()
            for (d in decisions) {
                val wire = when (d.verdict) {
                    Verdict.ALLOW -> "allow"
                    Verdict.BLOCK -> "block"
                    Verdict.PAINTED -> "painted"
                    Verdict.COVER, Verdict.REVIEW -> "cover"
                }
                val o = JSONObject().put("id", d.elementId).put("verdict", wire)
                    .put("reason", d.reason)
                if (d.boxes.isNotEmpty()) o.put("boxes", boxesToJson(d.boxes))
                if (d.unscanned) o.put("unscanned", true)
                arr.put(o)
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
