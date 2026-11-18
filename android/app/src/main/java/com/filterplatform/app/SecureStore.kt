package com.filterplatform.app

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Encrypted storage for the API base URL, API token and the registered
 * device identity. The API token is typed in by the user at setup and is
 * never hardcoded anywhere in the app.
 */
class SecureStore(context: Context) {

    // Encrypted storage when the device keystore works; plain
    // SharedPreferences as a fallback. 0.1.0 crashed at launch on the
    // user's BLU phone — EncryptedSharedPreferences.create() throwing in
    // the constructor (before any UI can report it) is a prime suspect,
    // so the constructor must never throw.
    private val prefs: SharedPreferences = try {
        EncryptedSharedPreferences.create(
            context,
            "filter_platform_secure",
            MasterKey.Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build(),
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    } catch (_: Exception) {
        context.getSharedPreferences("filter_platform_plain", Context.MODE_PRIVATE)
    }

    var baseUrl: String
        get() = prefs.getString(KEY_BASE_URL, DEFAULT_BASE_URL) ?: DEFAULT_BASE_URL
        set(value) { prefs.edit().putString(KEY_BASE_URL, value).apply() }

    var apiToken: String
        get() = prefs.getString(KEY_API_TOKEN, "") ?: ""
        set(value) { prefs.edit().putString(KEY_API_TOKEN, value).apply() }

    var customerId: String?
        get() = prefs.getString(KEY_CUSTOMER_ID, null)
        set(value) { prefs.edit().putString(KEY_CUSTOMER_ID, value).apply() }

    var customerName: String?
        get() = prefs.getString(KEY_CUSTOMER_NAME, null)
        set(value) { prefs.edit().putString(KEY_CUSTOMER_NAME, value).apply() }

    var deviceId: String?
        get() = prefs.getString(KEY_DEVICE_ID, null)
        set(value) { prefs.edit().putString(KEY_DEVICE_ID, value).apply() }

    var deviceName: String?
        get() = prefs.getString(KEY_DEVICE_NAME, null)
        set(value) { prefs.edit().putString(KEY_DEVICE_NAME, value).apply() }

    var policyId: String?
        get() = prefs.getString(KEY_POLICY_ID, null)
        set(value) { prefs.edit().putString(KEY_POLICY_ID, value).apply() }

    val isSetup: Boolean get() = apiToken.isNotBlank()
    val isRegistered: Boolean get() = !deviceId.isNullOrBlank()

    fun clearAll() {
        prefs.edit().clear().apply()
    }

    companion object {
        const val DEFAULT_BASE_URL = "https://filter-platform-api.gavhah-copy.workers.dev"
        const val DASHBOARD_URL = "https://filter-platform-dashboard.pages.dev"
        private const val KEY_BASE_URL = "base_url"
        private const val KEY_API_TOKEN = "api_token"
        private const val KEY_CUSTOMER_ID = "customer_id"
        private const val KEY_CUSTOMER_NAME = "customer_name"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_DEVICE_NAME = "device_name"
        private const val KEY_POLICY_ID = "policy_id"
    }
}
