package dev.summitflow.nightshift.update

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.security.advancedprotection.AdvancedProtectionManager
import android.util.Log
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import dev.summitflow.nightshift.BuildConfig
import dev.summitflow.nightshift.data.Store
import dev.summitflow.nightshift.data.UpdateState
import dev.summitflow.nightshift.net.ApiClient
import dev.summitflow.nightshift.net.ApiResult
import dev.summitflow.nightshift.push.Channels
import dev.summitflow.nightshift.push.Notifier
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import java.io.File
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Installs the next build from home, as Blackbox does: read home's update notice (device-signed), download the APK,
 * check its size and sha256 against the notice, then hand it to PackageInstaller as a silent self-update. Android
 * refuses a package signed with another key, so a bad file from home ends as a failed install, not a new app.
 *
 * Runs when the app opens (at most once an hour), once a day from WorkManager, and from Check for update.
 *
 * Advanced Protection (Android 16+) lets only Play, adb and preinstalled stores install, so it refuses this. A refused
 * build is remembered and not downloaded again on its own; such a phone gets its updates from the workstation over adb.
 */
object Updater {
    private const val TAG = "NsUpdate"
    private const val OPEN_CHECK_EVERY_SEC = 3600L
    private const val WORK = "update-daily"

    /** A confirmation screen Android handed over for [code]. Lives only in memory: an Intent can't go to disk. */
    data class Confirm(val code: Long, val intent: Intent)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val busy = AtomicBoolean(false)
    private val _checking = MutableStateFlow(false)
    val checking: StateFlow<Boolean> = _checking
    val confirm = MutableStateFlow<Confirm?>(null)
    @Volatile private var flow: MutableStateFlow<UpdateState>? = null

    fun state(ctx: Context): StateFlow<UpdateState> = flowFor(ctx)

    private fun flowFor(ctx: Context): MutableStateFlow<UpdateState> = flow ?: synchronized(this) {
        flow ?: MutableStateFlow(reconcile(ctx)).also { flow = it }
    }

    /**
     * First read in this process. A successful update kills the old process, often before its receiver hears
     * STATUS_SUCCESS; the running build then says whether the install it started went through.
     */
    private fun reconcile(ctx: Context): UpdateState {
        val store = Store.get(ctx)
        val u = store.update()
        val installed = BuildConfig.VERSION_CODE.toLong()
        val done = u.sessionId != -1 && u.installingCode in 1..installed
        val stalePending = u.pendingCode in 1..installed
        if (!done && !stalePending) return u
        val next = u.copy(
            // Our own install went through, so nothing is blocking them here any more.
            blockedCode = if (done) 0 else u.blockedCode, blockedDetail = if (done) "" else u.blockedDetail,
            result = if (done) "Installed ${BuildConfig.VERSION_NAME} (build $installed)." else u.result,
            detail = if (done) "" else u.detail,
            ok = if (done) true else u.ok,
            sessionId = if (done) -1 else u.sessionId, installingCode = if (done) 0 else u.installingCode,
            pendingCode = 0, pendingName = "",
        )
        store.saveUpdate(next)
        return next
    }

    /** Read, change and save the record in one step, and tell the screen. */
    @Synchronized
    internal fun edit(ctx: Context, f: (UpdateState) -> UpdateState): UpdateState {
        val store = Store.get(ctx)
        val next = f(store.update())
        store.saveUpdate(next)
        flowFor(ctx).value = next
        return next
    }

    private fun now() = System.currentTimeMillis() / 1000

    /** The daily check, network required. KEEP: scheduling again from every app start doesn't move it. */
    fun schedule(ctx: Context) {
        val req = PeriodicWorkRequestBuilder<UpdateWorker>(1, TimeUnit.DAYS)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.KEEP, req)
    }

    /** App opened: check unless a check ran within the hour. */
    fun checkOnOpen(ctx: Context) {
        if (now() - flowFor(ctx).value.checkedAt < OPEN_CHECK_EVERY_SEC) return
        checkNow(ctx)
    }

    /** Check in the background now (app open; [manual] for the owner's tap, which retries a refused build once). */
    fun checkNow(ctx: Context, manual: Boolean = false) {
        val app = ctx.applicationContext
        scope.launch { run(app, manual) }
    }

    /** What AdvancedProtectionManager says; null below API 36 or when it doesn't answer. Its permission is normal. */
    internal fun apOn(ctx: Context): Boolean? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.BAKLAVA) return null
        return try {
            ctx.getSystemService(AdvancedProtectionManager::class.java)?.isAdvancedProtectionEnabled
        } catch (e: Exception) {
            Log.w(TAG, "advanced protection query", e)
            null
        }
    }

    /** Advanced Protection refused build [code]: say so plainly, drop any pending confirm, and don't fetch it again. */
    internal fun recordApBlock(ctx: Context, code: Long, name: String, detail: String) {
        Notifier.cancel(ctx, listOf(NOTICE_TAG))
        confirm.value = null
        openWhenReady = false
        val installed = BuildConfig.VERSION_CODE.toLong()
        val o = UpdateRules.apOutcome(code, name, installed, detail)
        val before = edit(ctx) {
            it.copy(
                checkedAt = now(), result = o.text, detail = o.detail, ok = o.ok,
                pendingCode = 0, pendingName = "", sessionId = -1, installingCode = 0,
                blockedCode = maxOf(code, it.blockedCode), blockedDetail = detail,
            )
        }
        if (UpdateRules.shouldNotifyWaiting(code, installed, before.notifiedCode)) {
            Notifier.local(
                ctx, Channels.INFO, USB_TAG, UpdateRules.USB_TITLE, UpdateRules.usbWaiting(name),
                alarm = false, screen = Notifier.SCREEN_STATUS,
            )
            edit(ctx) { it.copy(notifiedCode = code) }
        }
    }

    /** Set by the owner's tap when the confirmation had to be fetched again: the receiver opens it when it comes. */
    @Volatile internal var openWhenReady = false

    /** The Status row's tap: Android's confirmation screen if this process still holds it, else fetch it again. */
    fun installPending(ctx: Context) {
        val c = confirm.value
        if (c != null && c.code == flowFor(ctx).value.pendingCode && openConfirm(ctx, c.intent)) return
        confirm.value = null
        openWhenReady = true
        checkNow(ctx, manual = true)
    }

    internal fun openConfirm(ctx: Context, intent: Intent): Boolean = try {
        ctx.startActivity(Intent(intent).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        true
    } catch (e: Exception) {
        Log.w(TAG, "confirm screen", e)
        false
    }

    /** Blocking. One check at a time; a second caller returns at once. Does nothing while unpaired. */
    fun run(ctx: Context, manual: Boolean = false) {
        val store = Store.get(ctx)
        val cfg = store.config() ?: return
        if (!busy.compareAndSet(false, true)) return
        _checking.value = true
        try {
            val outcome = check(ctx, ApiClient(cfg), manual)
            if (outcome != null) {
                openWhenReady = false
                record(ctx, outcome)
            }
        } catch (e: Exception) {
            Log.w(TAG, "check", e)
            openWhenReady = false
            record(ctx, UpdateRules.checkCrashed(e))
        } finally {
            _checking.value = false
            busy.set(false)
        }
    }

    private fun record(ctx: Context, o: Outcome) =
        edit(ctx) { it.copy(checkedAt = now(), result = o.text, detail = o.detail, ok = o.ok) }

    /** What the check found; null when the install path already recorded it. */
    private fun check(ctx: Context, api: ApiClient, manual: Boolean): Outcome? {
        val m = when (val r = api.get("/api/app/update")) {
            is ApiResult.Err -> return UpdateRules.checkFailed(r.code, r.message, r.message == ApiClient.SIGN_FAILED)
            is ApiResult.Ok -> try { UpdateRules.parse(r.json) } catch (e: BadManifest) {
                return UpdateRules.badNotice(e.message ?: "")
            }
        }
        val installed = BuildConfig.VERSION_CODE.toLong()
        val u = flowFor(ctx).value
        if (!UpdateRules.shouldUpdate(m, installed)) {
            edit(ctx) { if (it.pendingCode <= BuildConfig.VERSION_CODE) it.copy(pendingCode = 0, pendingName = "") else it }
            Notifier.cancel(ctx, listOf(USB_TAG))
            if (u.blockedCode > 0) return UpdateRules.apOutcome(m.versionCode, m.versionName, installed, u.blockedDetail)
            return Outcome(UpdateRules.UP_TO_DATE, "", true)
        }
        // Advanced Protection refused this build already: only the manifest is read until a newer one or a tap.
        if (!UpdateRules.shouldDownload(m, installed, u.blockedCode, manual)) {
            return UpdateRules.apOutcome(m.versionCode, m.versionName, installed, u.blockedDetail)
        }
        // Already waiting on the owner's tap for this build: don't start another session.
        if (confirm.value?.code == m.versionCode && flowFor(ctx).value.pendingCode == m.versionCode) {
            return waiting(m.versionName, m.versionCode)
        }

        val dir = File(ctx.cacheDir, "updates").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() }
        val apk = File(dir, "nightshift-${m.versionCode}.apk")
        try {
            api.download(m.download, apk, m.size)?.let {
                return UpdateRules.downloadFailed(it.code, it.message, it.message == ApiClient.SIGN_FAILED, it.code == ApiClient.TOO_BIG)
            }
            UpdateRules.verify(apk, m)?.let { return UpdateRules.mismatch(it) }
            install(ctx, apk, m)
            return null
        } finally {
            apk.delete()
        }
    }

    private fun install(ctx: Context, apk: File, m: UpdateManifest) {
        val installer = ctx.packageManager.packageInstaller
        // An older session of ours (a confirmation never tapped) would only compete with this one.
        for (s in installer.mySessions) try { installer.abandonSession(s.sessionId) } catch (_: Exception) { }

        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(ctx.packageName)
            setSize(apk.length())
            setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                setPackageSource(PackageInstaller.PACKAGE_SOURCE_LOCAL_FILE)
            }
        }
        val id = installer.createSession(params)
        try {
            edit(ctx) {
                it.copy(
                    checkedAt = now(), result = "Installing ${m.versionName} (build ${m.versionCode})…", detail = "", ok = true,
                    sessionId = id, installingCode = m.versionCode,
                )
            }
            installer.openSession(id).use { session ->
                session.openWrite("nightshift", 0, apk.length()).use { out ->
                    apk.inputStream().use { it.copyTo(out) }
                    session.fsync(out)
                }
                val intent = Intent(ctx, UpdateInstallReceiver::class.java)
                    .putExtra(UpdateInstallReceiver.EXTRA_CODE, m.versionCode)
                    .putExtra(UpdateInstallReceiver.EXTRA_NAME, m.versionName)
                // Mutable: the installer fills in the status, message and confirmation intent.
                val pending = PendingIntent.getBroadcast(ctx, id, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
                session.commit(pending.intentSender)
            }
        } catch (e: Exception) {
            try { installer.abandonSession(id) } catch (_: Exception) { }
            openWhenReady = false
            val ap = apOn(ctx)
            if (UpdateRules.isApBlock(null, "${e.javaClass.simpleName}: ${e.message}", e is SecurityException, ap)) {
                recordApBlock(ctx, m.versionCode, m.versionName, UpdateRules.apDetail(null, null, e, ap))
                return
            }
            val o = UpdateRules.startFailed(e)
            edit(ctx) { it.copy(checkedAt = now(), result = o.text, detail = o.detail, ok = false, sessionId = -1, installingCode = 0) }
        }
    }

    internal fun waiting(name: String, code: Long) = Outcome(UpdateRules.WAITING, "$name (build $code)", true)

    private const val NOTICE_TAG = "update"
    /** The Advanced Protection phone's "Update waiting" notice: up until the installed build reaches it. */
    private const val USB_TAG = "update-usb"

    /**
     * App start: take down an "update ready" notification nothing backs any more (its build is installed or was never
     * going to install), so one left from an older build goes away. A real pending update keeps its notice.
     */
    fun clearStaleNotice(ctx: Context) {
        val u = flowFor(ctx).value
        if (u.pendingCode <= BuildConfig.VERSION_CODE || u.blockedCode > 0 || apOn(ctx) == true) {
            Notifier.cancel(ctx, listOf(NOTICE_TAG))
        }
        if (u.blockedCode <= BuildConfig.VERSION_CODE) Notifier.cancel(ctx, listOf(USB_TAG))
    }

    /** Shown once per version, on the silent Info channel. Never while Advanced Protection blocks updates. */
    internal fun notifyReady(ctx: Context, name: String) {
        Notifier.local(
            ctx, Channels.INFO, NOTICE_TAG, "Update ready: tap to install",
            "Version $name is ready. Tap to open Status, then tap Install.",
            alarm = false, screen = Notifier.SCREEN_STATUS,
        )
    }
}

/** Where PackageInstaller reports how the install went. Only the session the updater started counts. */
class UpdateInstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val ctx = context.applicationContext
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, Int.MIN_VALUE)
        val session = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1)
        val code = intent.getLongExtra(EXTRA_CODE, 0)
        val name = intent.getStringExtra(EXTRA_NAME) ?: "?"
        val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
        if (session != Store.get(ctx).update().sessionId) {
            Log.i(TAG, "old session $session: status $status")
            return
        }
        when (status) {
            PackageInstaller.STATUS_SUCCESS -> Updater.edit(ctx) {
                it.copy(
                    result = "Installed $name (build $code).", detail = "", ok = true, pendingCode = 0, pendingName = "", sessionId = -1,
                    installingCode = 0, blockedCode = 0, blockedDetail = "",
                )
            }
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                // With Advanced Protection on, Android's confirm can only refuse: don't ask the owner for it.
                val ap = Updater.apOn(ctx)
                if (UpdateRules.isApBlock(status, message, false, ap)) {
                    try { ctx.packageManager.packageInstaller.abandonSession(session) } catch (_: Exception) { }
                    Updater.recordApBlock(ctx, code, name, UpdateRules.apDetail(status, message, null, ap))
                    return
                }
                val confirm = confirmIntent(intent)
                if (confirm != null) Updater.confirm.value = Updater.Confirm(code, confirm)
                if (confirm != null && Updater.openWhenReady) {
                    Updater.openWhenReady = false
                    Updater.openConfirm(ctx, confirm)
                }
                val w = Updater.waiting(name, code)
                val before = Updater.edit(ctx) {
                    it.copy(result = w.text, detail = w.detail, ok = true, pendingCode = code, pendingName = name)
                }
                // A build Advanced Protection refused before (a manual retry) gets no "ready" notification.
                if (before.notifiedCode != code && code > before.blockedCode) {
                    Updater.notifyReady(ctx, name)
                    Updater.edit(ctx) { it.copy(notifiedCode = code) }
                }
            }
            else -> {
                Log.w(TAG, "status $status $message")
                val ap = Updater.apOn(ctx)
                if (UpdateRules.isApBlock(status, message, false, ap)) {
                    Updater.recordApBlock(ctx, code, name, UpdateRules.apDetail(status, message, null, ap))
                    return
                }
                Updater.confirm.value = null
                Updater.openWhenReady = false
                val o = UpdateRules.installFailed(status, message)
                Updater.edit(ctx) {
                    it.copy(
                        result = o.text, detail = o.detail, ok = false,
                        pendingCode = 0, pendingName = "", sessionId = -1, installingCode = 0,
                    )
                }
            }
        }
    }

    /** The typed getParcelableExtra is API 33; minSdk is 31. */
    @Suppress("DEPRECATION")
    private fun confirmIntent(intent: Intent): Intent? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
        else intent.getParcelableExtra(Intent.EXTRA_INTENT)

    companion object {
        private const val TAG = "NsUpdate"
        const val EXTRA_CODE = "update_code"
        const val EXTRA_NAME = "update_name"
    }
}

/** The daily check. Always success: a failed check is on the Status screen, and tomorrow's run tries again. */
class UpdateWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
    override fun doWork(): Result {
        Updater.run(applicationContext)
        return Result.success()
    }
}
