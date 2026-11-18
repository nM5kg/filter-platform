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
    val requireApprovalForNewSites: Boolean
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
            requireApprovalForNewSites = d.optBoolean("require_approval_for_new_sites", false)
        )
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
