package dev.summitflow.nightshift.net

import android.content.Context
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import dev.summitflow.nightshift.DeviceState
import dev.summitflow.nightshift.data.Store
import dev.summitflow.nightshift.push.Fcm
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.concurrent.TimeUnit

/**
 * Sends what is waiting: the FCM token, then acks with the device state. Always from WorkManager, never on the
 * thread FCM delivers on; retried with backoff when home or the network is away.
 */
object Sync {
    private const val TAG = "NsSync"
    private const val BATCH = 40

    /** Blocking, workers only. True when nothing is left to retry (done, or waiting on a re-pair). */
    @Synchronized
    fun run(ctx: Context): Boolean {
        val store = Store.get(ctx)
        val cfg = store.config() ?: return true
        val api = ApiClient(cfg)

        if (cfg.tokenPending && cfg.fcmToken != null) {
            when (val r = api.post("/api/app/token", buildJsonObject { put("fcm_token", cfg.fcmToken) })) {
                is ApiResult.Ok -> store.updateConfig { it.copy(tokenPending = false) }
                is ApiResult.Err -> { Log.w(TAG, "token: ${r.code}"); return !retryable(r.code) }
            }
        }

        while (true) {
            val acks = store.pendingAcks().take(BATCH)
            if (acks.isEmpty()) return true
            val body = buildJsonObject {
                put("acks", JsonArray(acks.map { it.toJson() }))
                put("state", DeviceState.read(ctx).toJson())
            }
            when (val r = api.post("/api/app/ack", body)) {
                is ApiResult.Ok -> store.dropAcks(acks)
                is ApiResult.Err -> {
                    Log.w(TAG, "ack: ${r.code}")
                    if (r.code == 400) { store.dropAcks(acks); continue } // the server can't take it; retrying won't help
                    return !retryable(r.code)
                }
            }
        }
    }

    private fun retryable(code: Int) = code == 0 || code == 408 || code == 429 || code >= 500

    /** Blocking, workers only. Learn the current token and tell home (covers a token that rotated while we were dead). */
    fun announceToken(ctx: Context): Boolean {
        val store = Store.get(ctx)
        val cfg = store.config() ?: return true
        if (!Fcm.init(ctx, cfg.fcm)) return true
        val token = Fcm.token() ?: cfg.fcmToken
        store.updateConfig { it.copy(fcmToken = token, tokenPending = token != null) }
        return run(ctx)
    }

    private val online = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    /**
     * Send acks soon: expedited (falls back to normal work when the quota is spent). APPEND_OR_REPLACE so an ack
     * queued while a send runs gets its own pass after it instead of being dropped as a duplicate.
     */
    fun enqueue(ctx: Context) {
        val req = OneTimeWorkRequestBuilder<SyncWorker>()
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .setConstraints(online)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(ctx).enqueueUniqueWork("sync", ExistingWorkPolicy.APPEND_OR_REPLACE, req)
    }

    /** App start. Not expedited: every process start (FCM wakes included) runs this, and acks need the quota more. */
    fun enqueueAnnounce(ctx: Context) {
        val req = OneTimeWorkRequestBuilder<AnnounceWorker>()
            .setConstraints(online)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(ctx).enqueueUniqueWork("announce", ExistingWorkPolicy.KEEP, req)
    }
}

// Plain Workers: expedited work only asks for getForegroundInfo below API 31 (WorkManager 2.11 checks SDK_INT),
// and minSdk is 31, so the default that throws is never reached.
class SyncWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
    override fun doWork(): Result = if (Sync.run(applicationContext)) Result.success() else Result.retry()
}

class AnnounceWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
    override fun doWork(): Result = if (Sync.announceToken(applicationContext)) Result.success() else Result.retry()
}
