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
        // No human_image_mode on the row: null (the app then uses
        // its local setting — see BrowserActivity.effectivePolicy).
        assertNull(p.humanImageMode)
    }

    @Test
    fun parsePolicy_humanImageMode() {
        val block = JSONObject(
            """{"data":{"id":"33333333-3333-4333-8333-333333333333",
            |"name":"Standard","block_images":true,"cover_images":true,
            |"filter_ads":false,"force_safesearch":true,
            |"auto_decide_threshold":0.7,"require_approval_for_new_sites":false,
            |"human_image_mode":"block"}}""".trimMargin()
        )
        assertEquals(HumanImageMode.BLOCK, JsonParsing.parsePolicy(block).humanImageMode)
        val paint = JSONObject(
            """{"data":{"id":"33333333-3333-4333-8333-333333333333",
            |"name":"Standard","block_images":true,"cover_images":true,
            |"filter_ads":false,"force_safesearch":true,
            |"auto_decide_threshold":0.7,"require_approval_for_new_sites":false,
            |"human_image_mode":"paint"}}""".trimMargin()
        )
        assertEquals(HumanImageMode.PAINT, JsonParsing.parsePolicy(paint).humanImageMode)
        // A bogus mode parses as "not specified", never a crash.
        val bogus = JSONObject(
            """{"data":{"id":"33333333-3333-4333-8333-333333333333",
            |"name":"Standard","block_images":true,"cover_images":true,
            |"filter_ads":false,"force_safesearch":true,
            |"auto_decide_threshold":0.7,"require_approval_for_new_sites":false,
            |"human_image_mode":"nonsense"}}""".trimMargin()
        )
        assertNull(JsonParsing.parsePolicy(bogus).humanImageMode)
    }

    @Test
    fun reviewDecisionBody_matchesServerValidation() {
        // The server (worker.js POST /api/v1/review-decisions)
        // requires: decision in allow|allow_painted|block|uncertain,
        // boxes of {x,y,w,h,score} numbers 0..1, human_image_mode
        // paint|block, first_detector an OBJECT or null.
        val record = ReviewDecisionRecord(
            imageKey = "b:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
            imageUrl = "https://example.com/pic.jpg",
            pageUrl = "https://example.com/",
            decision = ReviewDecision.ALLOW_PAINTED,
            bestScore = 0.87,
            boxes = listOf(PersonBox(0.1, 0.2, 0.5, 0.6, 0.87)),
            humanImageMode = HumanImageMode.PAINT,
            firstSignal = "efficientdet"
        )
        val body = JsonParsing.reviewDecisionBody(record)
        assertEquals(record.imageKey, body.getString("image_key"))
        assertEquals("allow_painted", body.getString("decision"))
        assertEquals("rf-detr-nano", body.getString("model"))
        assertEquals(0.87, body.getDouble("best_score"), 0.001)
        assertEquals("paint", body.getString("human_image_mode"))
        val boxes = body.getJSONArray("boxes")
        assertEquals(1, boxes.length())
        assertEquals(0.1, boxes.getJSONObject(0).getDouble("x"), 0.001)
        assertEquals(0.6, boxes.getJSONObject(0).getDouble("h"), 0.001)
        val first = body.getJSONObject("first_detector")
        assertEquals("rf-detr-nano", first.getString("detector"))
        assertEquals("efficientdet", first.getString("first_signal"))
    }

    @Test
    fun parseReviewDecision_roundTrip() {
        val record = ReviewDecisionRecord(
            imageKey = "u:abc123",
            imageUrl = "https://example.com/pic.jpg",
            pageUrl = "https://example.com/",
            decision = ReviewDecision.BLOCK,
            bestScore = 0.95,
            boxes = listOf(PersonBox(0.0, 0.0, 0.9, 0.9, 0.95)),
            humanImageMode = HumanImageMode.BLOCK
        )
        val json = JSONObject().put("data", JsonParsing.reviewDecisionBody(record))
        val parsed = JsonParsing.parseReviewDecision(json)!!
        assertEquals("u:abc123", parsed.imageKey)
        assertEquals(ReviewDecision.BLOCK, parsed.decision)
        assertEquals(0.95, parsed.bestScore, 0.001)
        assertEquals(1, parsed.boxes.size)
        assertEquals(0.9, parsed.boxes[0].w, 0.001)
        assertEquals(HumanImageMode.BLOCK, parsed.humanImageMode)
        // No decision in the body -> null, not a crash.
        assertNull(JsonParsing.parseReviewDecision(JSONObject("""{"data":{}}""")))
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
