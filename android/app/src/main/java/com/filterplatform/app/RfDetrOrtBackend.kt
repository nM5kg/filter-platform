// Filter Platform — RF-DETR Nano on-device runtime (0.2.2).
//
// This is the THIN Android + ONNX Runtime wrapper behind the
// RfDetrBackend interface (see FilterEngine.kt). Everything decision-shaped
// (score -> PERSON / NO_PERSON / UNKNOWN) lives in FilterEngine.kt as pure
// Kotlin; this file only does three things:
//   1. copy assets/rfdetr-nano.onnx to internal storage on first use
//      (assets cannot be opened as a file path, and OrtSession needs one);
//   2. decode the thumbnail JPEG to ARGB pixels;
//   3. preprocess exactly like the benchmark (stretch to 384x384,
//      half-pixel bilinear, antialias off, ImageNet normalise, NCHW),
//      run OrtSession, and return the best person score (max sigmoid
//      over the 300 queries at class slot 1).
//
// Model: RF-DETR Nano, Apache 2.0, officially agreed person model.
// onnxruntime-android 1.32.0 (MIT). Session options match the benchmark
// (scanner/models/rf-detr/benchmark.py): intra_op 2, inter_op 1.
//
// Threading: the session is created lazily ONCE, thread-safe, and every
// inference is serialised on one lock (ORT sessions tolerate concurrent
// Run, but serialising costs nothing here and removes all doubt).
// Inference runs on the WebExtension message-delegate thread (already
// background) — never call from the UI thread: a cold session load is
// ~0.6 s and one inference ~0.3 s on the benchmark VM; a phone will
// differ, and only Yakob's phone can prove the real speed.
//
// Failure mode: ANY failure (model copy, session creation, native lib
// missing, inference error) is cached/returned as null — the detector
// above maps null to UNKNOWN, so the element stays covered. Nothing here
// ever throws out of bestPersonScore().
package com.filterplatform.app

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import java.io.File
import java.nio.FloatBuffer
import kotlin.math.exp

class RfDetrOrtBackend(context: Context) : RfDetrBackend {

    companion object {
        /** Model input: [1,3,384,384] float32 (verified from the ONNX). */
        const val INPUT_SIZE = 384
        /** "labels" output: [1,300,91] raw logits; person = slot 1. */
        const val NUM_QUERIES = 300
        const val NUM_CLASSES = 91
        const val PERSON_SLOT = 1
        const val MODEL_ASSET = "rfdetr-nano.onnx"
        const val MODEL_FILE = "rfdetr-nano.onnx"
        /** Exact asset size; a different size means a stale/corrupt copy. */
        const val MODEL_SIZE_BYTES = 116_607_449L

        /** ImageNet mean/std, same as the benchmark's preprocess_to_nchw. */
        private val MEAN = floatArrayOf(0.485f, 0.456f, 0.406f)
        private val STD = floatArrayOf(0.229f, 0.224f, 0.225f)
    }

    private val appContext: Context = context.applicationContext

    @Volatile private var session: OrtSession? = null
    @Volatile private var loadFailed = false
    @Volatile private var lastError: String? = null
    private val sessionLock = Any()

    /** Last failure detail (for diagnostics only; never leaves the device). */
    fun lastError(): String? = lastError

    // ------------------------------------------------------------ JPEG decode

    override fun decodeJpeg(jpegBytes: ByteArray): DecodedImage? {
        return try {
            val opts = BitmapFactory.Options().apply {
                inPreferredConfig = Bitmap.Config.ARGB_8888
                inScaled = false // never let density scaling touch the pixels
            }
            val bitmap = BitmapFactory.decodeByteArray(jpegBytes, 0, jpegBytes.size, opts)
                ?: return null
            val w = bitmap.width
            val h = bitmap.height
            if (w <= 0 || h <= 0) {
                bitmap.recycle()
                return null
            }
            val pixels = IntArray(w * h)
            bitmap.getPixels(pixels, 0, w, 0, 0, w, h)
            bitmap.recycle()
            DecodedImage(pixels, w, h)
        } catch (_: Throwable) {
            null
        }
    }

    // ------------------------------------------------------------ session load

    /** Copy the model out of assets (once) and create the OrtSession. */
    private fun getSession(): OrtSession? {
        session?.let { return it }
        if (loadFailed) return null
        synchronized(sessionLock) {
            session?.let { return it }
            if (loadFailed) return null
            return try {
                val modelFile = File(appContext.filesDir, MODEL_FILE)
                if (!modelFile.exists() || modelFile.length() != MODEL_SIZE_BYTES) {
                    appContext.assets.open(MODEL_ASSET).use { input ->
                        modelFile.outputStream().use { output ->
                            input.copyTo(output)
                        }
                    }
                }
                val env = OrtEnvironment.getEnvironment()
                val opts = OrtSession.SessionOptions().apply {
                    // Same thread counts as the benchmark (2 intra / 1 inter).
                    setIntraOpNumThreads(2)
                    setInterOpNumThreads(1)
                }
                val created = env.createSession(modelFile.absolutePath, opts)
                session = created
                created
            } catch (t: Throwable) {
                // UnsatisfiedLinkError (missing .so), OrtException, IO —
                // all land here; cache the failure so every image does
                // not pay for a fresh doomed load attempt.
                loadFailed = true
                lastError = "${t.javaClass.simpleName}: ${t.message}"
                null
            }
        }
    }

    // ------------------------------------------------------------ inference

    override fun bestPersonScore(image: DecodedImage): Double? {
        val sess = getSession() ?: return null
        return try {
            synchronized(sessionLock) {
                val input = preprocessToNchw(image.pixels, image.width, image.height)
                val env = OrtEnvironment.getEnvironment()
                OnnxTensor.createTensor(
                    env,
                    FloatBuffer.wrap(input),
                    longArrayOf(1, 3, INPUT_SIZE.toLong(), INPUT_SIZE.toLong())
                ).use { tensor ->
                    sess.run(mapOf("input" to tensor)).use { result ->
                        // Output 0 is "dets" [1,300,4]; output 1 is "labels"
                        // [1,300,91]. Only labels matter: the verdict needs
                        // the best person score, not boxes.
                        val labels = result.get(1) as OnnxTensor
                        bestPersonScoreFromLabels(labels.floatBuffer)
                    }
                }
            }
        } catch (_: Throwable) {
            null
        }
    }

    /**
     * Max sigmoid over the 300 queries at class slot 1. Mirrors the
     * benchmark's decode (decode_detections with background_class_id=None):
     * per-class sigmoid, NOT softmax; logits clipped to [-88, 88] exactly
     * as the reference decode does before the sigmoid.
     */
    internal fun bestPersonScoreFromLabels(labels: FloatBuffer): Double {
        var best = 0.0
        for (q in 0 until NUM_QUERIES) {
            val logit = labels.get(q * NUM_CLASSES + PERSON_SLOT).toDouble()
            val clipped = logit.coerceIn(-88.0, 88.0)
            val score = 1.0 / (1.0 + exp(-clipped))
            if (score > best) best = score
        }
        return best
    }

    /**
     * Preprocess: stretch to 384x384, half-pixel bilinear, ImageNet
     * normalise, NCHW float32 — replicating rfdetr 1.12.1's
     * preprocess_to_nchw (torchvision to_tensor -> resize antialias=False
     * -> normalize) via its torch-free numpy fallback
     * _bilinear_resize_half_pixel. For thumbnails (max 320px) the
     * reference takes its horizontal-first branch (3*srcH < 4*outH);
     * this does the same: interpolate each source row horizontally once,
     * then gather the two rows each output pixel needs. Bilinear is
     * linear, so resizing the 0..255 ints and dividing by 255 afterwards
     * equals to_tensor's divide-first up to float32 rounding.
     * Aspect ratio is NOT preserved — that is predict()'s own default.
     */
    internal fun preprocessToNchw(pixels: IntArray, srcW: Int, srcH: Int): FloatArray {
        val size = INPUT_SIZE
        // Half-pixel source coordinates, clipped to the source grid.
        val srcX = FloatArray(size) { ox ->
            ((ox + 0.5f) * srcW / size - 0.5f).coerceIn(0f, (srcW - 1).toFloat())
        }
        val srcY = FloatArray(size) { oy ->
            ((oy + 0.5f) * srcH / size - 0.5f).coerceIn(0f, (srcH - 1).toFloat())
        }
        val x0 = IntArray(size) { srcX[it].toInt() } // floor (coords >= 0)
        val x1 = IntArray(size) { minOf(x0[it] + 1, srcW - 1) }
        val y0 = IntArray(size) { srcY[it].toInt() }
        val y1 = IntArray(size) { minOf(y0[it] + 1, srcH - 1) }
        val dx = FloatArray(size) { srcX[it] - x0[it] }
        val dy = FloatArray(size) { srcY[it] - y0[it] }

        // Resized RGB in [0,1], interleaved HWC.
        val resized = FloatArray(size * size * 3)
        val rowTop = FloatArray(size * 3)
        val rowBottom = FloatArray(size * 3)
        for (oy in 0 until size) {
            // Horizontal pass for the two source rows this output row needs.
            for ((row, sy) in arrayOf(rowTop to y0[oy], rowBottom to y1[oy])) {
                val base = sy * srcW
                for (ox in 0 until size) {
                    val a = pixels[base + x0[ox]]
                    val b = pixels[base + x1[ox]]
                    val w = dx[ox]
                    val iw = 1f - w
                    row[ox * 3] = (iw * ((a shr 16) and 0xFF) + w * ((b shr 16) and 0xFF)) / 255f
                    row[ox * 3 + 1] = (iw * ((a shr 8) and 0xFF) + w * ((b shr 8) and 0xFF)) / 255f
                    row[ox * 3 + 2] = (iw * (a and 0xFF) + w * (b and 0xFF)) / 255f
                }
            }
            val wy = dy[oy]
            val iwy = 1f - wy
            val outBase = oy * size * 3
            for (i in 0 until size * 3) {
                resized[outBase + i] = iwy * rowTop[i] + wy * rowBottom[i]
            }
        }

        // Normalise into NCHW: (v - mean) / std per channel.
        val hw = size * size
        val out = FloatArray(3 * hw)
        for (i in 0 until hw) {
            for (c in 0..2) {
                out[c * hw + i] = (resized[i * 3 + c] - MEAN[c]) / STD[c]
            }
        }
        return out
    }
}
