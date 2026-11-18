package com.filterplatform.app

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import kotlin.concurrent.thread

/**
 * Filter Platform — Android skeleton (Phase 5 starter).
 *
 * Screens (one activity, three sections):
 *  1. Setup — API base URL + API token (stored encrypted). Also creates the
 *     customer account (name + email) the device belongs to.
 *  2. Registration — create device (name) -> shows the 6-digit activation
 *     code -> register with the code -> active state.
 *  3. Device — policy card, manual "check status" (heartbeat + status),
 *     dashboard link.
 *
 * All network work runs on a background thread; results/errors are posted
 * back to the UI thread. Errors show the real server message.
 */
class MainActivity : Activity() {

    private lateinit var store: SecureStore

    private lateinit var setupSection: LinearLayout
    private lateinit var registerSection: LinearLayout
    private lateinit var deviceSection: LinearLayout
    private lateinit var progress: ProgressBar
    private lateinit var statusText: TextView

    private lateinit var baseUrlInput: EditText
    private lateinit var tokenInput: EditText
    private lateinit var customerNameInput: EditText
    private lateinit var customerEmailInput: EditText
    private lateinit var deviceNameInput: EditText
    private lateinit var codeInput: EditText
    private lateinit var codeDisplay: TextView
    private lateinit var policyText: TextView
    private lateinit var heartbeatText: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 0.1.0 died at launch with only the system's "keeps stopping"
        // dialog — if startup throws again, show the real error on screen
        // so it can be reported instead of guessed at.
        try {
            onCreateSafe(savedInstanceState)
        } catch (e: Exception) {
            val tv = TextView(this)
            tv.text = "Filter Platform failed to start:\n\n" +
                "${e.javaClass.simpleName}: ${e.message}\n\n" +
                e.stackTrace.take(12).joinToString("\n")
            tv.setPadding(32, 32, 32, 32)
            setContentView(tv)
        }
    }

    private fun onCreateSafe(savedInstanceState: Bundle?) {
        setContentView(R.layout.activity_main)
        store = SecureStore(this)

        setupSection = findViewById(R.id.setupSection)
        registerSection = findViewById(R.id.registerSection)
        deviceSection = findViewById(R.id.deviceSection)
        progress = findViewById(R.id.progress)
        statusText = findViewById(R.id.statusText)

        baseUrlInput = findViewById(R.id.baseUrlInput)
        tokenInput = findViewById(R.id.tokenInput)
        customerNameInput = findViewById(R.id.customerNameInput)
        customerEmailInput = findViewById(R.id.customerEmailInput)
        deviceNameInput = findViewById(R.id.deviceNameInput)
        codeInput = findViewById(R.id.codeInput)
        codeDisplay = findViewById(R.id.codeDisplay)
        policyText = findViewById(R.id.policyText)
        heartbeatText = findViewById(R.id.heartbeatText)

        baseUrlInput.setText(store.baseUrl)
        tokenInput.setText(store.apiToken)
        customerNameInput.setText(store.customerName ?: "")

        findViewById<Button>(R.id.saveSetupButton).setOnClickListener { saveSetup() }
        findViewById<Button>(R.id.createDeviceButton).setOnClickListener { createDevice() }
        findViewById<Button>(R.id.registerButton).setOnClickListener { registerWithCode() }
        findViewById<Button>(R.id.refreshPolicyButton).setOnClickListener { loadPolicy() }
        findViewById<Button>(R.id.checkStatusButton).setOnClickListener { checkStatus() }
        findViewById<Button>(R.id.dashboardButton).setOnClickListener { openDashboard() }
        findViewById<Button>(R.id.browserButton).setOnClickListener { openBrowser() }
        findViewById<Button>(R.id.resetButton).setOnClickListener { resetAll() }

        showScreen()
    }

    private fun api(): ApiClient = ApiClient(store.baseUrl, store.apiToken)

    private fun showScreen() {
        when {
            !store.isSetup -> {
                setupSection.visibility = View.VISIBLE
                registerSection.visibility = View.GONE
                deviceSection.visibility = View.GONE
                setStatus("Enter the API address and token to connect this phone.")
            }
            !store.isRegistered -> {
                setupSection.visibility = View.GONE
                registerSection.visibility = View.VISIBLE
                deviceSection.visibility = View.GONE
                setStatus("Connected. Create this device to get an activation code.")
            }
            else -> {
                setupSection.visibility = View.GONE
                registerSection.visibility = View.GONE
                deviceSection.visibility = View.VISIBLE
                setStatus("Device active: ${store.deviceName ?: store.deviceId}")
                loadPolicy()
            }
        }
    }

    private fun setStatus(msg: String) {
        statusText.text = msg
    }

    private fun setBusy(busy: Boolean) {
        progress.visibility = if (busy) View.VISIBLE else View.GONE
    }

    /** Runs [block] on a background thread; on error shows the real message. */
    private fun runApi(label: String, block: (ApiClient) -> Unit) {
        setBusy(true)
        setStatus("$label…")
        thread {
            try {
                block(api())
            } catch (e: ApiException) {
                runOnUiThread { setStatus("Error (${e.status}): ${e.message}") }
            } catch (e: Exception) {
                runOnUiThread { setStatus("Error: ${e.message ?: e.javaClass.simpleName}") }
            } finally {
                runOnUiThread { setBusy(false) }
            }
        }
    }

    private fun saveSetup() {
        val baseUrl = baseUrlInput.text.toString().trim().removeSuffix("/")
        val token = tokenInput.text.toString().trim()
        val name = customerNameInput.text.toString().trim()
        val email = customerEmailInput.text.toString().trim()
        if (baseUrl.isBlank() || token.isBlank()) {
            setStatus("Error: API address and token are both required.")
            return
        }
        if (name.isBlank() || email.isBlank()) {
            setStatus("Error: customer name and email are required (the device belongs to a customer).")
            return
        }
        store.baseUrl = baseUrl
        store.apiToken = token
        store.customerName = name
        // Create the customer on the server first, so the device has an owner.
        runApi("Creating customer") { client ->
            val customer = client.createCustomer(name, email)
            store.customerId = customer.id
            runOnUiThread {
                setStatus("Customer created: ${customer.name}. Now create this device.")
                showScreen()
            }
        }
    }

    private fun createDevice() {
        val customerId = store.customerId
        val name = deviceNameInput.text.toString().trim()
        if (customerId.isNullOrBlank()) {
            setStatus("Error: no customer yet — go back to setup and save it first.")
            return
        }
        if (name.isBlank()) {
            setStatus("Error: give this device a name (e.g. \"Yankel's phone\").")
            return
        }
        runApi("Creating device") { client ->
            val device = client.createDevice(customerId, name)
            store.deviceName = device.name
            runOnUiThread {
                codeDisplay.text = "Activation code for \"${device.name}\": ${device.activationCode ?: "—"}\n" +
                    "Enter this 6-digit code below (or in the dashboard) to activate the device."
                codeInput.setText(device.activationCode ?: "")
                setStatus("Device created (pending). Activation code shown above.")
            }
        }
    }

    private fun registerWithCode() {
        val code = codeInput.text.toString().trim()
        if (code.length != 6 || !code.all { it.isDigit() }) {
            setStatus("Error: the activation code is 6 digits.")
            return
        }
        runApi("Registering device") { client ->
            val device = client.registerDevice(code)
            store.deviceId = device.id
            store.policyId = device.policyId
            runOnUiThread {
                setStatus("Device activated: ${device.name}.")
                showScreen()
            }
        }
    }

    private fun loadPolicy() {
        val policyId = store.policyId
        if (policyId.isNullOrBlank()) {
            policyText.text = "No policy assigned to this device yet."
            return
        }
        runApi("Loading policy") { client ->
            val p = client.getPolicy(policyId)
            runOnUiThread {
                policyText.text = buildString {
                    append("Policy: ${p.name}\n")
                    append("Block images (human pictures): ${yesNo(p.blockImages)}\n")
                    append("Cover images instead of blocking: ${yesNo(p.coverImages)}\n")
                    append("Filter ads: ${yesNo(p.filterAds)}\n")
                    append("Force SafeSearch: ${yesNo(p.forceSafeSearch)}\n")
                    append("Auto-decide threshold: ${p.autoDecideThreshold}\n")
                    append("Require approval for new sites: ${yesNo(p.requireApprovalForNewSites)}")
                }
                setStatus("Policy loaded.")
            }
        }
    }

    private fun checkStatus() {
        val deviceId = store.deviceId
        if (deviceId.isNullOrBlank()) {
            setStatus("Error: no registered device yet.")
            return
        }
        runApi("Checking status") { client ->
            client.heartbeat(deviceId, policyVersion = null)
            val s = client.getDeviceStatus(deviceId)
            runOnUiThread {
                heartbeatText.text = if (s != null) {
                    "Online: ${s.status}\nFilter active: ${yesNo(s.filterActive)}\n" +
                        "Policy version: ${s.policyVersion ?: "—"}\nLast checked: ${s.checkedAt ?: "—"}"
                } else {
                    "Heartbeat sent, but no status row came back yet."
                }
                setStatus("Status checked (heartbeat sent).")
            }
        }
    }

    private fun openDashboard() {
        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(SecureStore.DASHBOARD_URL)))
    }

    private fun openBrowser() {
        startActivity(Intent(this, BrowserActivity::class.java))
    }

    private fun resetAll() {
        store.clearAll()
        baseUrlInput.setText(SecureStore.DEFAULT_BASE_URL)
        tokenInput.setText("")
        customerNameInput.setText("")
        customerEmailInput.setText("")
        deviceNameInput.setText("")
        codeInput.setText("")
        codeDisplay.text = ""
        policyText.text = ""
        heartbeatText.text = ""
        showScreen()
    }

    private fun yesNo(value: Boolean) = if (value) "Yes" else "No"
}
