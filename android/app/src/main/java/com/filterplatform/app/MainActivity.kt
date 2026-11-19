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
import android.widget.ScrollView
import android.widget.TextView
import java.io.File
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

    private var normalStarted = false

    // ------------------------------------------------------------------
    // 0.2.1-test diagnostic build: startup crash reporting.
    //
    // 0.2.0 dies at launch on the user's BLU phone with only the system's
    // "keeps stopping" dialog and no UI. The old code caught only
    // Exception around onCreateSafe() and called super.onCreate() BEFORE
    // the try — so an Error (NoClassDefFoundError, UnsatisfiedLinkError,
    // VerifyError, ...) escaped with no report at all. This build:
    //  * writes a checkpoint line to getFilesDir()/startup-report.txt at
    //    every startup stage, so the last line reached names the failing
    //    step even when nothing can be shown on screen;
    //  * installs a default uncaught-exception handler FIRST (before
    //    super.onCreate) that writes the full trace + cause chain to the
    //    same file, then chains to the previous handler;
    //  * on the next launch, shows the previous crash report on screen
    //    FIRST, before trying to start normally;
    //  * catches Throwable around the WHOLE onCreate (super.onCreate
    //    included) and shows class + message + first 20 frames on screen.
    // The file is the evidence; the on-screen text is for the user to
    // photograph / read out. Nothing here sends anything anywhere.
    // ------------------------------------------------------------------

    /** Append one line to the startup report file, opening + flushing +
     *  closing it on every call (never held open). Never throws. */
    private fun appendReport(line: String) {
        try {
            File(filesDir, REPORT_FILE_NAME).appendText(line + "\n")
        } catch (_: Throwable) {
            // Reporting must never kill startup itself.
        }
    }

    /** Read the report file left by a previous run, or null if none. */
    private fun readPreviousReport(): String? {
        return try {
            val f = File(filesDir, REPORT_FILE_NAME)
            if (!f.exists()) null else f.readText().ifBlank { null }
        } catch (_: Throwable) {
            null
        }
    }

    private fun isCrashReport(text: String): Boolean =
        text.contains("UNCAUGHT EXCEPTION") || text.contains("STARTUP FAILED")

    /** Full trace with the whole cause chain (class names included). */
    private fun formatThrowable(t: Throwable, maxFramesPerLevel: Int): String =
        buildString {
            var cur: Throwable? = t
            var depth = 0
            while (cur != null) {
                if (depth == 0) append(cur.javaClass.name) else append("Caused by: ${cur.javaClass.name}")
                append(": ${cur.message}\n")
                val frames = cur.stackTrace.take(maxFramesPerLevel)
                for (frame in frames) append("    at $frame\n")
                cur = cur.cause
                depth++
                if (depth > 10) {
                    append("    ... (cause chain truncated)\n")
                    break
                }
            }
        }

    /** Install the uncaught-exception handler FIRST, before super.onCreate.
     *  It writes the full trace to the report file, then chains to the
     *  previous default handler so the system still shows its dialog. */
    private fun installCrashHandler() {
        try {
            val previous = Thread.getDefaultUncaughtExceptionHandler()
            Thread.setDefaultUncaughtExceptionHandler { thread, t ->
                try {
                    appendReport("UNCAUGHT EXCEPTION on thread ${thread.name}:")
                    appendReport(formatThrowable(t, Int.MAX_VALUE))
                } catch (_: Throwable) {
                    // Nothing more we can do; still chain below.
                }
                if (previous != null) {
                    previous.uncaughtException(thread, t)
                } else {
                    android.os.Process.killProcess(android.os.Process.myPid())
                }
            }
        } catch (_: Throwable) {
            // Handler install must never kill startup itself.
        }
    }

    /** On-screen scrollable text view (selectable, so it can be copied). */
    private fun scrollableText(text: String): ScrollView {
        val tv = TextView(this)
        tv.text = text
        tv.setPadding(32, 32, 32, 32)
        tv.setTextIsSelectable(true)
        val scroll = ScrollView(this)
        scroll.addView(tv)
        return scroll
    }

    /** Show a startup failure on screen (the old Exception path, now for
     *  Throwable too, with the first 20 frames). If even setContentView
     *  fails, the trace is already in the file — rethrow so the system
     *  dialog still appears instead of hanging on a black screen. */
    private fun showStartupFailure(t: Throwable) {
        appendReport("STARTUP FAILED: ${t.javaClass.name}: ${t.message}")
        appendReport(formatThrowable(t, Int.MAX_VALUE))
        val text = "Filter Platform failed to start (diagnostic build 0.2.1-test):\n\n" +
            "${t.javaClass.name}: ${t.message}\n\n" +
            t.stackTrace.take(20).joinToString("\n")
        try {
            setContentView(scrollableText(text))
        } catch (t2: Throwable) {
            try {
                appendReport("COULD NOT SHOW ERROR SCREEN: ${t2.javaClass.name}: ${t2.message}")
            } catch (_: Throwable) {
            }
            throw t
        }
    }

    /** Show the previous run's crash report FIRST, with buttons to clear
     *  it and retry, or to continue into the normal startup anyway. */
    private fun showPreviousCrashReport(report: String, savedInstanceState: Bundle?) {
        val layout = LinearLayout(this)
        layout.orientation = LinearLayout.VERTICAL
        val header = TextView(this)
        header.text = "The app crashed last time it started. This is the saved crash report — please photograph this screen or read it out:\n"
        header.setPadding(32, 32, 32, 16)
        val body = TextView(this)
        body.text = report
        body.setPadding(32, 0, 32, 16)
        body.setTextIsSelectable(true)
        val scroll = ScrollView(this)
        scroll.addView(body)
        val clearButton = Button(this)
        clearButton.text = "Clear report and retry"
        clearButton.setOnClickListener {
            try {
                File(filesDir, REPORT_FILE_NAME).delete()
            } catch (_: Throwable) {
            }
            recreate()
        }
        val continueButton = Button(this)
        continueButton.text = "Continue anyway"
        continueButton.setOnClickListener { startNormal(savedInstanceState) }
        layout.addView(header)
        layout.addView(scroll, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        layout.addView(clearButton)
        layout.addView(continueButton)
        setContentView(layout)
    }

    /** Normal startup (onCreateSafe), guarded so a Throwable anywhere in
     *  it — including inside SecureStore — is shown, not swallowed. */
    private fun startNormal(savedInstanceState: Bundle?) {
        if (normalStarted) return
        normalStarted = true
        try {
            onCreateSafe(savedInstanceState)
            appendReport("onCreateSafe done")
        } catch (t: Throwable) {
            showStartupFailure(t)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        // 0.2.2 device-facts checkpoint (forensics gap #2): one line at
        // the very start of onCreate, so the startup report names the
        // exact device even when nothing else gets far enough to run.
        // Never throws: appendReport swallows everything, and the facts
        // themselves are gathered inside a Throwable catch.
        try {
            val am = getSystemService(ACTIVITY_SERVICE) as? android.app.ActivityManager
            val mem = android.app.ActivityManager.MemoryInfo()
            try { am?.getMemoryInfo(mem) } catch (_: Throwable) { }
            appendReport(
                "DEVICE: manufacturer=${android.os.Build.MANUFACTURER} " +
                    "model=${android.os.Build.MODEL} " +
                    "sdk=${android.os.Build.VERSION.SDK_INT} " +
                    "abis=${android.os.Build.SUPPORTED_ABIS.joinToString(",")} " +
                    "pageSize=${android.system.Os.sysconf(android.system.OsConstants._SC_PAGESIZE)} " +
                    "memAvail=${mem.availMem} memTotal=${mem.totalMem} " +
                    "filesFree=${filesDir.freeSpace} filesUsable=${filesDir.usableSpace}"
            )
        } catch (_: Throwable) {
            // Device-facts reporting must never kill startup itself.
        }
        // Read the previous run's report BEFORE writing anything this run
        // (this run's own checkpoints go into the same file).
        val previousReport = readPreviousReport()
        // Handler first, before super.onCreate, so a failure in
        // super.onCreate itself is also captured to the file.
        installCrashHandler()
        try {
            appendReport("=== launch ${System.currentTimeMillis()} ===")
            appendReport("onCreate entered")
            appendReport("uncaught handler installed")
            super.onCreate(savedInstanceState)
            appendReport("super.onCreate done")
            // NOTE: setContentView needs super.onCreate first, so the
            // previous report is read above but can only be DISPLAYED here
            // — still before any normal startup work runs.
            if (previousReport != null && isCrashReport(previousReport)) {
                showPreviousCrashReport(previousReport, savedInstanceState)
                return
            }
            startNormal(savedInstanceState)
        } catch (t: Throwable) {
            showStartupFailure(t)
        }
    }

    private fun onCreateSafe(savedInstanceState: Bundle?) {
        setContentView(R.layout.activity_main)
        appendReport("setContentView done")
        store = SecureStore(this)
        appendReport("SecureStore created")

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
        appendReport("views bound")

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

    companion object {
        const val REPORT_FILE_NAME = "startup-report.txt"
    }
}
