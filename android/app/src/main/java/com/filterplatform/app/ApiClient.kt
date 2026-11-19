// Filter Platform — Android app (Phase 5 starter, Android-first skeleton).
// Real API calls only against the Phase 1 Worker; no demo/fake data.
// A failed API call shows the real error, never a fake success.
package com.filterplatform.app

import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/** One API error carrying the real HTTP status + server message. */
class ApiException(val status: Int, message: String) : Exception(message)

/** Minimal models, parsed from the exact JSON the Worker returns. */
data class Customer(val id: String, val name: String, val email: String)
data class Device(
    val id: String,
    val customerId: String,
    val name: String,
    val platform: String,
    val status: String,
    val policyId: String?,
    val activationCode: String?,
    val activatedAt: String?
)
data class Policy(
    val id: String,
    val name: String,
    val blockImages: Boolean,
    val coverImages: Boolean,
    val filterAds: Boolean,
    val forceSafeSearch: Boolean,
    val autoDecideThreshold: Double,
    val requireApprovalForNewSites: Boolean,
    /**
     * How a confirmed human picture is shown on review ("paint" |
     * "block"). NULL means the server did not specify a mode — the
     * app then uses its local setting (SettingsStore). A server mode,
     * when present, wins over the local setting (see
     * BrowserActivity.effectivePolicy). Defaults to null so policies
     * created before human_image_mode existed keep working.
     */
    val humanImageMode: HumanImageMode? = null
)

/**
 * One recorded review decision (POST /api/v1/review-decisions).
 * Field-for-field the server record: image_key ('b:<sha256hex>' for
 * a content hash, 'u:<sha256hex>' for a URL hash), decision
 * ('allow' | 'allow_painted' | 'block' | 'uncertain'), model
 * ('rf-detr-nano'), best_score, boxes (fractions 0..1),
 * human_image_mode ('paint' | 'block'), first_detector — the server
 * requires an OBJECT or null for first_detector, so the app sends
 * {"detector":"rf-detr-nano","first_signal":"efficientdet"|"face-api"|"none"}
 * naming the first-stage detector that produced the signal.
 * NOTE (sibling mismatch, 2026-11-19): the web content script
 * currently sends first_detector as a plain STRING ('efficientdet' /
 * 'face-api' / 'none'), which the server's object-or-null check
 * rejects with 400. The native side sends the object form the
 * server accepts; the web side still needs aligning (coordinator).
 */
data class ReviewDecisionRecord(
    val imageKey: String,
    val imageUrl: String?,
    val pageUrl: String?,
    val decision: ReviewDecision,
    val model: String = "rf-detr-nano",
    val bestScore: Double,
    val boxes: List<PersonBox> = emptyList(),
    val humanImageMode: HumanImageMode = HumanImageMode.PAINT,
    /** First-stage detector that produced the signal, if known. */
    val firstSignal: String? = null
)
data class DeviceStatus(
    val status: String,
    val filterActive: Boolean,
    val policyVersion: Int?,
    val checkedAt: String?
)

object JsonParsing {
    fun parseCustomer(json: JSONObject): Customer {
        val d = json.optJSONObject("data") ?: json
        return Customer(
            id = d.getString("id"),
            name = d.getString("name"),
            email = d.getString("email")
        )
    }

    fun parseDevice(json: JSONObject): Device {
        val d = json.optJSONObject("data") ?: json
        return Device(
            id = d.getString("id"),
            customerId = d.optString("customer_id"),
            name = d.getString("name"),
            platform = d.optString("platform"),
            status = d.optString("status"),
            policyId = if (d.isNull("policy_id")) null else d.optString("policy_id"),
            activationCode = if (d.isNull("activation_code")) null else d.optString("activation_code"),
            activatedAt = if (d.isNull("activated_at")) null else d.optString("activated_at")
        )
    }

    fun parsePolicy(json: JSONObject): Policy {
        val d = json.optJSONObject("data") ?: json
        return Policy(
            id = d.getString("id"),
            name = d.getString("name"),
            blockImages = d.optBoolean("block_images", false),
            coverImages = d.optBoolean("cover_images", false),
            filterAds = d.optBoolean("filter_ads", false),
            forceSafeSearch = d.optBoolean("force_safesearch", false),
            autoDecideThreshold = d.optDouble("auto_decide_threshold", 0.70),
            requireApprovalForNewSites = d.optBoolean("require_approval_for_new_sites", false),
            humanImageMode = HumanImageMode.parse(
                if (d.isNull("human_image_mode")) null
                else d.optString("human_image_mode", "").ifBlank { null }
            )
        )
    }

    /** Parse one review-decision row (GET /api/v1/review-decisions),
     *  or null when the body carries no decision. Boxes are parsed
     *  with the same fraction rules as the engine. */
    fun parseReviewDecision(json: JSONObject): ReviewDecisionRecord? {
        val d = json.optJSONObject("data") ?: return null
        val decision = ReviewDecision.parse(d.optString("decision", ""))
            ?: return null
        val boxes = ArrayList<PersonBox>()
        val arr = d.optJSONArray("boxes")
        if (arr != null) {
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                PersonBox.fromWire(
                    if (o.has("x")) o.optDouble("x") else null,
                    if (o.has("y")) o.optDouble("y") else null,
                    if (o.has("w")) o.optDouble("w") else null,
                    if (o.has("h")) o.optDouble("h") else null,
                    if (o.has("score")) o.optDouble("score") else null
                )?.let { boxes.add(it) }
            }
        }
        return ReviewDecisionRecord(
            imageKey = d.optString("image_key", ""),
            imageUrl = if (d.isNull("image_url")) null else d.optString("image_url"),
            pageUrl = if (d.isNull("page_url")) null else d.optString("page_url"),
            decision = decision,
            model = d.optString("model", "rf-detr-nano"),
            bestScore = d.optDouble("best_score", 0.0),
            boxes = boxes,
            humanImageMode = HumanImageMode.parse(d.optString("human_image_mode", "paint"))
                ?: HumanImageMode.PAINT,
            firstSignal = null
        )
    }

    /** Build the POST /api/v1/review-decisions body for [record].
     *  Pure (unit-tested): the server validates decision, boxes
     *  (each {x,y,w,h,score} numbers 0..1), human_image_mode and a
     *  first_detector that is an object or null — so first_detector
     *  goes out as {"detector": ..., "first_signal": ...}. */
    fun reviewDecisionBody(record: ReviewDecisionRecord): JSONObject {
        val body = JSONObject()
            .put("image_key", record.imageKey)
            .put("decision", ReviewDecision.wireName(record.decision))
            .put("model", record.model)
            .put("best_score", record.bestScore)
            .put("human_image_mode", HumanImageMode.wireName(record.humanImageMode))
        if (record.imageUrl != null) body.put("image_url", record.imageUrl)
        else body.put("image_url", JSONObject.NULL)
        if (record.pageUrl != null) body.put("page_url", record.pageUrl)
        else body.put("page_url", JSONObject.NULL)
        val boxes = org.json.JSONArray()
        for (b in record.boxes) {
            boxes.put(
                JSONObject()
                    .put("x", b.x).put("y", b.y)
                    .put("w", b.w).put("h", b.h)
                    .put("score", b.score)
            )
        }
        body.put("boxes", boxes)
        val firstDetector = JSONObject().put("detector", record.model)
        if (record.firstSignal != null) {
            firstDetector.put("first_signal", record.firstSignal)
        }
        body.put("first_detector", firstDetector)
        return body
    }

    fun parseDeviceStatus(json: JSONObject): DeviceStatus? {
        val d = json.optJSONObject("data") ?: return null
        return DeviceStatus(
            status = d.optString("status"),
            filterActive = d.optBoolean("filter_active", false),
            policyVersion = if (d.isNull("policy_version")) null else d.optInt("policy_version"),
            checkedAt = if (d.isNull("checked_at")) null else d.optString("checked_at")
        )
    }

    /** Server error body: {"error": "..."} — fall back to the HTTP status text. */
    fun errorMessage(body: String, fallback: String): String {
        return try {
            JSONObject(body).optString("error", fallback).ifBlank { fallback }
        } catch (_: Exception) {
            fallback.ifBlank { body }
        }
    }
}

/**
 * Thin HTTP client for the Filter Platform Worker API.
 * Uses HttpURLConnection + org.json only — no extra network dependencies.
 * Every call is a real network call; failures throw ApiException with the
 * real status and server message.
 */
class ApiClient(private val baseUrl: String, private val apiToken: String) {

    private fun request(method: String, path: String, body: JSONObject? = null): JSONObject {
        val url = URL(baseUrl.trimEnd('/') + path)
        val conn = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 15_000
            readTimeout = 15_000
            setRequestProperty("Authorization", "Bearer $apiToken")
            setRequestProperty("Accept", "application/json")
            setRequestProperty("User-Agent", "FilterPlatform-Android/0.1")
            if (body != null) {
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            }
        }
        val status = conn.responseCode
        val stream = if (status in 200..299) conn.inputStream else conn.errorStream
        val text = stream?.let {
            BufferedReader(InputStreamReader(it, Charsets.UTF_8)).use { r -> r.readText() }
        } ?: ""
        conn.disconnect()
        if (status !in 200..299) {
            throw ApiException(status, JsonParsing.errorMessage(text, "HTTP $status"))
        }
        return JSONObject(text)
    }

    fun createCustomer(name: String, email: String, phone: String? = null): Customer {
        val body = JSONObject().put("name", name).put("email", email)
        if (!phone.isNullOrBlank()) body.put("phone", phone)
        return JsonParsing.parseCustomer(request("POST", "/api/v1/customers", body))
    }

    fun listCustomers(): List<Customer> {
        val json = request("GET", "/api/v1/customers")
        val arr = json.optJSONArray("data") ?: return emptyList()
        return (0 until arr.length()).map { i ->
            val d = arr.getJSONObject(i)
            Customer(d.getString("id"), d.getString("name"), d.getString("email"))
        }
    }

    /** Creates a pending device; the returned Device carries the 6-digit activation code. */
    fun createDevice(customerId: String, name: String): Device {
        val body = JSONObject()
            .put("customer_id", customerId)
            .put("name", name)
            .put("platform", "android")
        return JsonParsing.parseDevice(request("POST", "/api/v1/devices", body))
    }

    /** Activates a pending device with its 6-digit code. Wrong/used code -> 404 ApiException. */
    fun registerDevice(code: String): Device {
        val body = JSONObject().put("code", code.trim())
        return JsonParsing.parseDevice(request("POST", "/api/v1/devices/register", body))
    }

    fun getPolicy(policyId: String): Policy =
        JsonParsing.parsePolicy(request("GET", "/api/v1/policies/$policyId"))

    /**
     * Look up a recorded review decision by image key. Returns null
     * when the server has no decision for the key (HTTP 404) — that
     * is a normal "not reviewed yet", not an error. Other failures
     * throw ApiException, like every other call here.
     */
    fun getReviewDecision(imageKey: String): ReviewDecisionRecord? {
        return try {
            JsonParsing.parseReviewDecision(
                request(
                    "GET",
                    "/api/v1/review-decisions?image_key=" +
                        URLEncoder.encode(imageKey, "UTF-8")
                )
            )
        } catch (e: ApiException) {
            if (e.status == 404) null else throw e
        }
    }

    /** Record (upsert) a review decision on the server. Fire-and-
     *  forget at the call site: a failed POST must never undo the
     *  UI decision — the local store (ReviewDecisionStore) is the
     *  fallback, and the caller saves there regardless. */
    fun recordReviewDecision(record: ReviewDecisionRecord): JSONObject =
        request(
            "POST", "/api/v1/review-decisions",
            JsonParsing.reviewDecisionBody(record)
        )

    fun getDeviceStatus(deviceId: String): DeviceStatus? =
        JsonParsing.parseDeviceStatus(request("GET", "/api/v1/devices/$deviceId/status"))

    fun heartbeat(deviceId: String, policyVersion: Int?): JSONObject {
        val body = JSONObject()
            .put("status", "online")
            .put("filter_active", true)
        if (policyVersion != null) body.put("policy_version", policyVersion)
        return request("POST", "/api/v1/devices/$deviceId/heartbeat", body)
    }

    fun checkDomain(domain: String, customerId: String? = null): JSONObject {
        var path = "/api/v1/domains/check?domain=" + URLEncoder.encode(domain.trim().lowercase(), "UTF-8")
        if (!customerId.isNullOrBlank()) path += "&customer_id=" + URLEncoder.encode(customerId, "UTF-8")
        return request("GET", path)
    }
}
