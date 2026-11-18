package com.filterplatform.app

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit tests for the API response parsing — pure functions, no network.
 * These run with ./gradlew testDebugUnitTest.
 */
class ApiClientTest {

    @Test
    fun parseDevice_withActivationCode() {
        val json = JSONObject(
            """{"data":{"id":"11111111-1111-4111-8111-111111111111",
            |"customer_id":"22222222-2222-4222-8222-222222222222",
            |"name":"Yankel's phone","platform":"android","status":"pending",
            |"policy_id":"33333333-3333-4333-8333-333333333333",
            |"activation_code":"482913","activated_at":null}}""".trimMargin()
        )
        val d = JsonParsing.parseDevice(json)
        assertEquals("482913", d.activationCode)
        assertEquals("pending", d.status)
        assertEquals("android", d.platform)
        assertNull(d.activatedAt)
    }

    @Test
    fun parseDevice_registeredHasNoCode() {
        val json = JSONObject(
            """{"data":{"id":"11111111-1111-4111-8111-111111111111",
            |"customer_id":"22222222-2222-4222-8222-222222222222",
            |"name":"Yankel's phone","platform":"android","status":"active",
            |"policy_id":"33333333-3333-4333-8333-333333333333",
            |"activation_code":"482913","activated_at":"2026-11-18T10:00:00Z"}}""".trimMargin()
        )
        val d = JsonParsing.parseDevice(json)
        assertEquals("active", d.status)
        assertEquals("2026-11-18T10:00:00Z", d.activatedAt)
    }

    @Test
    fun parsePolicy_thresholdReturnedAsString() {
        // Live Worker returns auto_decide_threshold as a Postgres-numeric
        // STRING ("0.7000"), not a JSON number — verified 2026-11-18.
        val json = JSONObject(
            """{"data":{"id":"33333333-3333-4333-8333-333333333333",
            |"name":"Standard","block_images":true,"cover_images":false,
            |"filter_ads":false,"force_safesearch":true,
            |"auto_decide_threshold":"0.7000","require_approval_for_new_sites":false}}""".trimMargin()
        )
        val p = JsonParsing.parsePolicy(json)
        assertEquals(0.7, p.autoDecideThreshold, 0.001)
    }

    @Test
    fun parsePolicy_standardPolicyFields() {
        val json = JSONObject(
            """{"data":{"id":"33333333-3333-4333-8333-333333333333",
            |"name":"Standard","block_images":true,"cover_images":false,
            |"filter_ads":false,"force_safesearch":true,
            |"auto_decide_threshold":0.7,"require_approval_for_new_sites":false,
            |"versions":[]}}""".trimMargin()
        )
        val p = JsonParsing.parsePolicy(json)
        assertEquals("Standard", p.name)
        assertTrue(p.blockImages)
        assertEquals(false, p.coverImages)
        assertTrue(p.forceSafeSearch)
        assertEquals(0.7, p.autoDecideThreshold, 0.001)
    }

    @Test
    fun parseDeviceStatus_nullWhenNoRow() {
        val json = JSONObject("""{"data":null}""")
        assertNull(JsonParsing.parseDeviceStatus(json))
    }

    @Test
    fun parseDeviceStatus_onlineRow() {
        val json = JSONObject(
            """{"data":{"status":"online","filter_active":true,
            |"policy_version":1,"checked_at":"2026-11-18T10:05:00Z"}}""".trimMargin()
        )
        val s = JsonParsing.parseDeviceStatus(json)!!
        assertEquals("online", s.status)
        assertTrue(s.filterActive)
        assertEquals(1, s.policyVersion)
    }

    @Test
    fun errorMessage_prefersServerError() {
        assertEquals(
            "Invalid or already-used activation code",
            JsonParsing.errorMessage(
                """{"error":"Invalid or already-used activation code"}""",
                "HTTP 404"
            )
        )
        assertEquals("HTTP 500", JsonParsing.errorMessage("not json", "HTTP 500"))
    }
}
